import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import ignore from 'ignore'

const ALWAYS_EXCLUDE = [
  '.git',
  'node_modules',
  '.df-credentials.json',
]

export async function enumerateLocal(root) {
  const filter = await buildIgnoreFilter(root)
  const out = []
  await walk(root, '', filter, out)
  return out
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

async function walk(root, rel, filter, out) {
  const absDir = rel ? join(root, rel) : root
  const entries = await readdir(absDir, { withFileTypes: true })
  for (const entry of entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name
    const matchPath = entry.isDirectory() ? `${childRel}/` : childRel
    if (filter.ignores(matchPath)) continue

    if (entry.isDirectory()) {
      await walk(root, childRel, filter, out)
    } else if (entry.isFile()) {
      out.push({ relPath: childRel, absPath: join(absDir, entry.name) })
    }
    // symlink, socket, etc. は同期対象外
  }
}
