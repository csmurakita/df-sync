import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { matchesAlwaysExclude } from './exclude.js'
import { enumerateLocal } from './local.js'

// 方向別の source / destination 構成:
//  upload   : source=local (full ignore で列挙), destination=remote (フィルタ・削除保護なし: local に無いものはすべて削除候補)
//  download : source=remote (フィルタなし、remote が返したものを忠実にローカルへ反映), destination=local (ALWAYS_EXCLUDE のみで列挙、mirror 削除時のみ local ignore で保護)
export function createSides(direction, { localDir, client, fullIgnore }) {
  if (direction === 'upload') {
    return {
      source: localSide(localDir, { listFilter: fullIgnore }),
      destination: remoteSide(client),
    }
  }
  return {
    source: remoteSide(client),
    destination: localSide(localDir, { shouldSkipDelete: fullIgnore }),
  }
}

// listFilter      : list() に適用する ignore 述語。null なら walk の ALWAYS_EXCLUDE のみ。
// shouldSkipDelete: --mirror 削除時にスキップ判定する述語（完全な local ignore を想定）。
// shouldSkipWrite : ALWAYS_EXCLUDE (.git / node_modules / .df-credentials.json) を local 書き込みから常に弾く。
/** @returns {import('./sync.js').Side} */
export function localSide(root, { listFilter = null, shouldSkipDelete = null } = {}) {
  return {
    supportsRecursiveDirDelete: false,
    shouldSkipDelete,
    shouldSkipWrite: matchesAlwaysExclude,
    // options.shouldSkipDescent は受けるが使わない: local 列挙は安価で、enumerateLocal が ALWAYS_EXCLUDE を walk 時に枝刈りしている
    async list(_options) {
      return enumerateLocal(root, listFilter)
    },
    async read(relPath) {
      return readFile(join(root, relPath))
    },
    async write(relPath, bytes) {
      const abs = join(root, relPath)
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, bytes)
    },
    async removeFile(relPath) {
      await unlink(join(root, relPath))
    },
    async removeDirectory() {
      throw new Error('local destination に対するディレクトリ再帰削除はサポートされません')
    },
  }
}

/** @returns {import('./sync.js').Side} */
export function remoteSide(client) {
  return {
    supportsRecursiveDirDelete: true,
    shouldSkipDelete: null,
    shouldSkipWrite: null,
    async list(options) {
      return client.listAll(options)
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
