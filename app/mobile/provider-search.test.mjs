import assert from 'node:assert/strict'
import test from 'node:test'

globalThis.window = {}
const { configuredChatProviders, restoreChatModels, streamingChatRequest, chatStreamReader } = await import('./ui/chat-providers.js')
const { searchMode, lookupSources, withSearchResults } = await import('./ui/provider-search.js')
const official = restoreChatModels().providers
const image = { name: 'pic.png', type: 'image/png', data: 'YQ==' }
const question = [{ role: 'user', text: '查询', attachments: [image] }]
const route = (endpoint, protocol = 'completions') => ({ endpoint, protocol, models: [] })

test('Qwen Token Plan uses Responses for search, preserving image and requested effort; GLM Chat uses its own tool', () => {
  const qwen = official.find(p => p.id === 'qwen-token-plan-cn')
  const run = enabled => streamingChatRequest(qwen, 'qwen3.8-flash', 'fixture', question, 'medium', enabled)
  assert.match(run(false).url, /chat\/completions$/)
  assert(!run(false).data.tools)
  const search = run(true)
  assert.match(search.url, /\/v1\/responses$/)
  assert.equal(search.data.tools[0].type, 'web_search')
  assert.equal(search.data.reasoning.effort, 'medium')
  assert.equal(search.data.input[0].content[1].type, 'input_image')
  const dash = route('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions')
  assert.equal(streamingChatRequest(dash, 'qwen-plus', '', question, '', true).data.enable_search, true)
  const glm = route('https://open.bigmodel.cn/api/paas/v4/chat/completions')
  assert.deepEqual(streamingChatRequest(glm, 'glm-5', '', question, '', true).data.tools, [
    { type: 'web_search', web_search: { enable: true, search_result: true } },
  ])
  assert.equal(searchMode(route('https://unrelated.invalid/v1/chat/completions'), 'glm-5'), null)
})

test('Responses tools, untrusted annotations and final-only source lists use the shared source sheet', () => {
  for (const endpoint of ['https://api.openai.com/v1/responses', 'http://localhost:3333/v1/responses']) {
    const p = route(endpoint, 'responses')
    assert.equal(searchMode(p, 'my-model'), 'openai-responses')
    assert.equal(streamingChatRequest(p, 'my-model', '', question, '', false).data.tools, undefined)
    const req = streamingChatRequest(p, 'my-model', '', question, '', true)
    assert.equal(req.url, endpoint)
    assert.deepEqual(req.data.tools, [{ type: 'web_search' }])
    assert.deepEqual(req.data.include, ['web_search_call.action.sources'])
    let sources, answer = ''
    const reader = chatStreamReader(p, text => { answer += text }, event => { if (event.sources) sources = event.sources })
    const push = data => reader.event({ data: JSON.stringify(data) })
    push({ type: 'response.output_text.annotation.added', annotation: { type: 'url_citation', url: 'https://a.test', title: '出处' } })
    push({ type: 'response.output_text.delta', delta: '答案' })
    push({ type: 'response.completed', response: { output: [{ type: 'web_search_call', action: {
      sources: [{ url: 'https://a.test' }, { url: 'https://b.test' }, { url: 'javascript:alert(1)' }],
    } }] } })
    reader.finish()
    assert.equal(answer, '答案')
    assert.equal(sources.length, 2)
    assert.equal(sources[0].title, '出处')
    assert.equal(sources[0].cited, true)
  }
})

test('custom OpenAI protocols and legacy routes support real image blocks; explicit text-only stays text-only', () => {
  for (const api of ['openai-completions', 'openai-responses']) {
    const p = configuredChatProviders(official, { custom: { api, baseURL: 'https://proxy.invalid/v1',
      models: [{ id: 'vision' }, { id: 'text', input: ['text'] }] } }).find(p => p.id === 'custom')
    assert.deepEqual(p.models.map(m => m.vision), [true, false])
    const data = streamingChatRequest(p, 'vision', '', question).data
    assert.match(JSON.stringify(data), /data:image\/png;base64,YQ==/)
    assert(!JSON.stringify(streamingChatRequest(p, 'text', '', question).data).includes('base64'))
  }
  assert.equal(restoreChatModels(null, { url: 'https://proxy.invalid/v1', model: 'legacy' }).providers.at(-1).models[0].vision, true)
})

test('Kimi search and GLM Coding MCP use same-origin credentials, bound results and handle JSON or SSE', async t => {
  let calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const data = options.body && JSON.parse(options.body)
    calls.push({ url, data, method: options.method })
    assert.equal(options.headers.Authorization, 'Bearer fixture')
    const rows = [{ title: '资料', link: 'https://a.test', content: '网页摘要' }, { url: 'data:text/plain,invalid' }]
    if (url.includes('/mcp/')) {
      if (data?.method === 'initialize') return Response.json({ id: 1, result: { protocolVersion: '2025-03-26' } }, { headers: { 'Mcp-Session-Id': 'session' } })
      assert.equal(options.headers['Mcp-Session-Id'], 'session')
      if (data?.method === 'tools/call') {
        assert.equal(data.params.name, 'webSearchPrime')
        return new Response('data: ' + JSON.stringify({ id: 2, result: { content: [{ type: 'text', text: JSON.stringify(rows) }] } }) + '\n\n')
      }
      return new Response(null, { status: 202 })
    }
    return Response.json({ search_results: rows })
  })
  for (const [host, path, lookup] of [['api.kimi.com','/coding/v1','/coding/v1/search'],['api.moonshot.cn','/v1','/v1/tools/search'],['open.bigmodel.cn','/api/coding/paas/v4','/api/mcp/web_search_prime/mcp']]) {
    calls = []
    const p = route('https://' + host + path + '/chat/completions')
    const mode = searchMode(p, host.includes('bigmodel') ? 'glm-5.3' : 'kimi-k3')
    const rows = await lookupSources(mode, p, 'fixture', '查询', new AbortController().signal)
    assert(calls.every(call => call.url === 'https://' + host + lookup))
    assert.equal(rows.length, 1)
    assert.match(withSearchResults(question, rows)[0].text, /网页摘要/)
    assert.equal(question[0].text, '查询')
    if (mode === 'glm-code') assert.equal(calls.at(-1).method, 'DELETE')
    else assert.equal(calls[0].data.text_query, '查询')
  }
})
