import { searchMode, searchTransport, sourceUrl } from './provider-search.js'
export { sourceUrl } from './provider-search.js'
import { completionUrl } from './http.js'

import { capabilities, groups, levels, official } from './harness-catalog.js'
export { levels as reasoningLevels }

const legacyId = 'saved-provider'
const apiVersion = '2023-06-01'
function models(entries, capabilities = {}) {
  return entries.map(([id, name, vision = false]) => ({ id, name, vision, ...capabilities }))
}

export const providerProtocols = {
  'openai-completions': 'completions',
  'openai-responses': 'responses',
  'anthropic-messages': 'anthropic',
  'google-generative-ai': 'gemini',
}

const effortChoices = ids => ids.map(id => ({ id, name: id[0].toUpperCase() + id.slice(1) }))
const builtIns = [{
  id: 'deepseek-official', name: 'DeepSeek', protocol: 'deepseek',
  endpoint: 'https://api.deepseek.com/anthropic/v1/messages',
  previousEndpoint: 'https://api.deepseek.com/v1/chat/completions',
  models: official.map(model => ({ ...model, vision: model.input.includes('image') })),
}, ...groups.map(([id, rows]) => {
  const models = rows.map(([id, name, index]) => {
    const route = capabilities[index]
    return { id, name, input: route.input, vision: route.input.includes('image'), route,
      ...(route.levels.length && { reasoning: { efforts: effortChoices(route.levels) } }) }
  })
  const route = models.find(model => model.route.endpoint)?.route ?? models[0]?.route
  const unavailable = !route?.endpoint
  return { id, name: id, models, api: route?.api, unavailable,
    protocol: providerProtocols[route?.api], endpoint: route?.endpoint ?? '',
    previousEndpoint: id === 'openai' ? 'https://api.openai.com/v1/chat/completions' : route?.endpoint }
})]

