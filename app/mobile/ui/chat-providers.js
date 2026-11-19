import { completionUrl } from './http.js'

const legacyId = 'saved-provider'
const apiVersion = '2023-06-01'
const deepseekReasoning = {
  defaultEffort: 'off',
  efforts: ['off', 'low', 'high', 'max'].map(id => ({ id, name: id[0].toUpperCase() + id.slice(1) })),
}

function models(entries, capabilities = {}) {
  return entries.map(([id, name, vision = false]) => ({ id, name, vision, ...capabilities }))
}

// Defaults follow the DeepSeek Harness API-key catalog and its pi-ai providers.
const builtIns = [
  {
    id: 'deepseek-official', name: 'DeepSeek',
    endpoint: 'https://api.deepseek.com/anthropic/v1/messages', protocol: 'deepseek',
    previousEndpoint: 'https://api.deepseek.com/v1/chat/completions',
    models: models([['deepseek-flash', 'DeepSeek-V4.1-Flash', true], ['deepseek-v4-pro', 'DeepSeek-V4-Pro']], { reasoning: deepseekReasoning }),
  },
  {
    id: 'openai', name: 'OpenAI',
    endpoint: 'https://api.openai.com/v1/responses', protocol: 'responses',
    previousEndpoint: 'https://api.openai.com/v1/chat/completions',
    models: models([['gpt-5.4-mini', 'GPT-5.4 mini', true], ['gpt-5.4', 'GPT-5.4', true],
      ['gpt-5-mini', 'GPT-5 mini', true], ['gpt-4o-mini', 'GPT-4o mini', true]]),
  },
  {
    id: 'anthropic', name: 'Anthropic',
    endpoint: 'https://api.anthropic.com/v1/messages', protocol: 'anthropic',
    models: models([['claude-haiku-4-5', 'Claude Haiku 4.5', true], ['claude-sonnet-4-6', 'Claude Sonnet 4.6', true],
      ['claude-opus-4-6', 'Claude Opus 4.6', true]]),
  },
  {
    id: 'google', name: 'Gemini',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta', protocol: 'gemini',
    models: models([['gemini-3.5-flash', 'Gemini 3.5 Flash', true], ['gemini-2.5-flash', 'Gemini 2.5 Flash', true],
      ['gemini-2.5-pro', 'Gemini 2.5 Pro', true]]),
  },
  {
    id: 'moonshotai-cn', name: 'Kimi',
    endpoint: 'https://api.moonshot.cn/v1/chat/completions', protocol: 'kimi',
    previousEndpoint: 'https://api.moonshot.cn/v1/chat/completions',
    models: models([['kimi-k2.6', 'Kimi K2.6']]),
  },
]

export const providerProtocols = {
  'openai-completions': 'completions',
  'openai-responses': 'responses',
  'anthropic-messages': 'anthropic',
  'google-generative-ai': 'gemini',
}

export function providerProtocol(provider) {
  if (provider.protocol === 'deepseek') return 'anthropic-messages'
  if (provider.protocol === 'kimi') return 'openai-completions'
  return Object.keys(providerProtocols).find(api => providerProtocols[api] === provider.protocol)
}

export function providerEndpoint(base, api) {
  const protocol = providerProtocols[api]
  if (protocol === 'completions') return completionUrl(base)
  if (!protocol) throw new Error('该 API 协议不可用。')
  const url = new URL(base)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('API 地址格式不正确。')
  }
  url.pathname = url.pathname.replace(/\/+$/, '')
  if (protocol === 'gemini') {
    if (url.pathname === '/') url.pathname = '/v1beta'
  } else {
    if (url.pathname === '/') url.pathname = '/v1'
    const suffix = protocol === 'responses' ? '/responses' : '/messages'
    if (!url.pathname.endsWith(suffix)) url.pathname += suffix
  }
  return url.toString()
}

