import assert from 'node:assert/strict'
import test from 'node:test'

globalThis.window = {}
const { chatKeysRecord, chatRequest, chatResponse, findChatModel, restoreChatKeys, restoreChatModels }
  = await import('./ui/chat-providers.js')

const history = [{ role: 'user', text: '早上好' }, { role: 'assistant', text: '你好' }]
const { providers } = restoreChatModels(null, null)

test('presets have a fixed endpoint, supported models and no login route', () => {
  assert.deepEqual(providers.map(provider => [provider.id, provider.endpoint]), [
    ['deepseek-official', 'https://api.deepseek.com/anthropic/v1/messages'],
    ['openai', 'https://api.openai.com/v1/responses'],
    ['anthropic', 'https://api.anthropic.com/v1/messages'],
    ['google', 'https://generativelanguage.googleapis.com/v1beta'],
    ['moonshotai-cn', 'https://api.moonshot.cn/v1/chat/completions'],
  ])
  assert.equal(findChatModel(providers, { provider: 'openai', model: 'manual-model' }), null)
  assert.equal(findChatModel(providers, { provider: 'deepseek-account', model: 'deepseek-flash' }), null)
})

test('sends known provider protocols and only reads visible response text', () => {
  const requests = Object.fromEntries(providers.map(provider =>
    [provider.id, chatRequest(provider, provider.models[0].id, 'fixture-key', history)]))
  assert.equal(requests['deepseek-official'].headers['x-api-key'], 'fixture-key')
  assert.deepEqual(requests['deepseek-official'].data.thinking, { type: 'disabled' })
  assert.equal(requests.anthropic.data.messages[0].content, '早上好')
  assert.equal(requests.anthropic.headers['anthropic-version'], '2023-06-01')
  assert.equal(requests.openai.data.input[1].role, 'assistant')
  assert.equal(requests.openai.data.store, false)
  assert.equal(requests.google.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent')
  assert.equal(requests.google.headers['x-goog-api-key'], 'fixture-key')
  assert.deepEqual(requests.google.data.contents[1], { role: 'model', parts: [{ text: '你好' }] })
  assert.equal(requests['moonshotai-cn'].token, 'fixture-key')

  const response = [
    { content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: '收到' }] },
    { output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: '收到' }] }] },
    { content: [{ type: 'text', text: '收到' }] },
    { candidates: [{ content: { parts: [{ text: 'hidden', thought: true }, { text: '收到' }] } }] },
    { choices: [{ message: { content: '收到' } }] },
  ]
  for (const [index, provider] of providers.entries()) assert.equal(chatResponse(provider, response[index]), '收到')
})

test('restores account-independent settings and keeps older custom endpoints read only', () => {
  const existing = restoreChatModels(null, { url: 'https://api.openai.com/v1/', model: 'gpt-4o-mini' })
  assert.deepEqual(existing.selection, { provider: 'openai', model: 'gpt-4o-mini' })
  assert.deepEqual(existing.migration, { provider: 'openai', target: 'https://api.openai.com/v1/' })
  assert.equal(existing.legacy, null)

  const record = { url: 'https://custom.invalid/v1', model: 'custom-model' }
  const custom = restoreChatModels(null, record)
  assert.equal(custom.legacy.endpoint, 'https://custom.invalid/v1/chat/completions')
  assert.equal(custom.selection.model, record.model)
  assert.equal(findChatModel(custom.providers, custom.selection).provider.requiresKey, false)
  assert.deepEqual(restoreChatModels({ selection: custom.selection, legacy: custom.legacy }, null).legacy, custom.legacy)
  assert.equal(restoreChatModels(null, { url: 'https://user:pwd@custom.invalid/v1', model: 'custom-model' }).selection, null)
})

test('uses the Harness reasoning wire format and includes images only on vision-capable routes', () => {
  const image = { name: 'tile.png', type: 'image/png', data: 'YQ==' }
  const turns = [{ role: 'user', text: '', attachments: [image] }]
  const deepseek = providers[0]
  const flash = chatRequest(deepseek, 'deepseek-flash', 'fixture-key', turns, 'max')
  assert.deepEqual(flash.data.thinking, { type: 'enabled' })
  assert.deepEqual(flash.data.output_config, { effort: 'max' })
  assert.deepEqual(flash.data.messages[0].content, [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YQ==' } },
  ])
  const pro = chatRequest(deepseek, 'deepseek-v4-pro', 'fixture-key', turns, 'off')
  assert.equal(pro.data.output_config, undefined)
  assert.equal(pro.data.messages[0].content, '[图片：tile.png]')
  assert.equal(chatRequest(providers[1], 'gpt-5.4', '', turns).data.input[0].content[0].type, 'input_image')
  assert.equal(chatRequest(providers[3], 'gemini-2.5-pro', '', turns).data.contents[0].parts[0].inlineData.data, 'YQ==')
})

test('remembers different keys separately and drops credentials bound to a different endpoint', () => {
  const keys = { openai: 'openai-dummy', anthropic: 'anthropic-dummy' }
  const saved = chatKeysRecord(keys, providers)
  assert.deepEqual(restoreChatKeys(saved, providers), keys)
  const wrongEndpoint = saved.replace('https://api.openai.com/v1/responses', 'https://custom.invalid/responses')
  assert.deepEqual(restoreChatKeys(wrongEndpoint, providers), { anthropic: 'anthropic-dummy' })
  assert.deepEqual(restoreChatKeys(chatKeysRecord({ openai: '' }, providers), providers), {})
})
