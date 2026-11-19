import assert from 'node:assert/strict'
import test from 'node:test'
globalThis.window = {}
const { restoreChatModels, streamingChatRequest, chatStreamReader, sourceUrl, supportsWebSearch } = await import('./ui/chat-providers.js')
const provider = restoreChatModels(null, null).providers[0]

test('DeepSeek search is opt-in, model-specific and not sent to unrelated providers', () => {
  const request = (model, enabled) => streamingChatRequest(provider, model, 'fixture', [], 'high', enabled)
  assert.equal(request('deepseek-flash', false).data.tools, undefined)
  assert.equal(request('deepseek-flash', true).data.tools[0].type, 'deepseek_web_search')
  assert.equal(request('deepseek-v4-pro', true).data.tools[0].type, 'web_search_20250305')
  assert.equal(supportsWebSearch({ protocol: 'completions' }, 'deepseek-flash'), false)
  assert.throws(() => request('unsupported', true), /not supported/)
})

test('search stream retains cited sources, rejects unsafe URLs and preserves native history', () => {
  let text = '', sources = [], status = ''
  const reader = chatStreamReader(provider, part => { text += part }, update => {
    if (update.sources) sources = update.sources
    if (update.status) status = update.status
  })
  const event = value => reader.event({ data: JSON.stringify(value) })
  event({ type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'search1', name: 'deepseek_web_search', input: {}, kind: 'search' } })
  assert.match(status, /正在联网搜索/)
  event({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"queries":["test"]}' } })
  event({ type: 'content_block_stop', index: 0 })
  event({ type: 'content_block_start', index: 1, content_block: { type: 'web_search_tool_result', tool_use_id: 'search1', content: [
    { type: 'web_search_result', url: 'https://example.com/a?q=test', title: 'Example', site_icon: 'https://example.com/favicon.ico', encrypted_content: 'fixture' },
    { type: 'web_search_result', url: 'javascript:alert(1)', title: 'Unsafe' },
  ] } })
  event({ type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } })
  event({ type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: '查询结果。' } })
  event({ type: 'content_block_delta', index: 2, delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', url: 'https://example.com/a?q=test', title: null } } })
  event({ type: 'message_stop' })
  const content = reader.finish()
  assert.equal(text, '查询结果。')
  assert.equal(sources.length, 1)
  assert.equal(sources[0].title, 'Example')
  assert.equal(sources[0].cited, true)
  assert.deepEqual(content[0].input, { queries: ['test'] })
  const history = [{ role: 'assistant', text, nativeReply: { endpoint: provider.endpoint, model: 'deepseek-flash', content } }]
  assert.deepEqual(streamingChatRequest(provider, 'deepseek-flash', '', history).data.messages[0].content, content)
  assert.equal(streamingChatRequest(provider, 'deepseek-v4-pro', '', history).data.messages[0].content, text)
  assert.equal(sourceUrl('https://user:secret@example.com'), null)
  assert.equal(sourceUrl('data:text/html,unsafe'), null)
})

test('failed search is reported without inventing sources or losing the model reply', () => {
  let failed = false
  const reader = chatStreamReader(provider, () => {}, update => { failed ||= update.failed })
  reader.event({ data: JSON.stringify({ type: 'content_block_start', index: 0, content_block: {
    type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: 'unavailable' },
  } }) })
  assert.equal(failed, true)
  assert.throws(() => reader.finish(), /interrupted/)
})
