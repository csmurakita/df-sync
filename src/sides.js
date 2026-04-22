import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { matchesAlwaysExclude } from './exclude.js'
import { enumerateLocal } from './local.js'

// upload   は source=local / destination=remote、download はその逆。
// 各方向での fullIgnore の適用位置 (listFilter / shouldSkipDelete) は下の return で対称に表現している。
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

/**
 * @param {string} root
 * @param {Object} [opts]
 * @param {import('./gitignore.js').IgnorePredicate | null} [opts.listFilter] - list() に適用する ignore 述語。null なら walk の ALWAYS_EXCLUDE のみ。
 * @param {import('./gitignore.js').IgnorePredicate | null} [opts.shouldSkipDelete] - --mirror 削除時にスキップ判定する述語 (完全な local ignore を想定)。
 * @returns {import('./sync.js').Side}
 *
 * shouldSkipWrite は固定で matchesAlwaysExclude。
 * ALWAYS_EXCLUDE (.git / node_modules / .df-credentials.json) を local 書き込みから常に弾く。
 */
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
