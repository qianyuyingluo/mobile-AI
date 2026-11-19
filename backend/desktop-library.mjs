import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, normalize, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'
import { zstdDecompressSync } from 'node:zlib'
import { harnessCandidates, harnessMetadata } from './recent-sessions.mjs'
import { contentFiles, deliveredFiles } from './desktop-files.mjs'

const readJson = async file => {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch { return {} }
}
const pathKey = value => process.platform === 'win32'
  ? normalize(value).replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/u, '').toLowerCase() : normalize(value)
const dirs = path => readdir(path, { withFileTypes: true }).catch(() => [])

function catalog(agent) {
  const groups = new Map()
  const entries = new Map()
  function group(id, name) {
    if (!groups.has(id)) groups.set(id, { id: createHash('sha256').update(id).digest('hex').slice(0, 24),
      agent, name: name || '未分组', sessions: [] })
    return groups.get(id)
  }
  function add(row, parent) {
    if (!row.id || entries.has(row.id)) return
    entries.set(row.id, { ...row, agent })
    parent.sessions.push({ id: row.id, title: String(row.title || row.id).slice(0, 120), updatedAt: row.updatedAt })
  }
  return { group, add, groups, entries }
}

async function codexLibrary(home) {
  const result = catalog('codex')
  const state = await readJson(join(home, '.codex-global-state.json'))
  const legacy = state['local-projects'] ?? {}
  const assignments = state['thread-project-assignments'] ?? {}
  const noProject = new Set(state['projectless-thread-ids'] ?? [])
  const byPath = new Map()
  const byId = new Map()
  const files = await dirs(home)
  const historyDb = files.filter(f => /^thread_history_\d+\.sqlite$/u.test(f.name))
    .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))[0]
  const databases = files.filter(f => /^state_\d+\.sqlite$/u.test(f.name))
    .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))
  for (const item of databases) {
    let db
    try {
      db = new DatabaseSync(join(home, item.name), { readOnly: true })
      const columns = new Set(db.prepare('pragma table_info(threads)').all().map(row => row.name))
      if (!columns.has('rollout_path')) continue
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name)
      if (tables.includes('projects') && tables.includes('project_roots')) {
        for (const p of db.prepare('SELECT p.id, p.name, r.path FROM projects p LEFT JOIN project_roots r ON p.id=r.project_id ORDER BY p.position').all()) {
          const group = result.group(p.id, p.name || (p.path && basename(p.path)))
          byId.set(p.id, group)
          if (p.path) byPath.set(pathKey(p.path), group)
        }
      }
      for (const p of Object.values(legacy)) {
        const paths = Array.isArray(p.rootPaths) ? p.rootPaths.filter(v => typeof v === 'string') : []
        const group = byId.get(p.id) || byPath.get(paths.length ? pathKey(paths[0]) : '') || result.group(p.id, p.name)
        byId.set(p.id, group)
        for (const path of paths) byPath.set(pathKey(path), group)
      }
      const cols = ['id', 'cwd', 'rollout_path', 'name', 'title', 'source', 'project_id', 'updated_at'].filter(c => columns.has(c))
      for (const row of db.prepare('SELECT ' + cols.join(',') + ' FROM threads WHERE archived=0 ORDER BY updated_at DESC').all()) {
        if (!row.cwd || (!row.rollout_path && !historyDb) || String(row.source).includes('"subagent"')) continue
        const key = pathKey(row.cwd)
        const group = byId.get(row.project_id) || byId.get(assignments[row.id]?.projectId) ||
          (noProject.has(row.id) ? result.group('projectless', '未分组') : byPath.get(key) || result.group(key, basename(key) || key))
        result.add({ id: row.id, cwd: row.cwd, file: row.rollout_path && resolve(home, row.rollout_path),
          historyDb: historyDb && join(home, historyDb.name),
          title: row.name || row.title, updatedAt: row.updated_at * 1000 }, group)
      }
      break
    } finally { db?.close() }
  }
  return result
}

