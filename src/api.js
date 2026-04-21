import { Buffer } from 'node:buffer'
import { GoogleAuth } from 'google-auth-library'

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
    const files = []
    const dirs = []
    const pending = ['']
    while (pending.length > 0) {
      const dir = pending.shift()
      for await (const entry of this.#iterateDirectory(dir)) {
        if (typeof entry.file === 'string') {
          files.push(entry.file)
        } else if (typeof entry.directory === 'string') {
          dirs.push(entry.directory)
          pending.push(entry.directory)
        }
      }
    }
    return { files, dirs }
  }

  async *#iterateDirectory(dir) {
    let pageToken
    do {
      const url = new URL(`${this.workspaceUrl}:queryDirectoryContents`)
      if (dir) url.searchParams.set('path', dir)
      url.searchParams.set('pageSize', '1000')
      if (pageToken) url.searchParams.set('pageToken', pageToken)
      const res = await this.#request('GET', url.toString())
      for (const entry of res.directoryEntries ?? []) yield entry
      pageToken = res.nextPageToken
    } while (pageToken)
  }

  async #post(operation, body) {
    return this.#request('POST', `${this.workspaceUrl}${operation}`, body)
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
