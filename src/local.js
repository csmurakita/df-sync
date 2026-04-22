import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import ignore from 'ignore'

const ALWAYS_EXCLUDE = [
  '.git',
  'node_modules',
  '.df-credentials.json',
]

export async function enumerateLocal(root) {
  const filter = await buildIgnoreFilter(root)
  const files = new Map()
  const dirs = []
  await walk(root, '', filter, files, dirs)
  return { files, dirs }
}

export async function buildIgnorePredicate(root) {
  const filter = await buildIgnoreFilter(root)
  return (path, isDir) => filter.ignores(isDir ? `${path}/` : path)
}

export function localSide(root) {
  return {
    supportsRecursiveDirDelete: false,
    async list() {
      return enumerateLocal(root)
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
      // local 側では ignored ファイルを巻き込むリスクがあるため再帰削除は提供しない。
      // sync.js 側が supportsRecursiveDirDelete=false を見て呼ばないので呼ばれない想定。
      throw new Error('local destination に対するディレクトリ再帰削除はサポートされません')
    },
  }
}

async function buildIgnoreFilter(root) {
  const ig = ignore().add(ALWAYS_EXCLUDE)
  const gitignore = await tryReadText(join(root, '.gitignore'))
  if (gitignore !== null) ig.add(gitignore)
  return ig
}

async function tryReadText(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

async function walk(root, rel, filter, files, dirs) {
  const absDir = rel ? join(root, rel) : root
  const entries = await readdir(absDir, { withFileTypes: true })
  for (const entry of entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name
    const matchPath = entry.isDirectory() ? `${childRel}/` : childRel
    if (filter.ignores(matchPath)) continue

    if (entry.isDirectory()) {
      dirs.push(childRel)
      await walk(root, childRel, filter, files, dirs)
    } else if (entry.isFile()) {
      const info = await stat(join(absDir, entry.name))
      files.set(childRel, { sizeBytes: info.size })
    }
    // symlink, socket, etc. は同期対象外
  }
}