async function harnessLibrary(home) {
  const result = catalog('deepseek')
  const workspaces = (await readJson(join(home, 'storages', 'workspace.json'))).tables?.workspaces ?? {}
  const membership = new Map()
  for (const w of Object.values(workspaces)) {
    if (typeof w.path !== 'string') continue
    const group = result.group(pathKey(w.path), w.title || basename(w.path))
    for (const id of w.sessionIds ?? []) membership.set(id, group)
  }
  const root = join(home, 'sessions')
  for (const folder of await dirs(root)) {
    if (!folder.isDirectory()) continue
    for (const { file, updatedAt } of await harnessCandidates(join(root, folder.name))) {
      const row = await harnessMetadata(file)
      if (!row) continue
      const projection = await readJson(join(home, 'storages', 'session_projcache', 'sessions', row.id + '.json'))
      const cached = projection.record?.rows
      const group = membership.get(row.id) || result.group(pathKey(row.cwd), basename(row.cwd))
      result.add({ ...row, file, home, updatedAt, title: cached?.title?.val || row.title,
        canResume: row.canResume && !cached?.agentPreset?.val?.id }, group)
    }
  }
  return result
}

export async function desktopLibrary(env) {
  const catalogs = await Promise.all([
    codexLibrary(env.CODEX_HOME || join(homedir(), '.codex')),
    harnessLibrary(env.DSH_HOME || join(homedir(), '.dsh')),
  ])
  const groups = catalogs.flatMap(c => [...c.groups.values()])
  for (const group of groups) group.sessions.sort((a, b) => b.updatedAt - a.updatedAt)
  const records = new Map(catalogs.flatMap(c => [...c.entries.values()].map(row => [row.agent + ':' + row.id, row])))
  return { groups, records }
}

function blockText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(block => {
    if (['Text', 'text', 'input_text', 'output_text'].includes(block?.type)) return block.text
    if (['Image', 'image', 'input_image', 'localImage', 'local_image'].includes(block?.type)) return '〔图片〕'
    return ''
  }).filter(Boolean).join('\n')
}

function codexHistoryRows(entry, base) {
  const db = new DatabaseSync(entry.historyDb, { readOnly: true })
  try {
    db.exec('BEGIN')
    const bounded = Number.isSafeInteger(base?.end_ordinal_exclusive)
    const where = "FROM thread_items WHERE thread_id=? AND item_type IN ('userMessage','agentMessage')" +
      (bounded ? ' AND rollout_ordinal < ?' : '')
    const params = [base?.thread_id || entry.id, ...(bounded ? [base.end_ordinal_exclusive] : [])]
    const { total, ordinal } = db.prepare('SELECT count(*) AS total, max(updated_at_ordinal) AS ordinal ' + where).get(...params)
    if (!total) return null
    const rows = db.prepare('SELECT item_json, item_id ' + where + ' ORDER BY rollout_ordinal, item_id').all(...params)
    const messages = rows.map(row => {
      const item = JSON.parse(row.item_json)
      const attachments = contentFiles(entry, item.content)
      return { id: item.id || row.item_id, role: item.type === 'userMessage' ? 'user' : 'assistant',
        text: item.type === 'userMessage' ? blockText(item.content) : item.text ?? blockText(item.content),
        ...(attachments.length && { attachments }) }
    })
    return { messages, revision: [total, ordinal].join(':') }
  } finally { db.close() }
}