export function providerProtocol(provider) {
  if (provider.protocol === 'deepseek') return 'anthropic-messages'
  if (provider.api) return provider.api
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

function profileModel(row, override, preset, profile, protocol) {
  const settings = { ...row, ...override }
  const input = settings.input?.length ? settings.input : preset?.input ?? profile.defaultInput ?? (['completions', 'responses'].includes(protocol) ? ['text', 'image'] : ['text'])
  const mapping = settings.reasoningEfforts
  const efforts = mapping === undefined ? preset?.reasoning?.efforts :
    mapping && effortChoices(levels.filter(id => Object.hasOwn(mapping, id)))
  const preferred = profile.reasoning ?? preset?.reasoning?.defaultEffort
  return { ...preset, id: row.id, name: settings.name?.trim() || preset?.name || row.id,
    input, vision: input.includes('image'), mapping,
    reasoning: efforts?.length ? { efforts, defaultEffort: efforts.find(level => level.id === preferred)?.id } : undefined }
}

/** Overlay local provider profiles on the built-in catalog. */
export function configuredChatProviders(catalog, profiles) {
  const routes = new Map(catalog.map(provider => [provider.id, provider]))
  for (const [id, profile] of Object.entries(profiles)) {
    if (!profile || id === 'deepseek-account') continue
    const entry = routes.get(id)
    // An older custom route can share an id with a newly imported cloud provider.
    const customEndpoint = profile.baseURL && Object.hasOwn(providerProtocols, profile.api)
    if (entry?.unavailable && !customEndpoint) continue
    const preset = entry?.unavailable ? undefined : entry
    const api = profile.api || (preset && providerProtocol(preset))
    try {
      const protocol = preset && api === providerProtocol(preset) ? preset.protocol : providerProtocols[api]
      const endpoint = profile.baseURL ? providerEndpoint(profile.baseURL, api) : preset?.endpoint
      const rows = Array.isArray(profile.models) && profile.models.length > 0 ? profile.models : preset?.models
      if (!protocol || !endpoint || !rows?.every(row => typeof row?.id === 'string' && row.id.trim())) continue
      routes.set(id, {
        ...preset, id, protocol, endpoint, api,
        name: profile.displayName?.trim() || preset?.name || id,
        useCatalogRoutes: !!preset && endpoint === preset.endpoint && api === providerProtocol(preset),
        models: rows.map(row => profileModel(row, profile.modelOverrides?.[row.id],
          protocol === preset?.protocol ? preset.models.find(model => model.id === row.id) : undefined, profile, protocol)),
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
    models: models([[legacy.model, legacy.model, true]], { input: ['text', 'image'] }), requiresKey: false,
  }
}

/** Validate a saved provider/model pair against the current catalog. */
export function findChatModel(providers, selection) {
  const provider = providers.find(item => item.id === selection?.provider)
  const model = provider?.models.find(item => item.id === selection?.model)
  if (!model || provider.unavailable) return null
  if (model.route && provider.useCatalogRoutes !== false) {
    if (!model.route.endpoint) return null
    return { model, provider: { ...provider, endpoint: model.route.endpoint, protocol: providerProtocols[model.route.api] } }
  }
  return { provider, model }
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
  if (provider.unavailable) throw new Error('该提供商需要专用连接，手机暂不支持直连。')
  const level = capabilities?.reasoning?.efforts.find(item => item.id === reasoningEffort)?.id
    ?? capabilities?.reasoning?.defaultEffort ?? ''
  const useNativeWire = capabilities?.route && providerProtocols[capabilities.route.api] === provider.protocol
  const wire = capabilities?.mapping === undefined && useNativeWire ? { ...capabilities.route.wire[level] } : {}
  if (capabilities?.mapping !== undefined) {
    const value = capabilities.mapping?.[level]
    if (typeof value === 'string') {
      if (provider.protocol === 'responses') wire.reasoning = { effort: value }
      else if (provider.protocol === 'gemini') wire.generationConfig = { thinkingConfig: { thinkingLevel: value.toUpperCase(), includeThoughts: true } }
      else if (provider.protocol === 'anthropic') {
        wire.thinking = { type: 'adaptive' }
        wire.output_config = { effort: value }
      } else wire.reasoning_effort = value
    }
  }
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

  if (provider.protocol === 'gemini') {
    return {
      url: provider.endpoint + '/models/' + encodeURIComponent(model) + ':generateContent',
      headers: { 'x-goog-api-key': key },
      data: { ...wire, contents: turns.map(({ role, content, images }) => ({
        role: role === 'assistant' ? 'model' : 'user',
        parts: [...(content ? [{ text: content }] : []),
          ...images.map(({ type, data }) => ({ inlineData: { mimeType: type, data } }))],
      })) },
    }
  }
  if (provider.protocol === 'deepseek' || provider.protocol === 'anthropic') {
    const deepseek = provider.protocol === 'deepseek'
    const effort = level || 'off'
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
        ...wire,
        ...(deepseek && { thinking: { type: effort === 'off' ? 'disabled' : 'enabled' },
          ...(effort !== 'off' && { output_config: { effort } }) }),
      },
    }
  }
  return {
    url: provider.endpoint,
    token: key,
    data: provider.protocol === 'responses'
      ? { model, ...wire, input: withImages(text => ({ type: 'input_text', text }), ({ type, data }) =>
        ({ type: 'input_image', image_url: 'data:' + type + ';base64,' + data, detail: 'auto' })), store: false }
      : { model, ...wire, messages: withImages(text => ({ type: 'text', text }), ({ type, data }) =>
        ({ type: 'image_url', image_url: { url: 'data:' + type + ';base64,' + data } })).map((turn, i) => {
          if (turn.role !== 'assistant' || !capabilities?.route?.replay) return turn
          const source = history[i]
          const sameModel = source.reasoningEndpoint === provider.endpoint && source.reasoningModel === model
          return { ...turn, reasoning_content: sameModel ? source.reasoning || '' : '' }
        }) },
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

export function supportsWebSearch(provider, model) {
  return Boolean(searchMode(provider, model))
}

export function streamingChatRequest(provider, model, key, history, effort, webSearch = false, instructions = '') {
  const mode = webSearch ? searchMode(provider, model) : null
  if (webSearch && !mode) throw new Error('Web search is not supported by this model')
  provider = searchTransport(provider, mode)
  const request = chatRequest(provider, model, key, history, effort)
  switch (mode) {
    case 'deepseek':
      request.data.tools = model === 'deepseek-flash'
        ? [{ type: 'deepseek_web_search', name: 'deepseek_web_search' }]
        : [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }]
      break
    case 'openai-responses':
      request.data.tools = [{ type: 'web_search' }]
      request.data.include = ['web_search_call.action.sources']
      break
    case 'deepseek-responses':
    case 'responses': {
      request.data.tools = [{ type: mode === 'responses' ? 'web_search' : 'deepseek_web_search' }]
      const selected = provider.models.find(item => item.id === model)
      const wire = selected?.route?.wire[effort ?? ''] ?? {}
      if (wire.enable_thinking !== undefined) request.data.enable_thinking = wire.enable_thinking
      if (wire.reasoning_effort) request.data.reasoning = { effort: wire.reasoning_effort }
      break
    }
    case 'qwen':
      request.data.enable_search = true
      break
    case 'glm':
      request.data.tools = [{ type: 'web_search', web_search: { enable: true, search_result: true } }]
      break
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
    if (!request.data.generationConfig && /^gemini-(?:2\.5|[3-9])/.test(model)) request.data.generationConfig = { thinkingConfig: { includeThoughts: true } }
  } else request.data.stream = true
  if (provider.protocol === 'responses' && /^(?:gpt-5(?:\.\d+)?(?:-mini|-nano)?|o3|o4-mini)(?:-\d{4}-\d{2}-\d{2})?$/.test(model)) {
    request.data.reasoning = { ...request.data.reasoning, summary: 'auto' }
  }
  if (instructions) {
    if (provider.protocol === 'gemini') request.data.systemInstruction = { parts: [{ text: instructions }] }
    else if (['deepseek', 'anthropic'].includes(provider.protocol)) request.data.system = instructions
    else if (provider.protocol === 'responses') request.data.instructions = instructions
    else request.data.messages.unshift({ role: 'system', content: instructions })
  }
  return request
}

/** Deliver answer text and provider-exposed reasoning separately; signatures remain opaque. */
export function chatStreamReader(provider, onText, onSearch = () => {}, onReasoning = () => {}) {
  let completed = false
  let truncated = false
  let receivedResponseText = false
  const blocks = []
  const inputJson = new Map()
  const sources = new Map()
  const source = (item, cited = false) => {
    const url = sourceUrl(typeof item === 'string' ? item : item?.url ?? item?.link)
    if (!url) return
    const previous = sources.get(url)
    sources.set(url, { url, title: item.title || previous?.title || new URL(url).hostname,
      icon: sourceUrl(item.site_icon ?? item.icon ?? item.media) || previous?.icon || new URL('/favicon.ico', url).href,
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
      let text = '', reasoning = ''
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
          if (block?.type === 'thinking') reasoning = block.thinking
        }
        if (value.type === 'content_block_delta') {
          const block = blocks[value.index], delta = value.delta
          if (block && delta?.type === 'text_delta') block.text = (block.text || '') + delta.text
          if (block && delta?.type === 'thinking_delta') block.thinking = (block.thinking || '') + delta.thinking
          if (delta?.type === 'thinking_delta') reasoning = delta.thinking
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
        if (value.type === 'response.web_search_call.searching') onSearch({ status: '正在联网搜索…' })
        if (value.type === 'response.output_text.annotation.added') source(value.annotation, true)
        const items = value.response?.output ?? (value.item ? [value.item] : [])
        for (const item of items) {
          if (item.type === 'web_search_call') {
            item.action?.sources?.forEach(entry => source(entry))
            if (item.status === 'failed') onSearch({ failed: true, status: '搜索未成功' })
          }
          if (item.type === 'message') item.content?.forEach(part => part.annotations?.forEach(entry => source(entry, true)))
        }
        if (value.type === 'response.output_text.delta' && value.delta) {
          receivedResponseText = true
          text = value.delta
        }
        if (value.type === 'response.completed' && !receivedResponseText && value.response) {
          text = chatResponse(provider, value.response)
        }
        if (value.type === 'response.reasoning_summary_text.delta' || value.type === 'response.reasoning_text.delta') reasoning = value.delta
        if (value.type === 'response.reasoning_summary_part.added' && value.summary_index > 0) reasoning = '\n\n'
        if (value.type === 'response.completed') completed = true
      } else if (provider.protocol === 'gemini') {
        text = chatResponse(provider, value)
        reasoning = joinText(value.candidates?.[0]?.content?.parts?.filter(part => part.thought))
        if (value.candidates?.[0]?.finishReason) completed = true
      } else {
        const delta = value.choices?.[0]?.delta
        const results = value.web_search ?? delta?.web_search ?? value.search_info?.search_results ?? delta?.search_info?.search_results
        if (Array.isArray(results)) results.forEach(entry => source(entry))
        delta?.annotations?.forEach(entry => source(entry.url_citation ?? entry, true))
        const content = delta?.content
        text = typeof content === 'string' ? content : joinText(content)
        const thought = value.choices?.[0]?.delta?.reasoning_content ?? value.choices?.[0]?.delta?.reasoning
        reasoning = typeof thought === 'string' ? thought : ''
        if (value.choices?.[0]?.finish_reason) completed = true
      }
      if (typeof text === 'string' && text) onText(text)
      if (typeof reasoning === 'string' && reasoning) onReasoning(reasoning)
    },
    finish() {
      if (!completed) throw new Error('Model stream interrupted')
      return blocks.filter(Boolean)
    },
    canSaveMemory() { return completed && !truncated },
  }
}
