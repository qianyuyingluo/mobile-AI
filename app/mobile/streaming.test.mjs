import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { eventStreamParser } from './ui/event-stream.js'

globalThis.window = {}
const { requestStream } = await import('./ui/http.js')
const { chatStreamReader, streamingChatRequest, restoreChatModels } = await import('./ui/chat-providers.js')

test('SSE survives every chunk boundary, multiline data and CRLF', () => {
  const source = ': keepalive\r\nevent: message\r\ndata: {"text":\r\ndata: "你好"}\r\n\r\ndata: [DONE]\n\n'
  for (let at = 1; at < source.length; at++) {
    const events = []
    const parser = eventStreamParser(value => events.push(value))
    parser.push(source.slice(0, at)); parser.push(source.slice(at)); parser.finish()
    assert.deepEqual(events, [{ event: 'message', data: '{"text":\n"你好"}' }, { event: '', data: '[DONE]' }])
  }
})

test('provider streams only publish visible text and require terminal evidence', () => {
  const fixtures = [
    ['deepseek', [{ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hidden' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: '你好' } }, { type: 'message_stop' }]],
    ['anthropic', [{ type: 'content_block_delta', delta: { type: 'text_delta', text: '你好' } }, { type: 'message_stop' }]],
    ['responses', [{ type: 'response.output_text.delta', delta: '你好' }, { type: 'response.completed' }]],
    ['completions', [{ choices: [{ delta: { content: '你好' } }] }, { choices: [{ finish_reason: 'stop' }] }]],
    ['gemini', [{ candidates: [{ content: { parts: [{ text: 'hidden', thought: true }, { text: '你好' }] }, finishReason: 'STOP' }] }]],
  ]
  for (const [protocol, events] of fixtures) {
    let output = ''
    const reader = chatStreamReader({ protocol }, value => { output += value })
    for (const event of events) reader.event({ data: JSON.stringify(event) })
    reader.finish()
    assert.equal(output, '你好')
  }
  const reader = chatStreamReader({ protocol: 'deepseek' }, () => {})
  assert.throws(() => reader.finish(), /interrupted/)
  assert.throws(() => reader.event({ data: '{"type":"error"}' }), /failed/)
  const { providers } = restoreChatModels(null, null)
  for (const provider of providers.filter(p => !p.unavailable)) {
    const request = streamingChatRequest(provider, provider.models[0].id, 'fixture', [], 'low')
    if (provider.protocol === 'gemini') assert.match(request.url, /:streamGenerateContent\?alt=sse$/)
    else assert.equal(request.data.stream, true)
  }
})

test('browser receives text before response ends; errors and cancellation settle', async t => {
  let finish
  const server = createServer((request, response) => {
    if (request.url === '/error') { response.writeHead(401); response.end('{}'); return }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.write('data: {"text":"第一段"}\n\n')
    finish = () => response.end('data: [DONE]\n\n')
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const url = 'http://127.0.0.1:' + server.address().port
  let first
  const arrived = new Promise(resolve => { first = resolve })
  const pending = requestStream(url, { data: {}, onEvent: event => first(event) })
  assert.equal((await arrived).data, '{"text":"第一段"}')
  finish()
  await pending
  await assert.rejects(requestStream(url + '/error', { data: {}, onEvent() {} }), { status: 401 })
  const controller = new AbortController()
  const cancelled = requestStream(url, { data: {}, signal: controller.signal, onEvent() { controller.abort() } })
  await assert.rejects(cancelled, { name: 'AbortError' })
})

test('exposed thinking streams separately from answers and opaque signatures', () => {
  const fixtures = [
    ['deepseek', [
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '先分析。' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '再验证。' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'opaque' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'encrypted' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: '答案' } },
      { type: 'message_stop' },
    ]],
    ['anthropic', [
      { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '先分析。再验证。' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: '答案' } }, { type: 'message_stop' },
    ]],
    ['completions', [{ choices: [{ delta: { reasoning_content: '先分析。再验证。' } }] },
      { choices: [{ delta: { content: '答案' }, finish_reason: 'stop' }] }]],
    ['responses', [{ type: 'response.reasoning_summary_text.delta', delta: '先分析。再验证。' },
      { type: 'response.output_text.delta', delta: '答案' }, { type: 'response.completed' }]],
    ['gemini', [{ candidates: [{ content: { parts: [{ thought: true, text: '先分析。再验证。' },
      { thoughtSignature: 'opaque' }, { text: '答案' }] }, finishReason: 'STOP' }] }]],
  ]
  for (const [protocol, events] of fixtures) {
    let answer = '', reasoning = ''
    const reader = chatStreamReader({ protocol }, chunk => { answer += chunk }, () => {}, chunk => { reasoning += chunk })
    for (const event of events) reader.event({ data: JSON.stringify(event) })
    reader.finish()
    assert.equal(answer, '答案', protocol)
    assert.equal(reasoning, '先分析。再验证。', protocol)
  }
})

test('summary requests are limited to supported model families without enabling DeepSeek thinking', () => {
  const { providers } = restoreChatModels(null, null)
  const openai = providers.find(provider => provider.id === 'openai')
  assert.deepEqual(streamingChatRequest(openai, 'gpt-5.4', '', [], '').data.reasoning, { effort: 'none', summary: 'auto' })
  assert.equal(streamingChatRequest(openai, 'gpt-4o-mini', '', [], '').data.reasoning, undefined)
  assert.equal(streamingChatRequest(openai, 'gpt-5-chat-latest', '', [], '').data.reasoning, undefined)
  const google = providers.find(provider => provider.id === 'google')
  assert.equal(streamingChatRequest(google, 'gemini-2.5-flash', '', [], 'high').data.generationConfig.thinkingConfig.includeThoughts, true)
  const deepseek = providers.find(provider => provider.id === 'deepseek-official')
  assert.equal(streamingChatRequest(deepseek, 'deepseek-flash', '', [], 'off').data.thinking.type, 'disabled')
})