async function codexMessages(file, entry) {
  const messages = []
  let base
  let items = [], legacy = [], responses = []
  function finishTurn() {
    for (const m of items.length ? items : legacy.length ? legacy : responses) messages.push(m)
    items = []; legacy = []; responses = []
  }
  const stream = createReadStream(file, { encoding: 'utf8' })
  try {
    for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
      if (!line.includes('session_meta') && !line.includes('"message"') && !line.includes('item_completed') && !line.includes('agent_message') && !line.includes('user_message') && !line.includes('task_started')) continue
      let record
      try { record = JSON.parse(line) } catch { continue }
      const p = record.payload
      if (record.type === 'session_meta') {
        base = p?.history_base
      } else if (record.type === 'event_msg' && p?.type === 'task_started') {
        finishTurn()
      } else if (record.type === 'event_msg' && p?.type === 'item_completed') {
        const item = p.item
        if (item?.type !== 'UserMessage' && item?.type !== 'AgentMessage') continue
        const text = blockText(item.content)
        const attachments = contentFiles(entry, item.content)
        if (text || attachments.length) items.push({ id: item.id, role: item.type === 'UserMessage' ? 'user' : 'assistant', text,
          ...(attachments.length && { attachments }) })
      } else if (record.type === 'event_msg' && ['user_message', 'agent_message'].includes(p?.type)) {
        if (typeof p.message === 'string') legacy.push({ role: p.type === 'user_message' ? 'user' : 'assistant', text: p.message })
      } else if (record.type === 'response_item' && p?.type === 'message' && ['user', 'assistant'].includes(p.role)) {
        const text = blockText(p.content)
        if (text && !/^\s*(?:<environment_context>|<permissions instructions>|# AGENTS\.md instructions)/u.test(text)) responses.push({ role: p.role, text })
      }
    }
  } finally { stream.destroy() }
  finishTurn()
  return { messages, base }
}

async function harnessMessages(file, entry) {
  const messages = []
  const turns = new Map(), deliveries = new Map()
  let pending = ''
  function append(chunk) {
    const lines = (pending + chunk).split('\n')
    pending = lines.pop()
    for (const line of lines) {
      if (!line.includes('user/message') && !line.includes('assistant/message') && !line.includes('deliverables/presented')) continue
      let e
      try { e = JSON.parse(line) } catch { continue }
      if (e.type === 'deliverables/presented') {
        deliveries.set(e.data.turn, [...(deliveries.get(e.data.turn) || []), ...deliveredFiles(entry, e.data.files)])
        continue
      }
      if (!['user/message', 'assistant/message'].includes(e.type)) continue
      if (e.type === 'user/message' && e.data?.source?.kind && e.data.source.kind !== 'user') continue
      const text = blockText(e.data?.message?.content ?? e.data?.content)
      const attachments = contentFiles(entry, e.data?.message?.content ?? e.data?.content)
      if (text || attachments.length) {
        const message = { role: e.type === 'user/message' ? 'user' : 'assistant', text,
          ...(attachments.length && { attachments }) }
        messages.push(message)
        if (message.role === 'assistant') turns.set(e.data.turn, message)
      }
    }
  }
  if (file.endsWith('.zstd')) {
    // Each append is a separate frame. Node's streaming decoder stops at the first.
    const source = await readFile(file)
    let offset = 0
    while (offset < source.length) {
      let frame
      try { frame = zstdDecompressSync(source.subarray(offset), { info: true }) }
      catch (error) { if (error.code === 'Z_BUF_ERROR') break; throw error }
      append(frame.buffer.toString('utf8'))
      offset += frame.engine.bytesWritten
    }
  } else {
    for await (const chunk of createReadStream(file, { encoding: 'utf8' })) append(chunk)
  }
  if (pending) append('\n')
  for (const [turn, files] of deliveries) {
    const message = turns.get(turn)
    if (message) message.attachments = [...(message.attachments || []), ...files]
  }
  return messages
}

// Cache only the most recently opened transcripts; mutations invalidate by file stat.
export function historyReader() {
  const cache = new Map()
  return async (entry, before) => {
    const info = entry.file && await stat(entry.file).catch(error => { if (error.code !== 'ENOENT') throw error })
    let revision = info ? info.size + ':' + info.mtimeMs : 'missing'
    if (!info && !entry.historyDb) throw new Error('电脑会话文件不存在。')
    let saved = cache.get(entry.file)
    if (saved?.revision !== revision) {
      saved = { revision, messages: !info ? Promise.resolve({ messages: [] }) : entry.agent === 'codex' ? codexMessages(entry.file, entry) : harnessMessages(entry.file, entry) }
      cache.delete(entry.file)
      cache.set(entry.file, saved)
      if (cache.size > 4) cache.delete(cache.keys().next().value)
    }
    let rows
    try { rows = await saved.messages } catch (error) { if (cache.get(entry.file) === saved) cache.delete(entry.file); throw error }
    if (entry.agent === 'codex') {
      const log = rows
      let history
      if (entry.historyDb) {
        try { history = codexHistoryRows(entry, log.base) }
        catch (error) { if (!info || log.base) throw error }
      }
      rows = [...(history?.messages || [])]
      const ids = new Map(rows.map((m, i) => [m.id, i]).filter(([id]) => id))
      for (const message of log.messages) {
        if (message.id && ids.has(message.id)) rows[ids.get(message.id)] = message
        else { if (message.id) ids.set(message.id, rows.length); rows.push(message) }
      }
      revision += ':' + (history?.revision || '')
    }
    const end = Math.min(before ?? rows.length, rows.length)
    let start = end, size = 0
    while (start && end - start < 30 && size < 256000) size += rows[--start].text.length
    return { messages: rows.slice(start, end), before: start, total: rows.length, revision }
  }
}
