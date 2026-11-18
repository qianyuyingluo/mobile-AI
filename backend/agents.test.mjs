import assert from 'node:assert/strict'
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { discoverAgents, runAgent } from './agents.mjs'

async function fixture(t, id, source) {
  const projectDir = await mkdtemp(join(tmpdir(), 'yingluo-agent-'))
  const file = join(projectDir, 'fixture.mjs')
  t.after(async () => {
    await unlink(file)
    await rmdir(projectDir)
  })
  await writeFile(file, `
    const argv = process.argv.slice(2)
    const emit = event => console.log(JSON.stringify(event))
    let input = ''
    for await (const chunk of process.stdin.setEncoding('utf8')) input += chunk
    ${source}
  `)
  return { agent: { id, available: true, command: process.execPath, prefix: [file] }, projectDir }
}

test('discovers an explicit executable and reports missing overrides without exposing their paths', async () => {
  const invalid = join(tmpdir(), 'nonexistent-yingluo-command')
  const found = await discoverAgents({
    env: { YINGLUO_CODEX_COMMAND: process.execPath, YINGLUO_DSH_COMMAND: invalid },
  })
  assert.equal(found.codex.available, true)
  assert.equal(found.codex.command, process.execPath)
  assert.equal(found.deepseek.available, false)
  assert.match(found.deepseek.reason, /YINGLUO_DSH_COMMAND/u)
  assert.ok(!found.deepseek.reason.includes(invalid))
})

test('passes the prompt by stdin, checkpoints Codex sessions, and omits reasoning and raw tool output', async t => {
  const { agent, projectDir } = await fixture(t, 'codex', `
    if (argv[0] !== 'exec' || argv[1] !== 'resume' || argv[2] !== 'stored-session'
      || argv.includes(input) || argv.at(-1) !== '-') process.exit(3)
    emit({ type: 'thread.started', thread_id: 'recorded-session' })
    emit({ type: 'turn.started' })
    emit({ type: 'item.started', item: { type: 'command_execution', command: 'internal command' } })
    emit({ type: 'item.completed', item: { type: 'reasoning', text: 'hidden reasoning' } })
    emit({ type: 'item.completed', item: { type: 'agent_message', text: input } })
    emit({ type: 'turn.completed' })
  `)
  const prompt = '--中文 & exit /b | %PATH%\n保留换行'
  const events = []
  const result = await runAgent(agent, { projectDir, prompt, resumeId: 'stored-session', onEvent: event => events.push(event) })
  assert.deepEqual(result, { text: prompt, resumeId: 'recorded-session' })
  assert.deepEqual(events.map(event => event.type), ['session', 'status', 'status', 'message'])
  assert.equal(events[0].resumeId, 'recorded-session')
  assert.equal(events[3].text, prompt)
  assert.ok(!JSON.stringify(events).includes('internal command'))
})

test('uses DeepSeek Harness final text and rejects unactionable session IDs before spawning', async t => {
  const { agent, projectDir } = await fixture(t, 'deepseek', `
    if (JSON.stringify(argv.slice(-3)) !== JSON.stringify(['--session-id', 'session-original', '-'])) process.exit(3)
    emit({ type: 'session', sessionId: 'session-original' })
    emit({ type: 'text', text: '处理中' })
    emit({ type: 'tool_call', tool: 'read_file', input: { sensitive: 'internal-data' } })
    emit({ type: 'thinking', text: 'private' })
    process.stdout.write(JSON.stringify({ type: 'final', sessionId: 'session-original', text: '完成', reason: { kind: 'completed' } }))
  `)
  const events = []
  assert.deepEqual(await runAgent(agent, {
    projectDir, prompt: '测试', resumeId: 'session-original', onEvent: event => events.push(event),
  }), { text: '完成', resumeId: 'session-original' })
  assert.equal(events.length, 2)
  assert.match(events[1].text, /read_file/u)
  assert.ok(!JSON.stringify(events).includes('internal-data'))
  await assert.rejects(runAgent(agent, { projectDir, prompt: '测试', resumeId: '%PATH%' }), /会话 ID 无效/u)
})

test('rejects provider failures without returning request details to the client', async t => {
  const { agent, projectDir } = await fixture(t, 'deepseek', `
    emit({ type: 'session', sessionId: 'session-failure' })
    emit({ type: 'final', sessionId: 'session-failure', text: '', reason: { kind: 'error',
      error: { code: 'MISSING_CREDENTIAL', message: 'private-provider-detail' } } })
  `)
  await assert.rejects(runAgent(agent, { projectDir, prompt: '测试' }), error => {
    assert.match(error.message, /认证失败/u)
    assert.ok(!error.message.includes('private-provider-detail'))
    return true
  })
})

test('cancels a started agent without waiting for its normal completion', async t => {
  const { agent, projectDir } = await fixture(t, 'codex', `
    emit({ type: 'thread.started', thread_id: 'session-cancelled' })
    setInterval(() => {}, 500)
  `)
  const controller = new AbortController()
  await assert.rejects(runAgent(agent, {
    projectDir, prompt: '测试', signal: controller.signal,
    onEvent: event => { if (event.type === 'session') controller.abort() },
  }), { name: 'AbortError' })
})
