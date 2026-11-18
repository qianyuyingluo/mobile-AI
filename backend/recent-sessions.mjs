import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, normalize, toNamespacedPath } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { zstdDecompressSync } from 'node:zlib'

const isWindows = process.platform === 'win32'
const limit = 12
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u
const pathKey = path => {
  const key = normalize(path)
  return isWindows ? key.toLowerCase() : key
}
const entries = directory => readdir(directory, { withFileTypes: true }).catch(() => [])
const projectFolder = project => {
  const slug = project.replace(/[/:\\]+/gu, '-').replace(/[^A-Za-z0-9._-]/g,
    character => '~' + character.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'))
    .replace(/^-+/u, '') || 'root'
  return '--' + slug.slice(0, 251) + '--'
}

async function codexRecent(project, home) {
  const databases = (await entries(home)).filter(item => item.isFile() && /^state_\d+\.sqlite$/u.test(item.name))
    .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))
  for (const { name } of databases) {
    let db
    try {
      db = new DatabaseSync(join(home, name), { readOnly: true })
      const options = isWindows ? 'COLLATE NOCASE' : ''
      return db.prepare(`SELECT id, title, updated_at FROM threads
        WHERE cwd ${options} IN (?, ?) AND archived = 0 ORDER BY updated_at DESC LIMIT ?`)
        .all(project, toNamespacedPath(project), limit).map(row => ({ agent: 'codex', id: row.id, title: row.title || 'Codex · ' + row.id.slice(-8),
          updatedAt: row.updated_at * 1000 }))
    } catch {
      // The desktop may be upgrading the index or using a different schema.
    } finally { db?.close() }
  }
  return []
}

async function harnessPrefix(file) {
  const source = await open(file)
  try {
    const { buffer, bytesRead } = await source.read(Buffer.alloc(128 * 1024))
    const bytes = buffer.subarray(0, bytesRead)
    if (!file.endsWith('.zstd')) return bytes.toString('utf8')
    let offset = 0
    const chunks = []
    // Harness appends independent Zstandard frames. Node decodes one at a time.
    while (offset < bytes.length && chunks.length < 32) {
      try {
        const { buffer: decoded, engine } = zstdDecompressSync(bytes.subarray(offset), {
          info: true, maxOutputLength: 256 * 1024,
        })
        if (!engine.bytesWritten) break
        chunks.push(decoded)
        offset += engine.bytesWritten
      } catch {
        break
      }
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally { await source.close() }
}

async function harnessMetadata(file, project) {
  try {
    const [first, ...lines] = (await harnessPrefix(file)).split('\n').slice(0, -1)
    const header = JSON.parse(first)
    if (header.type !== 'session' || !idPattern.test(header.id ?? '') ||
      typeof header.cwd !== 'string' || pathKey(header.cwd) !== pathKey(project) ||
      header.delegationDepth > 0 || header.origin === 'subagent') return null
    let title
    let canResume = !header.agentPreset
    for (const line of lines) {
      if (!line.includes('session/title') && !line.includes('agent-preset/selected')) continue
      const event = JSON.parse(line)
      if (event.type === 'session/title' && typeof event.data?.title === 'string') title = event.data.title
      if (event.type === 'agent-preset/selected') canResume = false
    }
    return { id: header.id, title: title?.trim() || 'Harness · ' + header.id.slice(-8), canResume }
  } catch {
    return null
  }
}

async function harnessRecent(project, home) {
  const folder = join(home, 'sessions', projectFolder(project))
  const candidates = []
  for (const session of await entries(folder)) {
    if (!session.isDirectory()) continue
    const directory = join(folder, session.name)
    const generations = (await entries(directory)).filter(file => file.isFile() && /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/u.test(file.name))
      .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))
    if (!generations.length) continue
    const file = join(directory, generations[0].name)
    const info = await stat(file).catch(() => null)
    if (info) candidates.push({ file, updatedAt: info.mtimeMs })
  }
  candidates.sort((a, b) => b.updatedAt - a.updatedAt)
  const results = []
  for (const { file, updatedAt } of candidates) {
    const row = await harnessMetadata(file, project)
    if (row) results.push({ ...row, updatedAt, agent: 'deepseek', home })
    if (results.length === limit) break
  }
  return results
}

export async function recentAgentSessions(project, env, available) {
  const harnessHomes = env.DSH_HOME ? [env.DSH_HOME] : [
    join(homedir(), '.dsh'),
    ...(isWindows && env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, 'YingluoHarness')] : []),
  ]
  const records = await Promise.all([
    available.codex.available ? codexRecent(project, env.CODEX_HOME || join(homedir(), '.codex')) : [],
    ...harnessHomes.map(home => available.deepseek.available ? harnessRecent(project, home) : []),
  ])
  const sorted = records.flat().filter(row => idPattern.test(row.id ?? '')).sort((a, b) => b.updatedAt - a.updatedAt)
  const seen = new Set()
  return sorted.filter(row => {
    const key = row.agent + ':' + row.id
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
