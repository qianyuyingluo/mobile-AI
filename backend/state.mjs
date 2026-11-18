import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

/** Persist paired devices and conversation state for one computer project. */
export function openState(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(join(directory, 'work.sqlite'))
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS devices (
      token_hash TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      updated_at INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `)
  const readSession = db.prepare('SELECT data FROM sessions WHERE id = ?')
  const readSessions = db.prepare('SELECT data, updated_at FROM sessions ORDER BY updated_at DESC')
  const deleteSession = db.prepare('DELETE FROM sessions WHERE id = ?')
  const writeSession = db.prepare(`
    INSERT INTO sessions (id, updated_at, data) VALUES (?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET updated_at = excluded.updated_at, data = excluded.data
  `)
  const insertDevice = db.prepare('INSERT INTO devices (token_hash, label, created_at) VALUES (?, ?, ?)')
  const readDevice = db.prepare('SELECT 1 FROM devices WHERE token_hash = ?')

  const save = session => { writeSession.run(session.id, Date.now(), JSON.stringify(session)) }
  for (const { data } of readSessions.all()) {
    const session = JSON.parse(data)
    if (session.status !== 'running') continue
    session.status = 'failed'
    session.events.push({ type: 'error', text: '电脑服务中断，任务已结束。' })
    save(session)
  }

  return {
    pair(label) {
      const token = randomBytes(32).toString('base64url')
      insertDevice.run(digest(token), label, Date.now())
      return token
    },
    authorized(token) { return readDevice.get(digest(token)) !== undefined },
    get(id) {
      const row = readSession.get(id)
      return row ? JSON.parse(row.data) : undefined
    },
    list() { return readSessions.all().map(({ data, updated_at }) => ({ ...JSON.parse(data), updatedAt: updated_at })) },
    delete(id) { deleteSession.run(id) },
    create(agent, title, resumeId, agentHome) {
      const session = { id: randomUUID(), agent, title, status: 'idle', messages: [], events: [],
        ...(resumeId && { resumeId }), ...(agentHome && { agentHome }) }
      save(session)
      return session
    },
    save,
    close() { db.close() },
  }
}

/** Session reply without CLI driver state or resume identifiers. */
export function publicSession({ id, agent, title, status, messages, events, reasoningEffort }) {
  return { id, agent, title, status, messages, events, reasoningEffort }
}
