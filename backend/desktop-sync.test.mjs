import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toNamespacedPath } from 'node:path'
import { appendFile, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { sendCodexDesktopMessage } from './codex-desktop.mjs'
import { desktopHistory } from '../app/mobile/ui/desktop-history.js'
import { installHarnessSync } from './install-harness-sync.mjs'
import { apply as harnessPlugin } from './harness-desktop-plugin.mjs'
import { saveAttachments } from './work-attachments.mjs'
import { historyReader } from './desktop-library.mjs'

test('Codex paginated continuation includes live log after the database base, excluding replaced turns', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ayane-continuation-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const historyDb = join(root, 'history.sqlite'), file = join(root, 'continued.jsonl')
  const db = new DatabaseSync(historyDb)
  db.exec('CREATE TABLE thread_items(thread_id, item_type, item_json, rollout_ordinal, updated_at_ordinal, item_id)')
  for (let i = 0; i < 35; i++) db.prepare('INSERT INTO thread_items VALUES (?,?,?,?,?,?)').run('thread', 'userMessage',
    JSON.stringify({ type: 'userMessage', id: 'm' + i, content: [{ type: 'text', text: 'question ' + i }] }), i, i, 'm' + i)
  db.close()
  const line = value => JSON.stringify(value) + '\n'
  const item = (id, text) => line({ type: 'event_msg', payload: { type: 'item_completed', item: {
    id, type: 'AgentMessage', content: [{ type: 'Text', text }],
  } } })
  await writeFile(file, line({ type: 'session_meta', payload: { history_mode: 'paginated',
    history_base: { thread_id: 'thread', end_ordinal_exclusive: 33 } } }) + item('reply1', 'new reply'))
  const read = historyReader(), entry = { id: 'thread', agent: 'codex', historyDb, file }
  let page = await read(entry)
  assert.equal(page.total, 34)
  assert.equal(page.messages.at(-1).text, 'new reply')
  assert(!page.messages.some(m => m.text === 'question 33'))
  await appendFile(file, item('reply2', 'new reply'))
  page = await read(entry)
  assert.equal(page.total, 35) // identical text in distinct turns must survive
  assert.deepEqual(page.messages.slice(-2).map(m => m.id), ['reply1', 'reply2'])
  const older = await read(entry, page.before)
  assert.equal(older.before, 0)
  assert.equal(older.messages[0].text, 'question 0')
  await appendFile(file, item('reply2', 'updated reply'))
  page = await read(entry)
  assert.equal(page.total, 35)
  assert.equal(page.messages.at(-1).text, 'updated reply')
})

test('Codex routes a normal user turn to the discovered desktop owner and preserves settings', async () => {
  const path = process.platform === 'win32' ? '\\\\.\\pipe\\ayane-test-' + randomUUID() : join(tmpdir(), randomUUID() + '.sock')
  const calls = []
  const server = createServer(socket => {
    let bytes = Buffer.alloc(0)
    socket.on('data', chunk => {
      bytes = Buffer.concat([bytes, chunk])
      while (bytes.length >= 4 && bytes.length >= 4 + bytes.readUInt32LE()) {
        const size = bytes.readUInt32LE(), request = JSON.parse(bytes.subarray(4, size + 4))
        bytes = bytes.subarray(size + 4); calls.push(request)
        const result = request.method === 'initialize' ? { clientId: 'phone' } : {}
        const body = Buffer.from(JSON.stringify({ type: 'response', requestId: request.requestId,
          resultType: 'success', handledByClientId: 'desktop', result }))
        const header = Buffer.alloc(4); header.writeUInt32LE(body.length)
        // Fragmented frames must survive Windows pipe chunking.
        socket.write(header.subarray(0, 2)); socket.write(Buffer.concat([header.subarray(2), body]))
      }
    })
  })
  await new Promise(resolve => server.listen(path, resolve))
  try {
    assert.deepEqual(await sendCodexDesktopMessage('original-thread', 'hello', 'receipt', { pipe: path }), { accepted: true })
    assert.deepEqual(calls.map(c => c.method), ['initialize', 'thread-owner-discovery', 'thread-follower-start-turn'])
    const call = calls.at(-1)
    assert.equal(call.targetClientId, 'desktop')
    assert.equal(call.sourceClientId, 'phone')
    assert.equal(call.version, 2)
    assert.equal(call.params.turnStart.request.threadId, 'original-thread')
    assert.equal(call.params.turnStart.request.clientUserMessageId, 'receipt')
    assert.deepEqual(call.params.turnStart.request.input, [{ type: 'text', text: 'hello', text_elements: [] }])
    assert.deepEqual(call.params.turnStart.context, { inheritThreadSettings: true })
  } finally { await new Promise(resolve => server.close(resolve)) }
})

