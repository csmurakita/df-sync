import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isAlwaysExcludedName } from './exclude.js'

export async function enumerateLocal(root, isIgnored) {
  const files = new Map()
  const dirs = []
  await walk(root, '', isIgnored, files, dirs)
  return { files, dirs }
}

// listFilter   : list() に適用する ignore 述語。null なら walk の ALWAYS_EXCLUDE のみ。
// shouldSkipDelete: --mirror 削除時にスキップ判定する述語（完全な local ignore を想定）。
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

// ディレクトリ直下のエントリ (isIgnored 判定 / stat / 子 walk) は Promise.all で並列に回す。
// git check-ignore 子プロセスは FIFO で同時リクエストを捌けるため安全。
async function walk(root, rel, isIgnored, files, dirs) {
  const absDir = rel ? join(root, rel) : root
  const entries = await readdir(absDir, { withFileTypes: true })
  await Promise.all(
    entries.map(async (entry) => {
      if (isAlwaysExcludedName(entry.name)) return
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      const isDir = entry.isDirectory()
      if (isIgnored && (await isIgnored(childRel, isDir))) return

      if (isDir) {
        dirs.push(childRel)
        await walk(root, childRel, isIgnored, files, dirs)
      } else if (entry.isFile()) {
        const info = await stat(join(absDir, entry.name))
        files.set(childRel, { sizeBytes: info.size })
      }
      // symlink, socket, etc. は同期対象外
    }),
  )
}
