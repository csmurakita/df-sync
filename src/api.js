import { Buffer } from 'node:buffer'
import { setTimeout as delay } from 'node:timers/promises'
import { GoogleAuth } from 'google-auth-library'

const API_ROOT = 'https://dataform.googleapis.com/v1'

// per-request タイムアウト。Dataform API はワークスペース変更系で稀に長く掛かるが、
// ハングを防ぐため 60s で打ち切る。
const REQUEST_TIMEOUT_MS = 60_000
// 5xx / 429 / ネットワークエラーのみ指数バックオフでリトライする。
// 書き込み系 (writeFile / removeFile / removeDirectory) は idempotent。
const MAX_RETRIES = 3
const BACKOFF_BASE_MS = 500

export class DataformClient {
  constructor({ project, location, repository, workspace }) {
    this.workspaceUrl = `${API_ROOT}/projects/${project}/locations/${location}/repositories/${repository}/workspaces/${workspace}`
    this.auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    })
  }

  async writeFile(path, contents) {
    const buffer = Buffer.isBuffer(contents) ? contents : Buffer.from(contents)
    return this.#post(':writeFile', { path, contents: buffer.toString('base64') })
  }

  async removeFile(path) {
    return this.#post(':removeFile', { path })
  }

  async removeDirectory(path) {
    return this.#post(':removeDirectory', { path })
  }

  // shouldSkipDescent(dirPath) が true を返したディレクトリには再帰しない (dir 自体は dirs に残す)。
  // 削除予定や書き込み拒否の dir 配下を列挙しないことで、巨大ツリー (例: node_modules) の API コストを回避する。
  async listAll({ shouldSkipDescent = null } = {}) {
    const files = new Map()
    const dirs = []
    // 探索順は問わないため pop で O(n) スタック動作にする (shift は O(n²))。
    const pending = ['']
    while (pending.length > 0) {
      const dir = pending.pop()
      for await (const entry of this.#iterateDirectory(dir)) {
        if (typeof entry.file === 'string') {
          // sizeBytes は string / number / undefined いずれでも返り得る。
          // 空文字や非数値は null に倒す (Number("") === 0 で本物の 0 バイトと衝突するのを防ぐ)。
          const raw = entry.metadata?.sizeBytes
          const num = raw == null || raw === '' ? NaN : Number(raw)
          const sizeBytes = Number.isFinite(num) ? num : null
          files.set(entry.file, { sizeBytes })
        } else if (typeof entry.directory === 'string') {
          dirs.push(entry.directory)
          if (!shouldSkipDescent || !shouldSkipDescent(entry.directory)) {
            pending.push(entry.directory)
          }
        }
      }
    }
    return { files, dirs }
  }

  async readFile(path) {
    const res = await this.#request('GET', this.#url(':readFile', { path }))
    return Buffer.from(res.fileContents ?? '', 'base64')
  }

  async *#iterateDirectory(dir) {
    let pageToken
    do {
      const url = this.#url(':queryDirectoryContents', {
        path: dir || undefined,
        pageSize: '1000',
        view: 'DIRECTORY_CONTENTS_VIEW_METADATA',
        pageToken,
      })
      const res = await this.#request('GET', url)
      for (const entry of res.directoryEntries ?? []) yield entry
      pageToken = res.nextPageToken
    } while (pageToken)
  }

  #url(suffix, params) {
    const url = new URL(`${this.workspaceUrl}${suffix}`)
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, v)
      }
    }
    return url.toString()
  }

  async #post(operation, body) {
    return this.#request('POST', this.#url(operation), body)
  }

  async #request(method, url, body) {
    let attempt = 0
    while (true) {
      try {
        return await this.#fetchOnce(method, url, body)
      } catch (err) {
        if (attempt >= MAX_RETRIES || !isRetriable(err)) throw err
        const wait = retryDelayMs(err, attempt)
        attempt++
        await delay(wait)
      }
    }
  }

  async #fetchOnce(method, url, body) {
    const token = await this.#accessToken()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    let res
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (err) {
      // タイムアウト由来の AbortError は識別しやすいエラーに包んで上に伝播させる。
      if (err?.name === 'AbortError') {
        throw new HttpRequestError(`${method} ${url} -> timeout (${REQUEST_TIMEOUT_MS}ms)`, {
          retriable: true,
        })
      }
      throw new HttpRequestError(`${method} ${url} -> network error: ${err.message}`, {
        cause: err,
        retriable: true,
      })
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new HttpRequestError(`${method} ${url} -> ${res.status}: ${text}`, {
        status: res.status,
        retryAfter: parseRetryAfter(res.headers.get('retry-after')),
        retriable: res.status >= 500 || res.status === 429,
      })
    }
    if (res.status === 204) return {}
    const contentType = res.headers.get('content-type') ?? ''
    return contentType.includes('application/json') ? res.json() : {}
  }

  async #accessToken() {
    const client = await this.auth.getClient()
    const { token } = await client.getAccessToken()
    if (!token) throw new Error('アクセストークンを取得できませんでした (ADC を確認してください)')
    return token
  }
}

class HttpRequestError extends Error {
  constructor(message, { status = null, retryAfter = null, retriable = false, cause } = {}) {
    super(message)
    this.name = 'HttpRequestError'
    this.status = status
    this.retryAfter = retryAfter
    this.retriable = retriable
    if (cause) this.cause = cause
  }
}

function isRetriable(err) {
  return err instanceof HttpRequestError && err.retriable
}

function retryDelayMs(err, attempt) {
  const fromHeader = err instanceof HttpRequestError ? err.retryAfter : null
  if (fromHeader != null) return fromHeader
  // 指数バックオフ + jitter。最小待機を BACKOFF_BASE_MS / 2 で下限クランプし、
  // 5xx/429 のリトライが実質 0ms でサーバを追撃しないようにする。
  const exp = BACKOFF_BASE_MS * 2 ** attempt
  const floor = BACKOFF_BASE_MS / 2
  return Math.floor(floor + Math.random() * (exp - floor))
}

function parseRetryAfter(value) {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const dateMs = Date.parse(value)
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now())
  return null
}