test('reconnection reloads all previously visible messages even after more than one page arrives', async () => {
  const messages = Array.from({ length: 105 }, (_, id) => ({ role: 'user', text: String(id) }))
  const result = await desktopHistory(async (end = messages.length) => ({
    messages: messages.slice(Math.max(0, end - 30), end), before: Math.max(0, end - 30), total: messages.length,
  }), 0)
  assert.deepEqual(result.messages, messages)
  assert.equal(result.before, 0)
})

test('history rejects a stalled page rather than looping indefinitely', async () => {
  await assert.rejects(desktopHistory(async () => ({ messages: [], before: 4 }), 0), /分页/)
})

test('uploads accept Codex namespaced cwd and still reject redirected upload folders', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ayane-path-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'project'), outside = join(root, 'outside')
  await mkdir(project); await mkdir(outside)
  const saved = await saveAttachments(toNamespacedPath(project), [{ name: 'note.txt', data: Buffer.from('note') }])
  assert.equal(await readFile(join(project, saved[0].path), 'utf8'), 'note')
  const linked = join(root, 'linked')
  await mkdir(linked)
  await symlink(outside, join(linked, '.yingluo-uploads'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(saveAttachments(linked, [{ name: 'note.txt', data: Buffer.from('note') }]), /实际目录/u)
})

test('Harness installer upgrades its own versioned module and leaves unrelated configuration intact', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ayane-install-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const home = join(root, 'dsh'), local = join(root, 'local')
  await mkdir(join(home, 'profiles', 'desktop'), { recursive: true })
  const path = join(home, 'profiles', 'desktop', 'cordis.patch.yml')
  const original = '# existing desktop configuration\n- insert: []\n'
  await writeFile(path, original)
  const env = { DSH_HOME: home, LOCALAPPDATA: local }
  await installHarnessSync(env)
  const installed = await readFile(path, 'utf8')
  assert(installed.startsWith(original))
  assert.match(installed, /harness-desktop-plugin-[a-f0-9]{16}\.mjs/u)
  await installHarnessSync(env)
  assert.equal(await readFile(path, 'utf8'), installed)
  await writeFile(path, installed.replace(/harness-desktop-plugin-[a-f0-9]{16}/u, 'harness-desktop-plugin-old'))
  await installHarnessSync(env)
  assert.equal(await readFile(path, 'utf8'), installed)
  assert.equal((await readdir(join(local, 'YingluoWork'))).filter(f => f.endsWith('.backup')).length, 2)
})

test('Harness bridge admits encoded image parts into the original session and closes cleanly', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ayane-plugin-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const descriptor = join(root, 'connection.json')
  let dispose, prompt
  await harnessPlugin({ on(_event, action) { dispose = action }, sessionController: {
    async prompt(value) { prompt = value; return { accepted: true } },
  } }, { descriptor })
  try {
    const { port, token } = JSON.parse(await readFile(descriptor))
    const origin = 'http://127.0.0.1:' + port
    assert.equal((await fetch(origin + '/health')).status, 401)
    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }
    assert.equal((await (await fetch(origin + '/health', { headers })).json()).protocol, 2)
    const image = { name: 'test.png', data: 'eA==', mediaType: 'image/png' }
    const response = await fetch(origin + '/prompt', { method: 'POST', headers,
      body: JSON.stringify({ sessionId: 'original', text: 'hello', requestId: 'receipt', images: [image] }) })
    assert.equal(response.status, 200)
    assert.equal(prompt.sessionId, 'original')
    assert.equal(prompt.requestId, 'receipt')
    assert.deepEqual(prompt.content, [{ type: 'text', text: 'hello' }, { type: 'image', ...image }])
  } finally { await dispose() }
  await assert.rejects(readFile(descriptor), { code: 'ENOENT' })
})
