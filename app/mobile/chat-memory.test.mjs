import test from 'node:test'
import assert from 'node:assert/strict'
import { createChatMemory, memoryKey, memoryStream, memoryInstructions, cleanMemoryBlocks } from './ui/chat-memory.js'
globalThis.window = {}
const { streamingChatRequest, chatStreamReader } = await import('./ui/chat-providers.js')

function fixture() {
  const data = new Map()
  const storage = { getItem: k => data.get(k), setItem: (k, v) => data.set(k, v) }
  return { storage, memory: createChatMemory(storage) }
}
const patch = { add: [{ text: '用户希望称呼为小林' }] }
const wire = '好的，小林～\n<memory_update>' + JSON.stringify(patch) + '</memory_update>'
test('memory controls never flash at any two-chunk boundary or character-by-character', () => {
  for (let split = 0; split <= wire.length; split++) {
    let visible = ''
    const parser = memoryStream(text => { visible += text })
    parser.push(wire.slice(0, split))
    assert(!visible.includes('<'))
    parser.push(wire.slice(split))
    assert.deepEqual(parser.finish().patch, patch)
    assert.equal(visible, '好的，小林～\n')
  }
  let visible = ''
  const parser = memoryStream(s => { visible += s })
  for (const c of wire) { parser.push(c); assert(!visible.includes('<')) }
  assert.deepEqual(parser.finish().patch, patch)
})
test('normal replies do not trigger memory; malformed, truncated and oversized controls stay hidden', () => {
  for (const suffix of ['', '<memory_up', '<memory_update>{', '<memory_update>bad</memory_update>', '<memory_update>' + 'x'.repeat(17000) + '</memory_update>']) {
    let visible = ''
    const parser = memoryStream(s => { visible += s })
    parser.push('喵～' + suffix)
    const result = parser.finish()
    assert.equal(visible, '喵～')
    assert.equal(result.patch, undefined)
  }
})
test('memory-only and memory-before-answer responses survive arbitrary stream boundaries', () => {
  for (const suffix of ['', '已记住，以后回答会带一点喵。']) {
    const wire = '<memory_update>' + JSON.stringify(patch) + '</memory_update>' + suffix
    for (let split = 0; split <= wire.length; split++) {
      let visible = ''
      const parser = memoryStream(s => { visible += s })
      parser.push(wire.slice(0, split)); parser.push(wire.slice(split))
      assert.equal(visible, suffix)
      assert.deepEqual(parser.finish().patch, patch)
    }
  }
  let visible = ''
  const duplicate = memoryStream(s => { visible += s })
  duplicate.push(wire + wire)
  assert(duplicate.finish().error)
  assert(!visible.includes('memory_update'))
})
test('text memory survives new conversations and restart; edits and removal use known IDs', () => {
  const { memory, storage } = fixture()
  assert(memory.apply(patch, 0, { sessionId: 'chat1', messageId: 'user1' }).changed)
  const restored = createChatMemory(storage)
  const saved = restored.snapshot(), id = saved.entries[0].id
  assert(memoryInstructions(saved).includes('小林'))
  assert.equal(saved.entries[0].source.messageId, 'user1')
  assert.equal(restored.apply(patch, saved.revision, {}).changed, false)
  restored.apply({ update: [{ id, text: '用户希望称呼为小雨' }] }, saved.revision, { sessionId: 'chat2' })
  assert.match(restored.snapshot().entries[0].text, /小雨/)
  restored.undo()
  assert.match(restored.snapshot().entries[0].text, /小林/)
  restored.apply({ remove: [id] }, restored.snapshot().revision, {})
  assert.equal(restored.snapshot().entries.length, 0)
})
test('disabled memory, clear and concurrent editing invalidate a pending model update', () => {
  const { memory } = fixture()
  memory.edit({ enabled: true, fixed: '固定偏好', automatic: '旧记忆' })
  assert.equal(memory.apply(patch, 0, {}).changed, false)
  let saved = memory.snapshot()
  memory.clear()
  assert.equal(memory.apply(patch, saved.revision, {}).changed, false)
  memory.edit({ enabled: false, fixed: '固定偏好', automatic: '旧记忆' })
  saved = memory.snapshot()
  assert.equal(memoryInstructions(saved), '')
  assert.equal(memory.apply(patch, saved.revision, {}).changed, false)
})
test('invalid operations and storage failures never erase existing memory', () => {
  const { memory, storage } = fixture()
  memory.apply(patch, 0, {})
  const saved = memory.snapshot()
  for (const invalid of [{ fixed: 'overwrite' }, { update: [{ id: 'unknown', text: 'bad' }] }, { add: 'bad' }, { add: [{ text: 'x'.repeat(401) }] }]) {
    assert.throws(() => memory.apply(invalid, saved.revision, {}))
    assert.deepEqual(memory.snapshot(), saved)
  }
  storage.setItem = () => { throw new Error('disk full') }
  assert.throws(() => memory.apply({ add: [{ text: 'other' }] }, saved.revision, {}))
  assert.deepEqual(memory.snapshot(), saved)
})
test('native search history excludes memory JSON even when tags cross text blocks', () => {
  const blocks = cleanMemoryBlocks([{ type: 'text', text: '你好<memory_' }, { type: 'text', text: 'update>{"add":[]}</memory_update>' }, { type: 'server_tool_use', id: 'search' }])
  assert.equal(blocks[0].text, '你好')
  assert.equal(blocks[1].text, '')
  assert.equal(blocks[2].id, 'search')
})
test('each Chat protocol receives system memory only when enabled', () => {
  for (const protocol of ['completions', 'responses', 'anthropic', 'deepseek', 'gemini']) {
    const provider = { protocol, endpoint: 'https://example.test/v1', models: [{ id: 'test' }] }
    const data = streamingChatRequest(provider, 'test', '', [{ role: 'user', text: '你好' }], '', false, 'MEMORY').data
    assert(JSON.stringify(data).includes('MEMORY'))
    const plain = streamingChatRequest(provider, 'test', '', [{ role: 'user', text: '你好' }], '').data
    assert(!JSON.stringify(plain).includes('MEMORY'))
    if (protocol === 'completions') assert.equal(data.messages[0].role, 'system')
  }
})
test('token-limit termination cannot commit memory even if a complete block arrived', () => {
  const reader = chatStreamReader({ protocol: 'completions' }, () => {})
  reader.event({ data: JSON.stringify({ choices: [{ delta: { content: wire }, finish_reason: 'length' }] }) })
  reader.event({ data: '[DONE]' })
  reader.finish()
  assert.equal(reader.canSaveMemory(), false)
})
test('corrupt stored memory is disabled without overwriting the original data', () => {
  const { storage } = fixture()
  storage.setItem(memoryKey, '{bad')
  const memory = createChatMemory(storage)
  assert.equal(memory.snapshot().enabled, false)
  assert(memory.error())
  assert.equal(storage.getItem(memoryKey), '{bad')
})
