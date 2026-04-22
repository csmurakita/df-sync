import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { filterAlwaysExcluded } from './exclude.js'
import { enumerateLocal } from './local.js'

// 方向別の source / destination 構成:
//  upload   : source=local (full ignore で列挙),   destination=remote (mirror 削除時のみ local ignore で保護)
//  download : source=remote (ALWAYS_EXCLUDE のみ), destination=local  (ALWAYS_EXCLUDE のみで列挙し remote 内容を忠実に反映、mirror 削除時は local ignore で保護)
export function createSides(direction, { localDir, client, fullIgnore }) {
  if (direction === 'upload') {
    return {
      source: localSide(localDir, { listFilter: fullIgnore }),
      destination: remoteSide(client, { shouldSkipDelete: fullIgnore }),
    }
  }
  return {
    source: remoteSide(client),
    destination: localSide(localDir, { shouldSkipDelete: fullIgnore }),
  }
}

// listFilter   : list() に適用する ignore 述語。null なら walk の ALWAYS_EXCLUDE のみ。
// shouldSkipDelete: --mirror 削除時にスキップ判定する述語（完全な local ignore を想定）。
/** @returns {import('./sync.js').Side} */
export function localSide(root, { listFilter = null, shouldSkipDelete = null } = {}) {
  return {
    supportsRecursiveDirDelete: false,
    shouldSkipDelete,
    async list() {
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

// shouldSkipDelete: --mirror 削除時にスキップ判定する述語
// (呼び出し側はローカルの完全 ignore を渡すことで、remote 側の
// ローカル除外対象パスの削除を防げる)。
/** @returns {import('./sync.js').Side} */
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
