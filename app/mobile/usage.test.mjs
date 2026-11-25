import assert from 'node:assert/strict'
import test from 'node:test'

import { formatSpeed, formatTokens, latestSpeed, replySpeed, sessionUsage, usageRows } from './ui/usage.js'

globalThis.window = {}
const { chatStreamReader, restoreChatModels, streamingChatRequest } = await import('./ui/chat-providers.js')

const message = (role, extra = {}) => ({ role, text: 'x', ...extra })

test('session totals only count reported usage on the active branch', () => {
  const messages = [
    message('user'),
    message('assistant', { usage: { input: 100, output: 40 }, genMs: 2000 }),
    message('assistant', { usage: { input: 50 } }),
    message('assistant'),
    message('user'),
    message('assistant', { usage: { output: 10 } }),
  ]
  assert.deepEqual(sessionUsage(messages), { input: 150, output: 50, replies: 3, hasInput: true, hasOutput: true })
  assert.deepEqual(sessionUsage([]), { input: 0, output: 0, replies: 0, hasInput: false, hasOutput: false })
})

test('speed uses output tokens over the generation window only', () => {
  assert.equal(replySpeed({ usage: { output: 100 }, genMs: 2000 }), 50)
  assert.equal(replySpeed({ usage: { output: 0 }, genMs: 2000 }), null)
  assert.equal(replySpeed({ usage: { output: 10 } }), null)
  assert.equal(latestSpeed([{ usage: { output: 50 }, genMs: 1000 }, { usage: { output: 20 } }]), 50)
  assert.equal(latestSpeed([]), null)
})

test('detail rows label each reply by the user turn it answers', () => {
  const rows = usageRows([
    message('user'), message('assistant', { usage: { input: 1, output: 2 }, genMs: 1000 }),
    message('user'), message('user'), message('assistant', { usage: { input: 3, output: 4 } }),
    message('assistant'),
  ])
  assert.deepEqual(rows, [
    { turn: 1, input: 1, output: 2, speed: 2 },
    { turn: 3, input: 3, output: 4, speed: null },
  ])
})

test('missing values render as dashes instead of invented numbers', () => {
  assert.equal(formatTokens(12345), '12,345')
  assert.equal(formatTokens(null), '—')
  assert.equal(formatSpeed(38.24), '38.2 tok/s')
  assert.equal(formatSpeed(null), '—')
})

test('every stream protocol reports usage where it publishes it', () => {
  const cases = [
    ['anthropic', [
      { type: 'message_start', message: { usage: { input_tokens: 12, output_tokens: 1 } } },
      { type: 'message_delta', usage: { output_tokens: 34 } },
      { type: 'message_stop' },
    ], { input: 12, output: 34 }],
    ['deepseek', [
      { type: 'message_start', message: { usage: { input_tokens: 8, output_tokens: 1 } } },
      { type: 'message_delta', usage: { output_tokens: 21 } },
      { type: 'message_stop' },
    ], { input: 8, output: 21 }],
    ['completions', [
      { choices: [{ delta: { content: 'hi' } }] },
      { choices: [{ finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 7, completion_tokens: 9 } },
    ], { input: 7, output: 9 }],
    ['responses', [
      { type: 'response.output_text.delta', delta: 'hi' },
      { type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 6 }, output: [] } },
    ], { input: 5, output: 6 }],
    ['gemini', [
      { candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, thoughtsTokenCount: 1 } },
    ], { input: 3, output: 5 }],
  ]
  for (const [protocol, events, expected] of cases) {
    const reader = chatStreamReader({ protocol }, () => {})
    for (const event of events) reader.event({ data: JSON.stringify(event) })
    assert.deepEqual(reader.usage(), expected, protocol)
    reader.finish()
  }
})

test('a stream without usage reports null rather than zero', () => {
  const reader = chatStreamReader({ protocol: 'completions' }, () => {})
  reader.event({ data: JSON.stringify({ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }) })
  assert.equal(reader.usage(), null)
  reader.finish()
})

test('only Chat Completions asks for usage in the stream', () => {
  const { providers } = restoreChatModels(null, null)
  const moonshot = providers.find(provider => provider.id === 'moonshotai-cn')
  const deepseek = providers.find(provider => provider.id === 'deepseek-official')
  const request = streamingChatRequest(moonshot, moonshot.models[0].id, 'fixture-key', [message('user')], '')
  assert.deepEqual(request.data.stream_options, { include_usage: true })
  const anthropic = streamingChatRequest(deepseek, deepseek.models[0].id, 'fixture-key', [message('user')], '')
  assert.equal(anthropic.data.stream_options, undefined)
})