/** Overlay local provider profiles on the built-in catalog. */
export function configuredChatProviders(catalog, profiles) {
  const routes = new Map(catalog.map(provider => [provider.id, provider]))
  for (const [id, profile] of Object.entries(profiles)) {
    if (!profile || id === 'deepseek-account') continue
    const preset = routes.get(id)
    const api = profile.api || (preset && providerProtocol(preset))
    try {
      const protocol = preset && api === providerProtocol(preset) ? preset.protocol : providerProtocols[api]
      const endpoint = profile.baseURL ? providerEndpoint(profile.baseURL, api) : preset?.endpoint
      const rows = Array.isArray(profile.models) && profile.models.length > 0 ? profile.models : preset?.models
      if (!protocol || !endpoint || !rows?.every(row => typeof row?.id === 'string' && row.id.trim())) continue
      routes.set(id, {
        ...preset, id, protocol, endpoint,
        name: profile.displayName?.trim() || preset?.name || id,
        models: rows.map(row => ({
          ...(protocol === preset?.protocol && preset.models.find(model => model.id === row.id)),
          id: row.id, name: row.name?.trim() || row.id,
        })),
        requiresKey: preset?.requiresKey ?? !(!preset && protocol === 'completions'),
      })
    } catch {
      // Malformed stored overrides cannot select a different credential endpoint.
    }
  }
  return [...routes.values()]
}

function legacyConfiguration(record) {
  if (typeof record?.url !== 'string' || typeof record?.model !== 'string'
    || !record.model.trim() || record.model.length > 250) return null
  try {
    return { endpoint: completionUrl(record.url), model: record.model }
  } catch {
    return null
  }
}

function legacyProvider(legacy) {
  return {
    id: legacyId, name: '已配置接口', protocol: 'completions', endpoint: legacy.endpoint,
    models: models([[legacy.model, legacy.model]]), requiresKey: false,
  }
}

/** Validate a saved provider/model pair against the current catalog. */
export function findChatModel(providers, selection) {
  const provider = providers.find(item => item.id === selection?.provider)
  const model = provider?.models.find(item => item.id === selection?.model)
  return model ? { provider, model } : null
}

/** Preserve earlier endpoints without offering creation or editing of URLs. */
export function restoreChatModels(saved, oldSettings) {
  const prior = legacyConfiguration(oldSettings)
  const storedLegacy = legacyConfiguration({ url: saved?.legacy?.endpoint, model: saved?.legacy?.model })
  let legacy = storedLegacy
  let selection = saved?.selection ?? null
  let migration = null
  if (!saved && prior) {
    const matched = builtIns.find(provider => provider.previousEndpoint === prior.endpoint
      && provider.models.some(model => model.id === prior.model))
    legacy = matched ? null : prior
    selection = { provider: matched?.id ?? legacyId, model: prior.model }
    migration = { provider: selection.provider, target: oldSettings.url }
  }
  const providers = legacy ? [...builtIns, legacyProvider(legacy)] : builtIns
  if (!findChatModel(providers, selection)) selection = null
  return { providers, selection, legacy, migration }
}

/** Keep saved keys tied to exactly one preset and its expected endpoint. */
export function restoreChatKeys(raw, providers) {
  let saved
  try { saved = JSON.parse(raw) } catch { return {} }
  return Object.fromEntries(providers.flatMap(({ id, endpoint }) => {
    const credential = saved?.[id]
    return credential?.endpoint === endpoint && typeof credential.key === 'string' && credential.key
      ? [[id, credential.key]] : []
  }))
}

/** Serialize device credentials for the existing encrypted storage slot. */
export function chatKeysRecord(keys, providers) {
  return JSON.stringify(Object.fromEntries(providers.flatMap(({ id, endpoint }) =>
    keys[id] ? [[id, { endpoint, key: keys[id] }]] : [])))
}

