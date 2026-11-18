import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { startServer } from './server.mjs'

const agents = { codex: { available: true, name: 'codex' }, deepseek: { available: true, name: 'deepseek' } }

async function fixture(t, overrides) {
  const folder = await mkdtemp(join(tmpdir(), 'yingluo-server-test-'))
  const projectDir = join(folder, 'demo')
  await mkdir(projectDir)
  const options = { projectDir, dataDir: join(folder, 'data'), port: 0, agents, env: {}, ...overrides }
  let server = await startServer(options)
  t.after(async () => {
    await server.close()
    await rm(folder, { recursive: true, force: true })
  })
  let token
  async function request(path, method = 'GET', body) {
    const response = await fetch('http://127.0.0.1:' + server.port + '/v1/' + path, {
      method,
      headers: {
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    return { status: response.status, body: await response.json() }
  }
  return {
    projectDir,
    options,
    request,
    async pair() {
      const response = await request('pair', 'POST', { code: server.pairingCode, label: '测试手机' })
      assert.equal(response.status, 200)
      token = response.body.token
      return token
    },
    async restart() { await server.close(); server = await startServer(options) },
    async waitFor(id, predicate) {
      for (let attempt = 0; attempt < 80; attempt++) {
        const { body: { session } } = await request('work/sessions/' + id)
        if (predicate(session)) return session
        await delay(20)
      }
      assert.fail('Work session did not reach the expected state')
    },
  }
}

test('requires a one-time pairing code and resumes both kinds of session after restart', async t => {
  const calls = []
  const app = await fixture(t, {
    async runner(agent, options) {
      calls.push({ agent: agent.name, cwd: options.projectDir, resumeId: options.resumeId })
      const resumeId = agent.name + '-saved'
      options.onEvent({ type: 'session', resumeId })
      options.onEvent({ type: 'status', text: '读取项目' })
      return { text: '回答 ' + options.prompt, resumeId }
    },
  })
  assert.equal((await app.request('health')).status, 200)
  assert.equal((await app.request('work')).status, 401)
  assert.equal((await app.request('pair', 'POST', { code: 'WRONG' })).status, 401)
  await app.pair()
  await assert.rejects(app.pair())
  const work = (await app.request('work')).body
  assert.deepEqual(work.project, { name: 'demo' })
  assert.deepEqual(work.agents, { codex: { available: true }, deepseek: { available: true }, neko: { available: false } })
  const ids = []
  for (const agent of ['codex', 'deepseek']) {
    const { body: { session } } = await app.request('work/sessions', 'POST', { agent })
    ids.push(session.id)
    assert.equal((await app.request('work/sessions/' + session.id + '/messages', 'POST', { text: '检查项目' })).status, 202)
    const finished = await app.waitFor(session.id, item => item.status === 'idle')
    assert.equal(finished.messages.at(-1).text, '回答 检查项目')
    assert.equal(finished.events[0].text, '读取项目')
    assert.equal(finished.resumeId, undefined)
  }
  await assert.rejects(startServer(app.options), /已在另一个电脑服务中打开/)
  await app.restart()
  assert.equal((await app.request('work')).body.sessions.length, 2)
  for (const id of ids) {
    await app.request('work/sessions/' + id + '/messages', 'POST', { text: '继续' })
    await app.waitFor(id, item => item.messages.length === 4)
  }
  assert.deepEqual(calls.map(call => call.resumeId), [undefined, undefined, 'codex-saved', 'deepseek-saved'])
  assert(calls.every(call => call.cwd === app.projectDir))
})

test('serializes project jobs and cancels the active execution', async t => {
  const app = await fixture(t, { async runner(_agent, { signal }) {
    await delay(30000, undefined, { signal })
    return { text: '完成' }
  } })
  await app.pair()
  const { body: { session } } = await app.request('work/sessions', 'POST', { agent: 'codex' })
  await app.request('work/sessions/' + session.id + '/messages', 'POST', { text: '项目任务' })
  assert.equal((await app.request('work/sessions/' + session.id + '/messages', 'POST', { text: '第二条' })).status, 409)
  await app.request('work/sessions/' + session.id + '/cancel', 'POST')
  const cancelled = await app.waitFor(session.id, item => item.status === 'cancelled')
  assert.equal(cancelled.messages.length, 1)
})

test('deletes only a paired device’s requested Work session and protects an active run', async t => {
  const app = await fixture(t, { async runner(_agent, { signal }) {
    await delay(30000, undefined, { signal })
    return { text: '完成' }
  } })
  assert.equal((await app.request('work/sessions/00000000-0000-0000-0000-000000000000', 'DELETE')).status, 401)
  await app.pair()
  const create = async () => (await app.request('work/sessions', 'POST', { agent: 'codex' })).body.session.id
  const active = 'work/sessions/' + await create()
  const idle = 'work/sessions/' + await create()
  await app.request(active + '/messages', 'POST', { text: '等待取消' })
  assert.equal((await app.request(active, 'DELETE')).status, 409)
  assert.equal((await app.request(idle, 'DELETE')).status, 200)
  await app.request(active + '/cancel', 'POST')
  await app.restart()
  assert.equal((await app.request(idle, 'GET')).status, 404)
  assert.equal((await app.request(active, 'GET')).status, 200)
})

test('exposes recent metadata to paired clients and adopts only a listed session in this project', async t => {
  const app = await fixture(t, {
    recent: () => [{ agent: 'deepseek', id: 'desktop-session', title: '现有会话', home: 'private-home', updatedAt: 123 }],
    async runner(_agent, { resumeId, agentHome }) {
      assert.equal(resumeId, 'desktop-session')
      assert.equal(agentHome, 'private-home')
      return { text: '原会话已接续', resumeId }
    },
  })
  assert.equal((await app.request('work')).status, 401)
  await app.pair()
  assert.deepEqual((await app.request('work')).body.recentSessions, [
    { agent: 'deepseek', id: 'desktop-session', title: '现有会话', updatedAt: 123 },
  ])
  assert.equal((await app.request('work/sessions', 'POST', { agent: 'deepseek', recentId: 'unknown' })).status, 404)
  const request = { agent: 'deepseek', recentId: 'desktop-session' }
  const { body: { session } } = await app.request('work/sessions', 'POST', request)
  assert.equal((await app.request('work/sessions', 'POST', request)).body.session.id, session.id)
  assert.deepEqual((await app.request('work')).body.recentSessions, [])
  await app.request('work/sessions/' + session.id + '/messages', 'POST', { text: '继续' })
  const result = await app.waitFor(session.id, item => item.status === 'idle')
  assert.equal(result.messages.at(-1).text, '原会话已接续')
})

test('stores binary Work attachments inside the project and passes the selected effort to the agent', async t => {
  const calls = []
  const app = await fixture(t, {
    async runner(_agent, options) {
      calls.push(options)
      return { text: '读取成功', resumeId: 'fixture' }
    },
  })
  await app.pair()
  const { body: { session } } = await app.request('work/sessions', 'POST', { agent: 'codex' })
  const route = 'work/sessions/' + session.id + '/messages'
  const bytes = Buffer.alloc(512 * 1024, 0xab)
  const testFiles = [{ name: '../../test.png', data: bytes.toString('base64') }]
  assert.equal((await app.request(route, 'POST', { attachments: testFiles, reasoningEffort: 'max' })).status, 400)
  assert.equal((await app.request(route, 'POST', { attachments: [{ name: 'bad.png', data: '????' }] })).status, 400)
  assert.equal((await app.request(route, 'POST', { attachments: testFiles, reasoningEffort: 'high' })).status, 202)
  const saved = await app.waitFor(session.id, item => item.status === 'idle')
  const attachment = saved.messages[0].attachments[0]
  assert.equal(saved.reasoningEffort, 'high')
  assert.match(attachment.path, /^\.yingluo-uploads\/turn-\w+\/file-1\.png$/u)
  assert.equal(attachment.name, '../../test.png')
  assert.equal(attachment.data, undefined)
  assert.deepEqual(await readFile(join(app.projectDir, attachment.path)), bytes)
  assert.equal(calls[0].reasoningEffort, 'high')
  assert.deepEqual(calls[0].images, [attachment.path])
  assert(calls[0].prompt.includes(attachment.path))
  await app.request(route, 'POST', { text: '继续' })
  await app.waitFor(session.id, item => item.messages.length === 4)
  assert.equal(calls[1].reasoningEffort, 'high')
})

test('routes a Work assistant request through the chosen agent and links its conversation', async t => {
  const requests = []
  const model = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    requests.push(input)
    const message = input.tools
      ? { tool_calls: [{ function: { name: 'delegate', arguments: JSON.stringify({ agent: 'deepseek', prompt: '检查项目' }) } }] }
      : { content: '测试汇报：' + input.messages.at(-1).content }
    response.end(JSON.stringify({ choices: [{ message }] }))
  })
  await new Promise(ready => model.listen(0, '127.0.0.1', ready))
  t.after(() => model.close())
  const app = await fixture(t, {
    env: { YINGLUO_AI_BASE_URL: 'http://127.0.0.1:' + model.address().port + '/v1', YINGLUO_AI_MODEL: 'fixture' },
    async runner(agent, { resumeId }) {
      assert.equal(agent.name, 'deepseek')
      return { text: resumeId ? '接续成功' : '已检查', resumeId: 'deepseek-child' }
    },
  })
  await app.pair()
  const { body: { session } } = await app.request('work/sessions', 'POST', { agent: 'neko' })
  await app.request('work/sessions/' + session.id + '/messages', 'POST', { text: '请帮我检查项目' })
  const finished = await app.waitFor(session.id, item => item.status === 'idle')
  const { sessionId } = finished.events.find(event => event.type === 'dispatch')
  assert.match(finished.messages.at(-1).text, /已检查/)
  const { body: { session: child } } = await app.request('work/sessions/' + sessionId)
  assert.equal(child.agent, 'deepseek')
  assert.equal(child.messages.at(-1).text, '已检查')
  await app.request('work/sessions/' + child.id + '/messages', 'POST', { text: '继续' })
  assert.equal((await app.waitFor(child.id, item => item.messages.length === 4)).messages.at(-1).text, '接续成功')
  assert.equal(requests.length, 2)
  assert.equal(requests[1].tools, undefined)
})
