import { Buffer } from 'node:buffer'
import { GoogleAuth } from 'google-auth-library'
import { filterAlwaysExcluded } from './exclude.js'

const API_ROOT = 'https://dataform.googleapis.com/v1'

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

  async makeDirectory(path) {
    return this.#post(':makeDirectory', { path })
  }

  async listAll() {
    const files = new Map()
    const dirs = []
    const pending = ['']
    while (pending.length > 0) {
      const dir = pending.shift()
      for await (const entry of this.#iterateDirectory(dir)) {
        if (typeof entry.file === 'string') {
          const raw = entry.metadata?.sizeBytes
          const sizeBytes = raw == null ? null : Number(raw)
          files.set(entry.file, { sizeBytes })
        } else if (typeof entry.directory === 'string') {
          dirs.push(entry.directory)
          pending.push(entry.directory)
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
    const token = await this.#accessToken()
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`${method} ${url} -> ${res.status}: ${text}`)
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

// shouldSkipDelete: --mirror 削除時にスキップ判定する述語
// (呼び出し側はローカルの完全 ignore を渡すことで、remote 側の
// ローカル除外対象パスの削除を防げる)。
export function remoteSide(client, { shouldSkipDelete = null } = {}) {
  return {
    supportsRecursiveDirDelete: true,
    shouldSkipDelete,
    async list() {
      return filterAlwaysExcluded(await client.listAll())
    },
    async read(relPath) {
      return client.readFile(relPath)
    },
    async write(relPath, bytes) {
      return client.writeFile(relPath, bytes)
    },
    async removeFile(relPath) {
      return client.removeFile(relPath)
    },
    async removeDirectory(relPath) {
      return client.removeDirectory(relPath)
    },
  }
}