/** Translate local turns to the provider's public API format. */
export function chatRequest(provider, model, key, history, reasoningEffort) {
  const capabilities = provider.models.find(item => item.id === model)
  let imageBudget = 3 * 1024 * 1024
  const turns = [...history].reverse().map(({ role, text, attachments }) => {
    const images = []
    const omitted = []
    for (const image of attachments ?? []) {
      if (capabilities?.vision && image.data && image.data.length <= imageBudget) {
        imageBudget -= image.data.length
        images.push(image)
      } else {
        omitted.push(image.name)
      }
    }
    const content = [text, ...omitted.map(name => '[图片：' + name + ']')].filter(Boolean).join('\n')
    return { role, content, images }
  }).reverse()
  const withImages = (text, image) => turns.map(({ role, content, images }) => ({
    role, content: images.length ? [...(content ? [text(content)] : []), ...images.map(image)] : content,
  }))
  const messages = turns.map(({ role, content }) => ({ role, content }))
  if (provider.protocol === 'gemini') {
    return {
      url: provider.endpoint + '/models/' + encodeURIComponent(model) + ':generateContent',
      headers: { 'x-goog-api-key': key },
      data: { contents: turns.map(({ role, content, images }) => ({
        role: role === 'assistant' ? 'model' : 'user',
        parts: [...(content ? [{ text: content }] : []),
          ...images.map(({ type, data }) => ({ inlineData: { mimeType: type, data } }))],
      })) },
    }
  }
  if (provider.protocol === 'deepseek' || provider.protocol === 'anthropic') {
    const deepseek = provider.protocol === 'deepseek'
    const effort = capabilities?.reasoning?.efforts.some(level => level.id === reasoningEffort) ? reasoningEffort : 'off'
    return {
      url: provider.endpoint,
      headers: {
        'x-api-key': key,
        'anthropic-version': apiVersion,
        ...(!deepseek && { 'anthropic-dangerous-direct-browser-access': 'true' }),
      },
      data: {
        model,
        messages: withImages(text => ({ type: 'text', text }), ({ type, data }) =>
          ({ type: 'image', source: { type: 'base64', media_type: type, data } })),
        max_tokens: deepseek && effort !== 'off' ? 16384 : 4096,
        ...(deepseek && { thinking: { type: effort === 'off' ? 'disabled' : 'enabled' },
          ...(effort !== 'off' && { output_config: { effort } }) }),
      },
    }
  }
  return {
    url: provider.endpoint,
    token: key,
    data: provider.protocol === 'responses'
      ? { model, input: withImages(text => ({ type: 'input_text', text }), ({ type, data }) =>
        ({ type: 'input_image', image_url: 'data:' + type + ';base64,' + data, detail: 'auto' })), store: false }
      : { model, messages, ...(provider.protocol === 'kimi' && { thinking: { type: 'disabled' } }) },
  }
}

function joinText(parts) {
  return Array.isArray(parts) ? parts.map(part => typeof part?.text === 'string' ? part.text : '').join('') : ''
}

/** Extract the visible answer without rendering hidden reasoning blocks. */
export function chatResponse(provider, result) {
  if (provider.protocol === 'gemini') {
    return joinText(result.candidates?.[0]?.content?.parts?.filter(part => !part.thought))
  }
  if (provider.protocol === 'deepseek' || provider.protocol === 'anthropic') {
    return joinText(result.content?.filter(part => part.type === 'text'))
  }
  if (provider.protocol === 'responses') {
    return joinText(result.output?.filter(item => item.type === 'message')
      .flatMap(item => item.content?.filter(part => part.type === 'output_text') ?? []))
  }
  const content = result.choices?.[0]?.message?.content
  return typeof content === 'string' ? content : joinText(content)
}

/** Native search is available on these DeepSeek Messages routes. */
export function supportsWebSearch(provider, model) {
  return provider?.protocol === 'deepseek' && ['deepseek-flash', 'deepseek-v4-pro'].includes(model)
}

export function sourceUrl(value) {
  try {
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null
  } catch { return null }
}

export function streamingChatRequest(provider, model, key, history, effort, webSearch = false, instructions = '') {
  const request = chatRequest(provider, model, key, history, effort)
  if (webSearch) {
    if (!supportsWebSearch(provider, model)) throw new Error('Web search is not supported by this model')
    request.data.tools = model === 'deepseek-flash'
      ? [{ type: 'deepseek_web_search', name: 'deepseek_web_search' }]
      : [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }]
  }
  if (provider.protocol === 'deepseek') {
    request.data.messages.forEach((turn, index) => {
      const previous = history[index]
      if (previous.role === 'assistant' && previous.nativeReply?.endpoint === provider.endpoint
        && previous.nativeReply?.model === model && !previous.interrupted) turn.content = previous.nativeReply.content
    })
  }
  if (provider.protocol === 'gemini') {
    request.url = request.url.replace(':generateContent', ':streamGenerateContent') + '?alt=sse'
  } else request.data.stream = true
  if (instructions) {
    if (provider.protocol === 'gemini') request.data.systemInstruction = { parts: [{ text: instructions }] }
    else if (['deepseek', 'anthropic'].includes(provider.protocol)) request.data.system = instructions
    else if (provider.protocol === 'responses') request.data.instructions = instructions
    else request.data.messages.unshift({ role: 'system', content: instructions })
  }
  return request
}

/** Only visible text deltas reach the transcript; reasoning stays separate. */
export function chatStreamReader(provider, onText, onSearch = () => {}) {
  let completed = false
  let truncated = false
  const blocks = []
  const inputJson = new Map()
  const sources = new Map()
  const source = (item, cited = false) => {
    const url = sourceUrl(item?.url)
    if (!url) return
    const previous = sources.get(url)
    sources.set(url, { url, title: item.title || previous?.title || new URL(url).hostname,
      icon: sourceUrl(item.site_icon) || previous?.icon || new URL('/favicon.ico', url).href,
      cited: cited || Boolean(previous?.cited) })
    onSearch({ sources: [...sources.values()] })
  }
  return {
    event({ data }) {
      if (data === '[DONE]') { completed = true; return }
      const value = JSON.parse(data)
      if (['max_tokens', 'length', 'MAX_TOKENS'].includes(value.delta?.stop_reason || value.choices?.[0]?.finish_reason || value.candidates?.[0]?.finishReason)) truncated = true
      if (value.error || ['error', 'response.failed', 'response.incomplete'].includes(value.type)) {
        throw new Error('Model stream failed')
      }
      let text = ''
      if (provider.protocol === 'deepseek' || provider.protocol === 'anthropic') {
        if (value.type === 'content_block_start') {
          const block = value.content_block
          blocks[value.index] = structuredClone(block)
          if (block?.type === 'server_tool_use') onSearch({ status: '正在联网搜索…' })
          if (block?.type === 'web_search_tool_result') {
            const results = Array.isArray(block.content) ? block.content : [block.content]
            const failed = results.some(item => item?.type === 'web_search_tool_result_error')
            onSearch({ status: failed ? '搜索未成功，正在生成回复…' : '搜索完成，正在生成回复…', failed })
            results.forEach(item => source(item))
          }
          if (block?.type === 'text') block.citations?.forEach(item => source(item, true))
        }
        if (value.type === 'content_block_delta') {
          const block = blocks[value.index], delta = value.delta
          if (block && delta?.type === 'text_delta') block.text = (block.text || '') + delta.text
          if (block && delta?.type === 'thinking_delta') block.thinking = (block.thinking || '') + delta.thinking
          if (block && delta?.type === 'signature_delta') block.signature = (block.signature || '') + delta.signature
          if (delta?.type === 'input_json_delta') inputJson.set(value.index, (inputJson.get(value.index) || '') + delta.partial_json)
          if (delta?.type === 'citations_delta') {
            if (block) (block.citations ??= []).push(delta.citation)
            source(delta.citation, true)
          }
        }
        if (value.type === 'content_block_stop' && inputJson.has(value.index)) {
          blocks[value.index].input = JSON.parse(inputJson.get(value.index))
          inputJson.delete(value.index)
        }
        if (value.type === 'content_block_delta' && value.delta?.type === 'text_delta') text = value.delta.text
        if (value.type === 'content_block_start' && value.content_block?.type === 'text') text = value.content_block.text
        if (value.type === 'message_stop') completed = true
      } else if (provider.protocol === 'responses') {
        if (value.type === 'response.output_text.delta') text = value.delta
        if (value.type === 'response.completed') completed = true
      } else if (provider.protocol === 'gemini') {
        text = chatResponse(provider, value)
        if (value.candidates?.[0]?.finishReason) completed = true
      } else {
        const content = value.choices?.[0]?.delta?.content
        text = typeof content === 'string' ? content : joinText(content)
        if (value.choices?.[0]?.finish_reason) completed = true
      }
      if (typeof text === 'string' && text) onText(text)
    },
    finish() {
      if (!completed) throw new Error('Model stream interrupted')
      return blocks.filter(Boolean)
    },
    canSaveMemory() { return completed && !truncated },
  }
}
