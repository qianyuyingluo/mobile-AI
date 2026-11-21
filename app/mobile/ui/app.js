import { readSecret, requestJson, requestStream, saveSecret, workOrigin } from './http.js'
import { chatKeysRecord, streamingChatRequest, chatStreamReader, configuredChatProviders, findChatModel, restoreChatKeys, restoreChatModels } from './chat-providers.js'
import { createImageViewer } from './image-viewer.js'
import { createReadingNavigation } from './reading-navigation.js'
import { mountDesktopLibrary } from './desktop-library.js'
import { desktopHistory, desktopRequestId } from './desktop-history.js'
import { animateDialog } from './panel-motion.js'
import { brand } from './brand.js'
import { createChatMemory, memoryInstructions, memoryStream, cleanMemoryBlocks } from './chat-memory.js'
import { searchMode, searchTransport, lookupSources, requiresSearchLookup, withSearchResults } from './provider-search.js'
import { supportsWebSearch, sourceUrl } from './chat-providers.js'

const $ = id => document.getElementById(id)
const transcript = $('transcript')
const thread = $('thread')
const prompt = $('prompt')
const animation = $('animation')
const dark = matchMedia('(prefers-color-scheme: dark)')
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
const workSettings = $('work-settings')
const scanDialog = $('scan-dialog')
const scanPreview = $('scan-preview')
const desktopPairing = $('computer-pairing')
const desktopControl = location.pathname === '/control'
let desktopAddresses = []
let scanController
const picker = $('agent-picker')
const sidebar = $('sidebar')
animateDialog(sidebar, { drawer: true })
for (const id of ['work-settings', 'computer-pairing', 'chat-memory']) animateDialog($(id))
const viewImages = createImageViewer($('image-viewer'))
const deleteDialog = $('delete-session')
const relativeDate = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' })
const agentNames = { codex: 'Codex', deepseek: 'DeepSeek Harness', neko: brand.assistant }
const runLabels = { idle: '就绪', running: '执行中', failed: '执行失败', cancelled: '已停止' }
const settingsKey = 'yingluo.chat.settings.v2'
const previousSettingsKey = 'yingluo.chat.settings.v1'
const chatKeysTarget = 'yingluo.chat.providers.v2'
const historyKey = 'yingluo.chat.history.v1'
const connectionKey = 'yingluo.work.connection.v1'
const savedModels = read(settingsKey, null)
const restored = restoreChatModels(savedModels, read(previousSettingsKey, null))
const { providers: catalog, legacy, migration } = restored
let profiles = savedModels?.profiles ?? {}
let providers = configuredChatProviders(catalog, profiles)
let selection = savedModels?.selection ?? restored.selection
let chatKeys = restoreChatKeys(readSecret('chatApiKey', chatKeysTarget), providers)
let modelPicker
let workEffortPicker
let modelSettings
let modelPickerLoading
let renderMarkdownMessages
let decodeQr
let unmountMarkdown
let pendingDeletion
let draftingWork = false
let webSearchEnabled = read('yingluo.web-search.v1', false) === true
let searchStatus = ''
let searchToastTimer
let composerExpanded = false
let composerEditing = false

let mode = 'chat'
const chatMemory = createChatMemory(localStorage)
const drafts = { chat: '', work: '' }
const attachments = { chat: [], work: [] }
const readingFiles = { chat: false, work: false }
const imageTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
const MiB = 1024 * 1024
let workEffort = ''
const chat = { ...read(historyKey, { sessions: [], selected: '' }), run: null, error: '' }
const savedConnection = read(connectionKey, { origin: '', selected: '' })
const work = {
  ...savedConnection,
  token: readSecret('workToken', savedConnection.origin),
  canResume: true,
  summary: null,
  session: null,
  action: '',
  error: '',
  deleteError: '',
}
let poll = null
let pollTimer = null
let loadingDesktopHistory = false
let threadKey = ''
let threadStructure = ''
let mountedRichMessages = []
let contextKey = ''
let sidebarKey = ''
let resetScroll = true
const readingNavigation = createReadingNavigation({ transcript, thread,
  host: $('question-navigation'), bottom: $('scroll-bottom') })

function read(key, fallback) {
  try {
    const value = localStorage.getItem(key)
    return value ? JSON.parse(value) : fallback
  } catch {
    return fallback
  }
}

function store(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // The current app session remains usable when storage is unavailable.
  }
}

function persistChat() {
  let imageBudget = 2 * MiB
  const sessions = [...chat.sessions].sort((a, b) => Number(b.id === chat.selected) - Number(a.id === chat.selected))
  const byId = new Map(sessions.map(session => [session.id, {
    ...session,
    messages: [...session.messages].reverse().map(({ streaming, ...message }) => message.attachments ? {
      ...message,
      attachments: message.attachments.map(({ name, type, data }) => {
        if (!data || data.length > imageBudget) return { name, type }
        imageBudget -= data.length
        return { name, type, data }
      }),
    } : message).reverse(),
  }]))
  store(historyKey, { sessions: chat.sessions.map(session => byId.get(session.id)), selected: chat.selected })
}

function persistChatModel() {
  store(settingsKey, { selection, legacy, profiles })
}

if (migration) {
  const previousKey = readSecret('chatApiKey', migration.target)
  if (previousKey) chatKeys[migration.provider] = previousKey
  if (!previousKey || saveSecret('chatApiKey', chatKeysRecord(chatKeys, providers), chatKeysTarget)) {
    persistChatModel()
  }
}

function selectedChatModel() {
  return findChatModel(providers, selection)
}

function chatReady() {
  const selected = selectedChatModel()
  return Boolean(selected && (selected.provider.requiresKey === false || chatKeys[selected.provider.id]))
}

function persistConnection() {
  store(connectionKey, { origin: work.token && work.canResume ? work.origin : '', selected: work.selected,
    desktop: work.desktop })
}

function node(tag, text, className) {
  const element = document.createElement(tag)
  if (text) element.textContent = text
  if (className) element.className = className
  return element
}

function button(label, handler, className = 'control') {
  const control = node('button', label, className)
  control.type = 'button'
  control.addEventListener('click', handler)
  return control
}

function feedback(element, text) {
  element.textContent = text
  element.hidden = !text
}

function redact(text = '') {
  let visible = text
  for (const secret of [...Object.values(chatKeys), work.token]) {
    if (secret) visible = visible.replaceAll(secret, '••••')
  }
  return visible
}

function chatSession() {
  return chat.sessions.find(session => session.id === chat.selected)
}

function newChat() {
  const id = crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint32Array(4)), value => value.toString(36)).join('-')
  const session = { id, title: '新聊天', updatedAt: Date.now(), messages: [] }
  chat.sessions.unshift(session)
  selectChat(session.id)
  return session
}

function beginNewConversation() {
  if (work.action) return
  sidebar.close()
  stopPolling()
  chat.selected = ''
  chat.error = ''
  work.selected = ''
  work.desktop = null
  work.session = null
  work.error = ''
  draftingWork = true
  for (const target of ['chat', 'work']) { drafts[target] = ''; attachments[target] = [] }
  prompt.value = ''
  composerEditing = false
  prompt.blur()
  workEffort = ''
  setComposerExpanded(false)
  resetScroll = true
  persistChat()
  persistConnection()
  render()
  if (mode === 'work') refreshWork()
}

function chooseDraftMode(next) {
  if ($('draft-modes').hidden || next === mode) return
  // A new draft must never fall back to a previous conversation in the other mode.
  if (next === 'work' && (!work.session || work.session.messages.length)) {
    work.selected = ''; work.session = null; draftingWork = true
    persistConnection()
  } else if (next === 'chat' && chatSession()?.messages.length) {
    chat.selected = ''; persistChat()
  }
  setMode(next)
}

function selectChat(id) {
  chat.selected = id
  chat.error = ''
  resetScroll = true
  persistChat()
  render()
}

function linked() {
  return Boolean(work.origin && work.token)
}

function saveDraft(value) {
  drafts[mode] = value
  prompt.value = value
  resizePrompt()
  updateComposerActions()
}

function updateComposerActions() {
  const pendingFiles = attachments[mode].length > 0 && !(mode === 'work' && work.action)
  document.querySelector('.composer-actions').hidden = !(composerEditing || prompt.value.length || pendingFiles || composerExpanded)
}

function resizePrompt() {
  if (composerExpanded) return
  const scroll = prompt.scrollTop
  prompt.style.height = '0px'
  const limit = Math.min(152, Math.max(72, innerHeight * .24))
  prompt.style.height = Math.min(limit, Math.max(44, prompt.scrollHeight)) + 'px'
  prompt.scrollTop = scroll
  updateComposerActions()
}

function setComposerExpanded(expanded, focus = false) {
  const start = prompt.selectionStart, end = prompt.selectionEnd, scroll = prompt.scrollTop
  composerExpanded = expanded
  document.querySelector('.app').toggleAttribute('data-composer-expanded', expanded)
  const label = expanded ? '收起输入框' : '展开输入框'
  $('expand-prompt').setAttribute('aria-label', label)
  $('expand-prompt').title = label
  $('expand-prompt').querySelector('use').setAttribute('href', expanded ? '#dsw-icon-chevron-down-outline-regular' : '#dsw-icon-fullscreen-outline-regular')
  $('expand-prompt').setAttribute('aria-expanded', String(expanded))
  prompt.style.height = ''
  resizePrompt()
  if (focus) { prompt.focus({ preventScroll: true }); prompt.setSelectionRange(start, end) }
  prompt.scrollTop = scroll
  updateComposerActions()
}

function setMode(next) {
  if (next === mode) return
  composerEditing = false
  if (next === 'work') modelPicker?.close()
  if (next === 'work') modelSettings?.close()
  drafts[mode] = prompt.value
  mode = next
  if (desktopControl) $('open-settings').textContent = next === 'work' ? '手机配对' : '设置'
  prompt.value = drafts[next]
  resizePrompt()
  resetScroll = true
  $('chat-history').setAttribute('aria-pressed', String(next === 'chat'))
  $('work-history').setAttribute('aria-pressed', String(next === 'work'))
  render()
  if (next === 'work') refreshWork()
  else stopPolling()
}

function updateModelPicker() {
  modelPicker?.update({
    selection,
    locked: mode !== 'chat' || Boolean(chat.run),
    providers: providers.filter(provider => !provider.unavailable && (provider.id === 'deepseek-official'
      || provider.id === 'saved-provider' || Object.hasOwn(profiles, provider.id) || !!chatKeys[provider.id])),
  })
  modelSettings?.update()
}

function loadModelPicker() {
  if (!modelPickerLoading) {
    modelPickerLoading = import('./assets/picker/model-picker.js').then(bundle => {
      const { mountModelPicker, mountModelSettings, mountWorkEffort } = bundle
      workEffortPicker = mountWorkEffort($('work-effort'), value => {
        if (mode !== 'work' || work.action || work.session?.status === 'running') return
        workEffort = value
        render()
      })
      modelPicker = mountModelPicker($('model-picker'), {
        onSelect(next) {
          const selected = findChatModel(providers, next)
          if (mode !== 'chat' || chat.run || !selected) return false
          const reasoningEffort = selected.model.reasoning?.efforts.find(level => level.id === next.reasoningEffort)?.id
          selection = { provider: next.provider, model: next.model, ...(reasoningEffort && { reasoningEffort }) }
          persistChatModel()
          chat.error = ''
          render()
          return true
        },
      })
      modelSettings = mountModelSettings($('model-settings'), {
        openMemory,
        read: () => ({ catalog, profiles, keys: chatKeys, locked: mode !== 'chat' || Boolean(chat.run) }),
        writeKey(provider, key) {
          const value = key.trim()
          if (!providers.some(item => item.id === provider) || /[\r\n]/.test(value)) return false
          const next = { ...chatKeys }
          if (value) next[provider] = value
          else delete next[provider]
          if (!saveSecret('chatApiKey', chatKeysRecord(next, providers), chatKeysTarget)) return false
          chatKeys = next
          chat.error = ''
          render()
          return true
        },
        writeProfiles(next) {
          const updated = configuredChatProviders(catalog, next)
          const keys = restoreChatKeys(chatKeysRecord(chatKeys, providers), updated)
          if (!saveSecret('chatApiKey', chatKeysRecord(keys, updated), chatKeysTarget)) return false
          profiles = next
          providers = updated
          chatKeys = keys
          if (!findChatModel(providers, selection) || (selection && selection.provider !== 'deepseek-official'
            && selection.provider !== 'saved-provider' && !Object.hasOwn(profiles, selection.provider)
            && !chatKeys[selection.provider])) selection = null
          persistChatModel()
          chat.error = ''
          render()
          return true
        },
      })
      renderMarkdownMessages = bundle.renderMarkdownMessages
      decodeQr = bundle.decodeQr
      render()
      updateModelPicker()
      return modelPicker
    }).catch(() => {
      modelPickerLoading = null
      return null
    })
  }
  return modelPickerLoading
}

async function openModelSettings() {
  const controls = await loadModelPicker()
  if (mode !== 'chat') return
  if (controls) {
    controls.close()
    modelSettings.open()
  }
  else {
    chat.error = '模型选择器加载失败，请重新打开应用。'
    render()
  }
}

function refreshMemoryForm() {
  const saved = chatMemory.snapshot()
  $('memory-enabled').checked = saved.enabled
  $('memory-fixed').value = saved.fixed
  $('memory-auto').value = saved.entries.map(e => e.text).join('\n')
  $('memory-count').textContent = saved.entries.length + ' 条自动记忆 · ' + saved.entries.reduce((n, e) => n + e.text.length, 0) + ' / 3000 字'
  $('memory-undo').disabled = !saved.previous
  $('memory-clear-confirm').hidden = true
  $('memory-sources').replaceChildren(...saved.entries.map(entry => {
    const source = chat.sessions.find(s => s.id === entry.source?.sessionId)
    return node('li', entry.text + ' — ' + (entry.source === 'manual' ? '手动编辑' : source?.title || '来源聊天已删除') +
      ' · ' + new Date(entry.updatedAt).toLocaleString())
  }))
}

function openMemory() {
  if (mode !== 'chat') return
  refreshMemoryForm()
  $('memory-feedback').textContent = chatMemory.error()
  if (!$('chat-memory').open) $('chat-memory').showModal()
}

function changeMemory(action, notice) {
  try { action(); refreshMemoryForm(); $('memory-feedback').textContent = notice }
  catch (error) { $('memory-feedback').textContent = error.name === 'QuotaExceededError' ? '存储空间不足，原记忆已保留' : error.message || '保存失败，原记忆已保留' }
}
$('memory-form').addEventListener('submit', event => {
  event.preventDefault()
  changeMemory(() => chatMemory.edit({ enabled: $('memory-enabled').checked,
    fixed: $('memory-fixed').value, automatic: $('memory-auto').value }), '已保存')
})
$('memory-undo').onclick = () => changeMemory(() => chatMemory.undo(), '已撤销')
$('memory-clear').onclick = () => { $('memory-clear-confirm').hidden = false }
$('memory-cancel-clear').onclick = () => { $('memory-clear-confirm').hidden = true }
$('memory-confirm-clear').onclick = () => changeMemory(() => chatMemory.clear(), '已清空记忆')

function openWorkSettings({ origin = work.origin, code = '' } = {}) {
  $('host').value = origin
  $('pair-code').value = code
  $('work-connected').hidden = !linked()
  $('linked-address').textContent = work.origin
  $('pair-form').hidden = linked() && !code
  $('scan-pair').hidden = desktopControl || !navigator.mediaDevices?.getUserMedia
  feedback($('pair-error'), '')
  if (!workSettings.open) workSettings.showModal()
}

async function openScanner() {
  const controller = new AbortController()
  scanController = controller
  const status = $('scan-status')
  status.textContent = '正在打开相机…'
  scanDialog.showModal()
  let stream
  try {
    await loadModelPicker()
    if (!decodeQr) throw new Error('QR decoder unavailable')
    controller.signal.throwIfAborted()
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: {
      facingMode: { ideal: 'environment' }, width: { ideal: 720 }, height: { ideal: 720 },
    } })
    controller.signal.throwIfAborted()
    scanPreview.srcObject = stream
    await scanPreview.play()
    status.textContent = '将电脑控制页上的二维码对准相机。'
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d', { willReadFrequently: true })
    while (!controller.signal.aborted) {
      if (scanPreview.readyState >= 2) {
        const scale = Math.min(1, 640 / Math.max(scanPreview.videoWidth, scanPreview.videoHeight))
        canvas.width = Math.max(1, Math.round(scanPreview.videoWidth * scale))
        canvas.height = Math.max(1, Math.round(scanPreview.videoHeight * scale))
        context.drawImage(scanPreview, 0, 0, canvas.width, canvas.height)
        const frame = context.getImageData(0, 0, canvas.width, canvas.height)
        const result = decodeQr(frame.data, frame.width, frame.height, { inversionAttempts: 'dontInvert' })
        if (result) {
          try {
            const link = new URL(result.data)
            const code = link.searchParams.get('code')
            const origin = workOrigin(link.searchParams.get('url'))
            if (['yingluo:', brand.pairScheme + ':'].includes(link.protocol) && link.hostname === 'pair' && /^[a-f\d]{10}$/i.test(code)) {
              scanDialog.close()
              window.yingluoPairLink(origin, code)
              return
            }
          } catch { /* Keep scanning after a non-pairing code. */ }
          status.textContent = '请扫描电脑控制页上的配对二维码。'
        }
      }
      await new Promise(resolve => setTimeout(resolve, 135))
    }
  } catch {
    if (!controller.signal.aborted) status.textContent = '无法打开相机。请允许相机权限，或手动填写地址与配对码。'
  } finally {
    stream?.getTracks().forEach(track => track.stop())
    if (scanPreview.srcObject === stream) scanPreview.srcObject = null
  }
}

async function refreshDesktopQr() {
  const origin = $('pair-addresses').value
  const status = $('desktop-pair-status')
  const image = $('desktop-qr')
  const refresh = $('new-qr')
  image.hidden = true
  if (!origin) {
    status.textContent = '电脑服务仅监听本机。使用 Work 启动脚本开启局域网连接后再扫码。'
    return
  }
  refresh.disabled = true
  $('pair-addresses').disabled = true
  status.textContent = '正在生成二维码…'
  try {
    const data = await requestJson('/v1/control/pairing', { method: 'POST', data: { origin } })
    image.src = data.qr
    image.hidden = false
    status.textContent = '手机在 Work → 电脑连接 → 扫码连接，扫完后点「连接」。配对码 ' + data.code + '，15 分钟或使用一次后失效。'
  } catch {
    status.textContent = '生成二维码失败，请重试。'
  } finally {
    refresh.disabled = false
    $('pair-addresses').disabled = false
  }
}

function openDesktopPairing() {
  $('pair-addresses').replaceChildren(...desktopAddresses.map(address => new Option(address, address)))
  desktopPairing.showModal()
  void refreshDesktopQr()
}

async function initializeDesktop() {
  document.title = brand.name + ' · 电脑控制'
  $('open-settings').textContent = '手机配对'
  $('desktop-pair').hidden = false
  $('desktop-pair').addEventListener('click', openDesktopPairing)
  try {
    const { token, addresses } = await requestJson('/v1/control', { method: 'POST', data: {} })
    desktopAddresses = addresses.filter(address => new URL(address).hostname !== '127.0.0.1')
    Object.assign(work, { origin: location.origin, token, canResume: false })
  } catch {
    work.error = '电脑控制页面无法连接本机服务。'
  }
  setMode('work')
}

window.yingluoPairLink = (url, code) => {
  try {
    const origin = workOrigin(url)
    if (typeof code !== 'string' || !/^[a-f\d]{10}$/i.test(code)) return
    if (picker.open) picker.close()
    setMode('work')
    openWorkSettings({ origin, code })
  } catch {
    // Malformed deep links leave the current screen in place.
  }
}

function renderContext() {
  const inChat = mode === 'chat'
  const session = inChat ? chatSession() : work.session
  const title = session?.title || (inChat ? '新聊天' : work.summary?.project?.name || (linked() ? '连接中…' : '未连接电脑'))
  const detail = inChat ? selectedChatModel()?.provider.name : agentNames[session?.agent]
  const key = JSON.stringify([title, detail])
  if (key === contextKey) return
  contextKey = key
  const context = $('session-context')
  context.replaceChildren(node('span', redact(title), 'session-title'))
  if (detail) context.append(node('span', detail, 'session-detail'))
}

function sidebarIcon(name) {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('aria-hidden', 'true')
  const use = document.createElementNS(ns, 'use')
  use.setAttribute('href', '#dsw-icon-' + name + '-regular')
  svg.append(use)
  return svg
}

function renderSidebar() {
  if (!sidebar.open) return
  const inChat = mode === 'chat'
  const sessions = inChat
    ? [...chat.sessions].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    : work.summary?.sessions ?? []
  const selected = inChat ? chat.selected : work.selected
  const project = inChat ? '本机对话' : work.summary?.project?.name || '未连接电脑'
  const running = inChat ? chat.runningSessionId : work.session?.status === 'running' ? work.session.id : ''
  const locked = !inChat && Boolean(work.action)
  const supportsDelete = inChat || work.summary?.deleteSessions === true
  const recent = inChat ? [] : work.summary?.recentSessions ?? []
  $('open-library').hidden = inChat || !work.summary?.desktopLibrary
  if (!inChat && work.summary?.desktopGroups) {
    renderDesktopSidebar(work.summary.desktopGroups)
    return
  }
  const upgradeNotice = !inChat && work.summary && !supportsDelete ? '更新并重启电脑端 Work 服务后即可删除会话。' : ''
  feedback($('sidebar-error'), inChat ? '' : work.deleteError || work.error || upgradeNotice)
  const key = JSON.stringify([mode, project, selected, running, linked(), locked, supportsDelete,
    sessions.map(({ id, title, status, updatedAt }) => [id, title, status, updatedAt]), recent])
  if (key === sidebarKey) return
  sidebarKey = key
  $('sidebar-group').textContent = inChat ? '会话' : '工作区'
  $('sidebar-project').replaceChildren(sidebarIcon('folder-open-outline'), document.createTextNode(redact(project)))
  $('sidebar-empty').hidden = sessions.length > 0 || (!inChat && !work.summary)
  $('new-session').textContent = '＋ 新会话'
  $('new-session').disabled = locked
  const rows = sessions.map(session => {
    const title = redact(session.title)
    const row = node('li', '', 'sidebar-row')
    const open = button('', () => {
      sidebar.close()
      if (inChat) selectChat(session.id)
      else if (work.selected !== session.id) selectWork(session.id)
    }, 'sidebar-session')
    open.append(node('span', title))
    open.title = title
    open.disabled = locked
    if (session.updatedAt) {
      const age = Math.floor(Math.max(0, Date.now() - session.updatedAt) / 86400000)
      open.append(node('span', relativeDate.format(-age, 'day'), 'sidebar-session-age'))
    }
    if (session.id === selected) {
      row.setAttribute('data-current', '')
      open.setAttribute('aria-current', 'true')
    }
    row.append(open)
    if (supportsDelete) {
      const remove = button('', () => confirmSessionDeletion(session), 'sidebar-icon sidebar-delete')
      const disabled = session.id === running || session.status === 'running'
      remove.append(sidebarIcon('trash-outline'), node('span', '删除'))
      remove.setAttribute('aria-label', '删除 ' + title)
      remove.title = disabled ? '请先停止当前任务' : '删除会话'
      remove.disabled = locked || disabled
      row.append(remove)
    }
    return row
  })
  $('sidebar-sessions').replaceChildren(...rows)
  const recentHeader = $('recent-header')
  recentHeader.hidden = inChat || !work.summary?.recentSessions
  const recentList = $('recent-sessions')
  const recentRows = recent.map(entry => {
    const row = node('li', '', 'sidebar-row')
    const open = button('', () => {
      sidebar.close()
      void workMutation('resume', async () => {
        const { session } = await workRequest('/sessions', { method: 'POST', data: { agent: entry.agent, recentId: entry.id } })
        resetScroll = true
        return session
      })
    }, 'sidebar-session')
    open.disabled = locked || entry.canResume === false
    open.append(node('span', redact(entry.title || '未命名会话')),
      node('span', entry.canResume === false ? '在 Harness 继续' : agentNames[entry.agent] || entry.agent, 'sidebar-session-age'))
    row.append(open)
    return row
  })
  recentList.replaceChildren(...recentRows)
  $('recent-empty').hidden = recentHeader.hidden || recent.length > 0
}

function renderDesktopSidebar(groups) {
  const key = JSON.stringify([groups, work.desktop, work.error])
  if (key === sidebarKey) return
  sidebarKey = key
  feedback($('sidebar-error'), work.error)
  $('sidebar-group').textContent = '项目与工作区'
  $('sidebar-project').textContent = ''
  $('recent-header').hidden = true
  $('recent-empty').hidden = true
  $('recent-sessions').replaceChildren()
  $('sidebar-empty').hidden = true
  const container = $('sidebar-sessions')
  const expanded = new Set([...container.querySelectorAll('details[open]')].map(d => d.dataset.key))
  container.replaceChildren()
  for (const agent of ['codex', 'deepseek']) {
    container.append(node('li', agentNames[agent], 'sidebar-label'))
    for (const group of groups.filter(g => g.agent === agent)) {
      const row = node('li'), details = node('details'), summary = node('summary', '📁 ' + group.name)
      details.dataset.key = agent + ':' + group.id
      details.open = expanded.has(details.dataset.key) || group.sessions.some(s => s.id === work.desktop?.id && agent === work.desktop?.agent)
      details.append(summary)
      for (const session of group.sessions) {
        const open = button(session.title, () => {
          work.desktop = { agent, id: session.id, title: session.title }
          work.selected = ''; work.session = null; work.sendError = ''; draftingWork = false
          attachments.work = []; resetScroll = true
          persistConnection(); sidebar.close(); render(); void refreshWork()
        }, 'sidebar-session')
        if (session.id === work.desktop?.id && agent === work.desktop?.agent) open.setAttribute('aria-current', 'true')
        details.append(open)
      }
      row.append(details); container.append(row)
    }
  }
}

function confirmSessionDeletion(session) {
  pendingDeletion = { id: session.id, mode }
  $('delete-session-description').textContent = '确定删除' + brand.name + '中的「' + redact(session.title) + '」会话记录？'
  deleteDialog.showModal()
}

function deleteConversation() {
  const target = pendingDeletion
  pendingDeletion = undefined
  deleteDialog.close()
  if (!target || target.mode !== mode) return
  if (mode === 'chat') {
    if (chat.runningSessionId === target.id) return
    chat.sessions = chat.sessions.filter(session => session.id !== target.id)
    if (chat.selected === target.id) {
      attachments.chat = []
      saveDraft('')
      selectChat(chat.sessions[0]?.id ?? '')
    } else {
      persistChat()
      render()
    }
    return
  }
  work.deleteError = ''
  const token = work.token
  void workMutation('delete', async () => {
    const id = target.id
    await workRequest('/sessions/' + encodeURIComponent(id), { method: 'DELETE' })
    if (work.token !== token) return
    work.summary.sessions = work.summary.sessions.filter(session => session.id !== id)
    if (work.selected === id) {
      work.selected = work.summary.sessions[0]?.id ?? ''
      work.session = null
      workEffort = ''
      attachments.work = []
      drafts.work = ''
      if (mode === 'work') prompt.value = ''
      resetScroll = true
      persistConnection()
    }
  }, error => { work.deleteError = error })
}

function emptyState(title, body, action, handler) {
  const card = node('div', '', 'empty')
  card.append(node('h1', title))
  if (body) card.append(node('p', body))
  if (action) card.append(button(action, handler))
  return card
}

function renderEmpty(session) {
  if (mode === 'chat') {
    return chatReady()
      ? emptyState(brand.companion ? '和' + brand.name + '聊聊' : '开始对话', '你想聊点什么？')
      : emptyState(brand.companion ? '和' + brand.name + '聊聊' : '开始对话', '选择模型并填写 API Key，就可以开始聊天。', '设置模型', openModelSettings)
  }
  if (!linked()) {
    return emptyState('连接电脑', '打开电脑端服务，填写地址和配对码。', '开始配对', openWorkSettings)
  }
  if (session) return emptyState(agentNames[session.agent] ?? 'Work 会话', '发条消息，开始处理当前项目。')
  if (!work.summary) {
    return emptyState('连接电脑', work.error || '正在读取电脑上的项目…', '重试', refreshWork)
  }
  if (work.selected || work.desktop) return emptyState('加载会话', work.error || '正在读取电脑上的会话…')
  if (work.summary.desktopGroups) return emptyState('电脑上的会话', '从左上角展开项目与工作区，选择要继续的会话。', '查看项目与工作区', () => sidebar.showModal())
  return emptyState('开始 Work', '选择一个助手，开始处理当前项目。', '选择助手', openAgentPicker)
}

function sourceIcon(item) {
  const wrapper = node('span', '', 'source-icon')
  wrapper.setAttribute('aria-hidden', 'true')
  const icon = node('img')
  icon.alt = ''; icon.width = 20; icon.height = 20
  icon.referrerPolicy = 'no-referrer'
  icon.src = sourceUrl(item.icon) || new URL('/favicon.ico', item.url).href
  const fallback = node('span', new URL(item.url).hostname.slice(0, 1).toUpperCase(), 'source-fallback')
  fallback.hidden = true
  icon.addEventListener('error', () => { icon.hidden = true; fallback.hidden = false }, { once: true })
  wrapper.append(icon, fallback)
  return wrapper
}

function renderSources(row, message) {
  let footer = row.querySelector('.message-sources')
  const sources = (message.sources ?? []).filter(item => sourceUrl(item.url))
  const key = JSON.stringify([sources, message.searchFailed])
  if (footer?.dataset.key === key) return
  footer?.remove()
  if (!sources.length && !message.searchFailed) return
  footer = node('section', '', 'message-sources')
  footer.dataset.key = key
  footer.setAttribute('aria-label', '参考资料')
  if (message.searchFailed) footer.append(node('p', '本次搜索未成功，部分资料可能未能获取。', 'message-name'))
  const overview = button('', () => openSources(sources), 'source-overview')
  overview.setAttribute('aria-haspopup', 'dialog')
  overview.setAttribute('aria-controls', 'sources-sheet')
  const stack = node('span', '', 'source-stack')
  sources.slice(0, 3).forEach(item => stack.append(sourceIcon(item)))
  overview.append(stack, node('span', sources.length + ' 个来源'))
  if (sources.length) footer.append(overview)
  row.insertBefore(footer, row.querySelector('.reply-actions'))
}

function openSources(sources) {
  const sheet = $('sources-sheet')
  const list = $('sources-list')
  list.replaceChildren()
  $('sources-title').textContent = '参考资料 · ' + sources.length + ' 个来源'
  for (const item of sources) {
    const card = node('details', '', 'source-card')
    card.dataset.url = item.url
    const summary = node('summary')
    summary.append(sourceIcon(item), node('span', item.title || new URL(item.url).hostname), node('small', item.cited ? '引用' : '搜索结果'))
    const link = node('a', item.url)
    link.href = item.url; link.target = window.YingluoNative ? '_self' : '_blank'; link.rel = 'noopener noreferrer'
    card.append(summary, link)
    list.append(card)
  }
  sheet.showModal()
  list.scrollTop = 0
}

function renderReplyDetails(row, message) {
  let thought = row.querySelector('.message-reasoning')
  if (message.reasoning && !thought) {
    thought = node('details', '', 'message-reasoning')
    const summary = node('summary')
    summary.append(sidebarIcon('chevron-right-outline'), node('span'))
    thought.append(summary, node('div', '', 'reasoning-text'))
    row.querySelector('.message-name').after(thought)
  }
  if (thought) {
    const thinking = Boolean(message.streaming && !message.text)
    thought.querySelector('summary span').textContent = thinking ? '正在思考…' : message.interrupted ? '思考内容 · 已中断' : '思考内容'
    thought.querySelector('.reasoning-text').textContent = redact(message.reasoning)
  }
  if (mode !== 'chat') return
  let actions = row.querySelector('.reply-actions')
  if (!actions) {
    actions = node('div', '', 'reply-actions')
    const retry = button('', () => void sendChat('', message), 'reply-retry')
    retry.setAttribute('aria-label', '重新生成回复')
    retry.title = '重新生成回复'
    retry.append(sidebarIcon('refresh-outline'))
    actions.append(retry)
    row.append(actions)
  }
  actions.querySelector('button').disabled = Boolean(chat.run) || !chatReady()
  let error = actions.querySelector('.reply-error')
  if (message.replyError && !error) { error = node('span', '', 'reply-error'); actions.append(error) }
  if (error) { error.textContent = message.replyError || ''; error.hidden = !message.replyError }
}

function messageRow(message, assistantName, richMessages) {
  const user = message.role === 'user'
  const row = node('article', '', user ? 'message message-user' : 'message message-assistant')
  row.toggleAttribute('data-streaming', Boolean(message.streaming))
  row.append(node('p', user ? '你' : assistantName, user ? 'sr-only' : 'message-name'))
  if (message.interrupted) row.append(node('p', '回复已中断，已保留收到的内容', 'message-name'))
  if (message.text || !user) {
    const text = redact(message.text)
    if (user || !renderMarkdownMessages) row.append(node('p', text, 'message-body'))
    else {
      const element = node('div', '', 'message-markdown')
      richMessages.push({ element, text, streaming: Boolean(message.streaming), message })
      row.append(element)
    }
  }
  if (message.attachments?.length) {
    const list = node('div', '', 'message-attachments')
    for (const file of message.attachments) list.append(attachmentItem(file, false))
    row.append(list)
  }
  if (!user) { renderReplyDetails(row, message); renderSources(row, message) }
  if (mode === 'chat' && message.memoryNotice) row.append(button(message.memoryNotice, openMemory, 'control memory-notice'))
  return row
}

function attachmentItem(file, removable) {
  if (!removable && file.desktopFile) {
    const open = button((file.type?.startsWith('image/') ? '▧ ' : '▤ ') + file.name,
      () => void openDesktopFile(file, open), 'control desktop-file')
    if (file.description) open.title = file.description
    return open
  }
  const item = node('span', '', 'attachment')
  if (file.data && imageTypes.includes(file.type) && (!removable || mode === 'chat')) {
    const preview = node('img')
    preview.alt = redact(file.name)
    preview.src = 'data:' + file.type + ';base64,' + file.data
    if (removable) item.append(preview)
    else {
      const open = button('', () => {
        const session = mode === 'chat' ? chatSession() : work.session
        const gallery = (session?.messages ?? []).flatMap(message => message.attachments ?? [])
          .filter(image => image.data && imageTypes.includes(image.type))
        viewImages(gallery, Math.max(0, gallery.indexOf(file)))
      }, 'image-thumbnail')
      open.setAttribute('aria-label', '放大查看 ' + redact(file.name))
      open.append(preview)
      return open
    }
  }
  if (removable || !item.firstChild) item.append(node('span', redact(file.name)))
  if (removable) {
    const remove = button('×', () => {
      attachments[mode] = attachments[mode].filter(current => current !== file)
      render()
    })
    remove.setAttribute('aria-label', '移除 ' + redact(file.name))
    item.append(remove)
  }
  return item
}

async function openDesktopFile(file, control) {
  const selected = { agent: file.desktopAgent, id: file.desktopSession }
  if (!selected.agent || !selected.id) return
  control.disabled = true
  try {
    const result = await workRequest('/library/' + selected.agent + '/' + encodeURIComponent(selected.id) + '/files/' + file.desktopFile,
      { timeout: 60000 })
    if (imageTypes.includes(result.type)) { viewImages([result], 0); return }
    const dialog = node('dialog'), header = node('div', '', 'dialog-head')
    header.append(node('h2', result.name), button('关闭', () => dialog.close()))
    dialog.append(header)
    const bytes = Uint8Array.from(atob(result.data), c => c.charCodeAt(0))
    if (/\.(?:txt|md|py|js|ts|json|csv|log|yaml|yml|tex|html|css|cpp|c|h|rs|go|java|xml)$/iu.test(result.name)) {
      const pre = node('pre', new TextDecoder().decode(bytes.subarray(0, 1024 * 1024)), 'desktop-file-text')
      dialog.append(pre)
      if (bytes.length > 1024 * 1024) dialog.append(node('p', '文件较长，预览显示前 1 MB。'))
    } else dialog.append(node('p', '文件大小：' + result.size + ' 字节。此格式请在电脑上打开。'))
    document.body.append(dialog)
    dialog.addEventListener('close', () => dialog.remove(), { once: true })
    dialog.showModal()
  } catch (error) {
    work.sendError = error.detail || '文件无法读取，请刷新会话后重试。'
    render()
  } finally { control.disabled = false }
}

function renderComposerOptions(inChat, disabled) {
  const files = attachments[mode]
  const list = $('attachment-list')
  list.hidden = files.length === 0
  list.replaceChildren(...files.map(file => attachmentItem(file, true)))
  $('attach').disabled = disabled || readingFiles[mode]
  $('attach').setAttribute('aria-label', inChat ? '添加图片' : '添加文件')
  $('attach').title = inChat ? '添加图片' : '添加文件'
  const effort = $('work-effort')
  const levels = inChat || work.desktop ? [] : work.summary?.reasoningEfforts?.[work.session?.agent] ?? []
  effort.hidden = levels.length === 0
  workEffortPicker?.update({ levels, disabled, value: levels.includes(workEffort) ? workEffort : '',
    model: work.session?.agent === 'codex' ? 'Codex' : 'DeepSeek Harness' })
}

function eventList(events, open) {
  const details = node('details', '', 'events')
  details.open = open
  details.append(node('summary', '运行记录 · ' + events.length))
  for (const event of events.slice(-80)) {
    const row = node('p', redact(event.text))
    if (event.type === 'dispatch' && typeof event.sessionId === 'string') {
      row.append(document.createTextNode(' '), button('查看会话', () => selectWork(event.sessionId)))
    }
    details.append(row)
  }
  return details
}

function renderThread() {
  const inChat = mode === 'chat'
  const session = inChat ? chatSession() : work.session
  const messages = session?.messages ?? []
  const events = inChat ? [] : session?.events ?? []
  const key = JSON.stringify([mode, session?.id, messages, events, Boolean(renderMarkdownMessages),
    inChat ? [selection, chatReady(), Boolean(chat.run)] : [linked(), Boolean(work.summary), work.selected, work.error, session?.historyBefore, loadingDesktopHistory]])
  if (key === threadKey) {
    if (resetScroll) { readingNavigation.latest(); resetScroll = false }
    return
  }
  threadKey = key
  const previousTop = readingNavigation.beforeRender(resetScroll)
  const structure = JSON.stringify([mode, session?.id, messages.map(message => [message.id, message.role,
    message.role === 'user' || !renderMarkdownMessages ? message.text : '', message.attachments, message.interrupted, message.memoryNotice]), events,
    Boolean(renderMarkdownMessages), session?.historyBefore, loadingDesktopHistory, messages.length ? '' : key])
  if (structure === threadStructure && unmountMarkdown?.update) {
    const assistants = messages.filter(message => message.role !== 'user')
    mountedRichMessages.forEach((entry, index) => {
      entry.text = redact(assistants[index].text)
      entry.streaming = Boolean(assistants[index].streaming)
      entry.element.parentElement.toggleAttribute('data-streaming', entry.streaming)
      renderReplyDetails(entry.element.parentElement, assistants[index])
      renderSources(entry.element.parentElement, assistants[index])
    })
    unmountMarkdown.update(mountedRichMessages)
    readingNavigation.afterRender(mode + ':' + (session?.id ?? ''), messages, previousTop)
    resetScroll = false
    return
  }
  threadStructure = structure
  const eventOpen = thread.querySelector('.events')?.open ?? false
  const expandedThoughts = new Set([...thread.querySelectorAll('.message-reasoning[open]')].map(el => el.parentElement.dataset.messageKey))
  const assistantName = inChat ? brand.assistant : agentNames[session?.agent] ?? '助手'
  const richMessages = []
  const rows = messages.map((message, index) => {
    const row = messageRow(message, assistantName, richMessages)
    row.dataset.messageKey = session.id + ':' + (message.id || index)
    const thought = row.querySelector('.message-reasoning')
    if (thought) thought.open = expandedThoughts.has(row.dataset.messageKey)
    return row
  })
  if (!inChat && work.desktop && session?.historyBefore > 0) {
    const older = button(loadingDesktopHistory ? '正在加载…' : '加载更早的消息', loadDesktopHistory, 'control history-older')
    older.disabled = loadingDesktopHistory
    rows.unshift(older)
  }
  if (rows.length === 0 && events.length === 0) rows.push(renderEmpty(session))
  if (events.length) rows.push(eventList(events, eventOpen))
  unmountMarkdown?.()
  thread.replaceChildren(...rows)
  unmountMarkdown = richMessages.length ? renderMarkdownMessages(richMessages) : undefined
  mountedRichMessages = richMessages
  animation.parentElement.toggleAttribute('data-active', messages.length > 0 || events.length > 0)
  readingNavigation.afterRender(mode + ':' + (session?.id ?? ''), messages, previousTop)
  resetScroll = false
}

function activeAnimation() {
  if (reducedMotion.matches) return 'still'
  if (mode === 'chat') return chat.run ? 'waiting' : chat.error ? 'failed' : 'idle'
  return { running: 'running', failed: 'failed', cancelled: 'waiting' }[work.session?.status] ?? 'idle'
}

function render() {
  renderContext()
  renderSidebar()
  renderThread()
  const inChat = mode === 'chat'
  const busy = inChat ? Boolean(chat.run) : Boolean(work.action)
  const running = inChat ? Boolean(chat.run) : work.session?.status === 'running'
  const taskError = work.session?.status === 'failed'
    ? work.session.events?.filter(event => event.type === 'error').at(-1)?.text : ''
  const error = inChat ? chat.error : work.sendError || work.error || taskError
  const ready = inChat ? chatReady() : Boolean(work.session)
  const searchModel = selectedChatModel()
  const searchSupported = inChat && supportsWebSearch(searchModel?.provider, searchModel?.model.id)
  $('web-search').hidden = !inChat
  $('web-search').disabled = busy || !searchSupported
  $('web-search').setAttribute('aria-pressed', String(searchSupported && webSearchEnabled))
  $('web-search').title = !searchSupported ? '此接口或模型尚未接入联网搜索' : webSearchEnabled ? '联网搜索已开启，点击关闭' : '开启联网搜索'
  const session = inChat ? chatSession() : work.session
  const selectingMode = !session?.messages?.length && !(!inChat && work.selected && !session)
  $('draft-modes').hidden = !selectingMode
  $('chat-mode').setAttribute('aria-pressed', String(inChat))
  $('work-mode').setAttribute('aria-pressed', String(!inChat))
  $('chat-mode').disabled = busy || running
  $('work-mode').disabled = busy || running
  $('quick-new-session').disabled = Boolean(work.action)
  $('model-picker').hidden = !inChat
  updateModelPicker()
  renderComposerOptions(inChat, busy || running || (!inChat && !ready))
  const placeholder = inChat ? (brand.companion ? '发消息给' + brand.name + '…' : '输入消息…') : '给当前助手发任务…'
  prompt.placeholder = placeholder
  prompt.setAttribute('aria-label', inChat ? '聊天消息' : 'Work 消息')
  $('send').disabled = busy || running || !ready || readingFiles[mode]
  $('stop').hidden = !running
  $('stop').disabled = !inChat && busy
  const status = error || (inChat && running ? searchStatus || brand.assistant + '正在回复…' : '')
    || (!inChat && work.session ? runLabels[work.session.status] : '')
  $('status').toggleAttribute('data-error', Boolean(error))
  // Idle readiness stays in the composer; progress and errors retain their text and stop action.
  $('composer-ready').hidden = !ready || busy || running || Boolean(error)
  feedback($('status'), status === runLabels.idle && !error ? '' : status)
  if (brand.companion) {
    const source = './assets/animations/' + activeAnimation() + '.png'
    if (animation.getAttribute('src') !== source) animation.src = source
  }
  updateComposerActions()
}

function applyTheme() {
  document.body.toggleAttribute('data-ds-dark-theme', dark.matches)
}

function connectionError(error) {
  if (error.status === 401 || error.status === 403) return '连接已失效，请重新配对。'
  if (error.status === 409) return '会话正在处理任务。'
  if (error.status === 413) return '附件超过电脑服务的接收限制。'
  if (error.status === 404) return '会话不可用。'
  if (error.status === 503) return '助手暂时不可用，请检查电脑端的配置。'
  if (error.status) return '电脑服务请求失败（' + error.status + '）。'
  return '无法连接电脑。请检查局域网和电脑端服务。'
}

function clearConnection(error = '') {
  stopPolling()
  saveSecret('workToken', '')
  Object.assign(work, { token: '', selected: '', summary: null, session: null, action: '', error, deleteError: '' })
  drafts.work = ''
  attachments.work = []
  workEffort = ''
  if (mode === 'work') prompt.value = ''
  persistConnection()
  render()
}

function workRequest(path, options) {
  return requestJson(work.origin + '/v1/work' + path, { token: work.token, ...options })
}

function stopPolling() {
  clearTimeout(pollTimer)
  poll?.abort()
  poll = null
}

async function refreshWork(includeList = true) {
  stopPolling()
  if (mode !== 'work' || !linked() || work.action) return
  const controller = new AbortController()
  poll = controller
  try {
    if (includeList || !work.summary) {
      const summary = await workRequest('', { signal: controller.signal })
      if (controller.signal.aborted) return
      work.summary = summary
      if (!work.desktop && !summary.sessions.some(session => session.id === work.selected)) {
        work.selected = draftingWork ? '' : summary.sessions[0]?.id ?? ''
        work.session = null
        persistConnection()
      }
    }
    if (work.desktop) {
      const selected = work.desktop
      const route = '/library/' + selected.agent + '/' + encodeURIComponent(selected.id)
      const page = await desktopHistory(before => workRequest(route + (before === undefined ? '' : '?before=' + before),
        { signal: controller.signal, timeout: 60000 }), work.session?.id === selected.id ? work.session.historyBefore : undefined)
      if (controller.signal.aborted || work.desktop !== selected) return
      work.session = { id: selected.id, agent: selected.agent, title: selected.title, status: 'idle',
        messages: page.messages, events: [], historyBefore: page.before, historyTotal: page.total }
    } else if (work.selected) {
      const { session } = await workRequest('/sessions/' + encodeURIComponent(work.selected), { signal: controller.signal })
      if (controller.signal.aborted) return
      if (session.id !== work.session?.id) workEffort = session.reasoningEffort ?? ''
      work.session = session
    }
    work.error = ''
  } catch (error) {
    if (controller.signal.aborted) return
    if (error.status === 401 || error.status === 403) clearConnection(connectionError(error))
    else work.error = connectionError(error)
  } finally {
    if (poll === controller) {
      poll = null
      render()
      const running = work.session?.status === 'running'
      pollTimer = setTimeout(() => refreshWork(!running), running ? 950 : 4500)
    }
  }
}

async function loadDesktopHistory() {
  if (loadingDesktopHistory || !work.desktop || !work.session?.historyBefore) return
  const selected = work.desktop
  stopPolling()
  loadingDesktopHistory = true
  render()
  const height = transcript.scrollHeight, top = transcript.scrollTop
  try {
    const page = await workRequest('/library/' + selected.agent + '/' + encodeURIComponent(selected.id) + '?before=' + work.session.historyBefore)
    if (work.desktop !== selected) return
    work.session.messages.unshift(...page.messages)
    work.session.historyBefore = page.before
    render()
    transcript.scrollTop = top + transcript.scrollHeight - height
  } catch (error) { work.error = connectionError(error) }
  finally { loadingDesktopHistory = false; render(); void refreshWork(false) }
}

function selectWork(id) {
  if (mode !== 'work' || !linked() || work.action) return
  work.selected = id
  work.desktop = null
  draftingWork = false
  work.session = null
  attachments.work = []
  workEffort = ''
  work.error = ''
  resetScroll = true
  persistConnection()
  render()
  refreshWork(true)
}

function saveWorkSession(session) {
  draftingWork = false
  if (session.id !== work.session?.id) {
    attachments.work = []
    workEffort = session.reasoningEffort ?? ''
  }
  work.selected = session.id
  work.session = session
  if (work.summary && !work.summary.sessions.some(current => current.id === session.id)) {
    work.summary.sessions.unshift({ id: session.id, agent: session.agent, title: session.title, status: session.status })
  }
  persistConnection()
}

async function workMutation(action, callback, onError) {
  if (mode !== 'work' || !linked() || work.action) return
  stopPolling()
  work.action = action
  work.error = ''
  const token = work.token
  render()
  try {
    const session = await callback()
    if (token === work.token && session) saveWorkSession(session)
  } catch (error) {
    if (token !== work.token) return
    const message = connectionError(error)
    if (error.status === 401 || error.status === 403) clearConnection(message)
    else work.error = message
    onError?.(message)
  } finally {
    if (token === work.token) work.action = ''
    render()
    refreshWork()
  }
}

function openAgentPicker() {
  if (!linked()) {
    openWorkSettings()
    return
  }
  if (!work.summary) {
    refreshWork()
    return
  }
  const options = $('agent-options')
  feedback($('agent-error'), '')
  options.replaceChildren()
  for (const agent of ['codex', 'deepseek', 'neko']) {
    const available = work.summary.agents[agent]?.available === true
    if (agent === 'neko' && !available) continue
    const control = button(available ? agentNames[agent] : agentNames[agent] + ' · 未配置', () => {
      const enabled = [...options.children].filter(item => !item.disabled)
      for (const item of enabled) item.disabled = true
      workMutation('create', async () => {
        const { session } = await workRequest('/sessions', { method: 'POST', data: { agent } })
        resetScroll = true
        picker.close()
        return session
      }, error => {
        feedback($('agent-error'), error)
        for (const item of enabled) item.disabled = false
      })
    })
    control.disabled = !available
    options.append(control)
  }
  picker.showModal()
}

function chatError(error) {
  if (error.name === 'AbortError') return ''
  if (error.name === 'TimeoutError') return '回复超时，请重试。'
  if (error.status === 401 || error.status === 403) return '验证失败，请在设置中检查 API Key。'
  if (error.status === 404) return '当前模型不可用，请换一个模型。'
  if (error.status === 429) return '模型请求达到限额，请稍后重试。'
  if (error.status) return '模型服务请求失败（' + error.status + '）。'
  return '无法取得模型回复，请检查 API 设置后重试。'
}

function fileData(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result.split(',')[1])
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

async function prepareImage(file) {
  if (!imageTypes.includes(file.type)) throw new Error('请选择 JPEG、PNG、WebP 或 GIF 图片。')
  if (file.size > 32 * MiB) throw new Error('单张原图须小于 32 MB。')
  const image = await createImageBitmap(file)
  try {
    const limit = 384 * 1024
    if (file.type !== 'image/gif' && file.size <= limit && Math.max(image.width, image.height) <= 1600) return file
    const canvas = document.createElement('canvas')
    const scale = Math.min(1600 / Math.max(image.width, image.height), 1)
    canvas.width = Math.max(1, Math.round(image.width * scale))
    canvas.height = Math.max(1, Math.round(image.height * scale))
    const ctx = canvas.getContext('2d', { alpha: false })
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.8))
    if (blob && blob.size <= limit) return blob
    const smaller = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.55))
    if (!smaller || smaller.size > limit) throw new Error('图片细节较多，请裁剪后再添加。')
    return smaller
  } finally {
    image.close()
  }
}

async function addFiles(files) {
  const target = mode
  const pending = attachments[target]
  if (!files.length || $('attach').disabled) return
  const state = target === 'chat' ? chat : work
  readingFiles[target] = true
  state.error = ''
  render()
  try {
    const inChat = target === 'chat'
    const count = inChat ? 4 : 8
    if (pending.length + files.length > count) throw new Error('每条消息最多添加 ' + count + ' 个附件。')
    if (!inChat && [...pending, ...files].reduce((total, file) => total + file.size, 0) > 12 * MiB) {
      throw new Error('一条 Work 消息的文件总大小上限为 12 MB。')
    }
    const added = []
    for (const file of files) {
      const blob = inChat ? await prepareImage(file) : file
      added.push({ name: (file.name || '图片').slice(0, 200), type: blob.type, size: blob.size, data: await fileData(blob) })
    }
    if (attachments[target] === pending) attachments[target] = [...pending, ...added]
  } catch (error) {
    state.error = error instanceof Error ? error.message : '无法读取附件，请重新选择。'
  } finally {
    readingFiles[target] = false
    render()
  }
}

async function sendChat(text, retryAnswer = null) {
  const selected = selectedChatModel()
  if (!selected || !chatReady() || chat.run) return
  const { provider, model } = selected
  let session = chatSession()
  const retryIndex = retryAnswer ? session?.messages.indexOf(retryAnswer) ?? -1 : -1
  const retryUser = retryIndex > 0 ? session.messages[retryIndex - 1] : null
  if (retryAnswer && (retryUser?.role !== 'user' || retryAnswer.streaming)) return
  const files = retryAnswer ? retryUser.attachments ?? [] : attachments.chat
  if (retryAnswer && files.some(file => !file.data)) {
    chat.error = '原图片已不在本机，请重新添加图片后发送'
    render(); return
  }
  if (files.length && !model.vision) {
    chat.error = '当前模型不支持图片，请选择支持图片的模型，例如 DeepSeek-V4.1-Flash。'
    render()
    return
  }
  session ??= newChat()
  if (retryAnswer && retryIndex < session.messages.length - 1) {
    const original = session
    session = { id: desktopRequestId(), title: original.title + ' · 重试', updatedAt: Date.now(),
      messages: structuredClone(original.messages.slice(0, retryIndex + 1)) }
    chat.sessions.unshift(session)
    chat.selected = session.id
  }
  const previousAnswer = retryAnswer ? session.messages.at(-1) : null
  if (retryAnswer) session.messages.pop()
  readingNavigation.latest()
  const controller = new AbortController()
  chat.error = ''
  chat.run = controller
  const search = webSearchEnabled && supportsWebSearch(provider, model.id)
  searchStatus = search ? '联网已开启，等待模型回复…' : ''
  chat.runningSessionId = session.id
  window.YingluoNative?.setReplySession?.(session.id)
  const userMessageId = retryAnswer ? retryUser.id || desktopRequestId() : desktopRequestId()
  if (!retryAnswer) session.messages.push({ id: userMessageId, role: 'user', text, ...(files.length && { attachments: files }) })
  if (!retryAnswer && session.messages.length === 1) session.title = (text || files[0].name).slice(0, 34)
  if (!retryAnswer) {
    attachments.chat = []
    composerEditing = false
    prompt.blur()
    setComposerExpanded(false)
    saveDraft('')
  }
  render()
  let answer
  let frame = 0
  const memory = chatMemory.snapshot()
  try {
    const effort = selection.reasoningEffort
    // Failed placeholders and interrupted empty answers are not model context.
    let history = session.messages.filter(message => message.role === 'user' || message.text?.trim())
    answer = { id: desktopRequestId(), role: 'assistant', text: '', reasoning: '', streaming: true }
    if (model.route?.replay) { answer.reasoningEndpoint = provider.endpoint; answer.reasoningModel = model.id }
    session.messages.push(answer)
    const memoryFilter = memoryStream(delta => {
      answer.text += delta
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; render() })
    })
    const mode = search ? searchMode(provider, model.id) : null
    if (requiresSearchLookup(mode)) {
      searchStatus = '正在联网搜索…'
      render()
      let rows = []
      try {
        rows = await lookupSources(mode, provider, chatKeys[provider.id], history.at(-1)?.text || '', controller.signal)
      } catch (error) {
        if (controller.signal.aborted) throw error
        answer.searchFailed = true
      }
      controller.signal.throwIfAborted()
      answer.sources = rows.map(({ snippet, ...source }) => source)
      history = withSearchResults(history, rows)
      searchStatus = rows.length ? '搜索完成，正在生成回复…' : '未取得搜索资料，正在生成回复…'
    }
    const { url, ...prepared } = streamingChatRequest(provider, model.id, chatKeys[provider.id], history, effort, search, memoryInstructions(memory))
    const stream = chatStreamReader(searchTransport(provider, mode), delta => memoryFilter.push(delta), update => {
      if (update.sources) answer.sources = update.sources
      if (update.failed) answer.searchFailed = true
      if (update.status) searchStatus = update.status
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; render() })
    }, delta => {
      answer.reasoning += delta
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; render() })
    })
    render()
    await requestStream(url, {
      method: 'POST',
      ...prepared,
      signal: controller.signal,
      timeout: search || effort === 'max' || effort === 'high' ? 240000 : 120000,
      onEvent: stream.event,
    })
    const nativeContent = stream.finish()
    const memoryResult = memoryFilter.finish()
    if (search && nativeContent.length) answer.nativeReply = { endpoint: provider.endpoint, model: model.id, content: cleanMemoryBlocks(nativeContent) }
    let memoryAck = ''
    if (memory.enabled && memoryResult.present && !controller.signal.aborted) {
      if (memoryResult.error || !stream.canSaveMemory()) answer.memoryNotice = memoryResult.error || '回复未完整结束，本次记忆未保存'
      else {
        try {
          const result = chatMemory.apply(memoryResult.patch, memory.revision, { sessionId: session.id, messageId: userMessageId })
          if (result.changed) { answer.memoryNotice = '已记住 · 查看 / 撤销'; memoryAck = '已更新记忆。' }
          else if (result.reason) answer.memoryNotice = result.reason
          else memoryAck = '本次没有新增或修改记忆。'
        } catch (error) { answer.memoryNotice = error.name === 'QuotaExceededError' ? '存储空间不足，记忆未保存' : '记忆未保存：' + error.message }
      }
    }
    if (!answer.text.trim()) {
      if (!memoryResult.present) throw new Error('Missing completion text')
      // Memory-only replies are a valid outcome for an explicit "remember this" request.
      answer.text = memoryAck || answer.memoryNotice || 'Chat 记忆已关闭，本次未保存记忆。'
      delete answer.nativeReply
    }
  } catch (error) {
    chat.error = search && [400, 422].includes(error.status)
      ? '服务未接受这次联网请求，请检查模型和推理档位是否支持搜索，或关闭地球按钮重试。'
      : chatError(error)
    if (previousAnswer) {
      if (answer) session.messages.pop()
      previousAnswer.replyError = error.name === 'AbortError' ? '已停止重试，保留原回复' : '重试失败，已保留原回复'
      session.messages.push(previousAnswer)
    } else {
      if (!answer) { answer = { id: desktopRequestId(), role: 'assistant', text: '' }; session.messages.push(answer) }
      answer.interrupted = true
      answer.replyError = error.name === 'AbortError' ? '已停止生成，可点击重试' : chat.error
    }
  } finally {
    cancelAnimationFrame(frame)
    if (answer) { delete answer.streaming; answer.text = redact(answer.text); answer.reasoning = redact(answer.reasoning) }
    session.updatedAt = Date.now()
    persistChat()
    chat.run = null
    searchStatus = ''
    chat.runningSessionId = ''
    render()
  }
}

function sendWork(text) {
  if (work.desktop) { void sendDesktop(text); return }
  if (!work.session || work.session.status === 'running' || work.action) return
  const id = encodeURIComponent(work.selected)
  const files = attachments.work
  if (files.length && work.summary?.attachments !== true) {
    work.error = '请更新并重启电脑端 Work 服务，再发送附件。'
    render()
    return
  }
  const effort = workEffort
  readingNavigation.latest()
  composerEditing = false
  prompt.blur()
  setComposerExpanded(false)
  saveDraft('')
  workMutation('send', async () => {
    const { session } = await workRequest('/sessions/' + id + '/messages', {
      method: 'POST',
      data: { text, ...(files.length && { attachments: files.map(({ name, data }) => ({ name, data })) }),
        ...(work.summary?.reasoningEfforts?.[work.session?.agent] && { reasoningEffort: effort }) },
      ...(files.length && { timeout: 90000 }),
    })
    if (attachments.work === files) attachments.work = []
    return session
  }, () => {
    if (mode === 'work' && !drafts.work) saveDraft(text)
    else if (!drafts.work) drafts.work = text
  })
}

async function sendDesktop(text) {
  const files = attachments.work
  if (work.action || (!text.trim() && !files.length)) return
  const selected = work.desktop
  work.sendError = ''
  const key = 'ayane.desktop-send.' + work.origin + '.' + selected.agent + '.' + selected.id
  // Small retry fingerprint; the server additionally verifies the complete SHA-256 of every file.
  let fingerprint = 2166136261
  for (const file of files) for (const char of file.name + ':' + file.data) fingerprint = Math.imul(fingerprint ^ char.charCodeAt(0), 16777619) >>> 0
  const fileKey = files.length ? String(fingerprint) : ''
  let receipt = read(key, null)
  if (!receipt || receipt.text !== text || (receipt.fileKey || '') !== fileKey) receipt = { text, fileKey, requestId: desktopRequestId() }
  store(key, receipt)
  work.action = 'send'
  stopPolling(); render()
  try {
    await workRequest('/library/' + selected.agent + '/' + encodeURIComponent(selected.id), {
      method: 'POST', data: { ...receipt, ...(files.length && { attachments: files.map(({ name, data }) => ({ name, data })) }) }, timeout: 90000,
    })
    localStorage.removeItem(key)
    if (work.desktop === selected) {
      if (attachments.work === files) attachments.work = []
      saveDraft(''); composerEditing = false; prompt.blur(); readingNavigation.latest()
    }
    work.error = ''
  } catch (error) {
    work.sendError = error.detail || '发送结果待确认，请查看原对话最新消息。重试将使用同一发送编号。'
  } finally {
    work.action = ''; render(); void refreshWork()
  }
}

async function pair(event) {
  event.preventDefault()
  if (work.action) return
  const pairError = $('pair-error')
  const code = $('pair-code').value.trim()
  let origin
  try {
    origin = workOrigin($('host').value)
  } catch {
    feedback(pairError, '请输入电脑端显示的完整地址。')
    return
  }
  if (!/^[a-f\d]{10}$/i.test(code)) {
    feedback(pairError, '请输入电脑端显示的 10 位配对码。')
    return
  }
  stopPolling()
  work.action = 'pair'
  $('pair-submit').disabled = true
  feedback(pairError, '')
  try {
    const { token } = await requestJson(origin + '/v1/pair', {
      method: 'POST', data: { code, label: brand.name + '手机' },
    })
    if (typeof token !== 'string' || !token) throw new Error('Invalid pairing response')
    Object.assign(work, { origin, token, selected: '', summary: null, session: null, error: '' })
    work.canResume = saveSecret('workToken', token, origin)
    persistConnection()
    workSettings.close()
  } catch (error) {
    const message = error.status === 429 ? '配对尝试过多，请稍后重试。'
      : error.status === 410 ? '配对码已失效，请在电脑上重新启动服务。'
        : error.status === 401 || error.status === 403 || error.status === 409 ? '配对码无效或已使用。'
        : connectionError(error)
    feedback(pairError, message)
  } finally {
    work.action = ''
    $('pair-submit').disabled = false
    render()
    refreshWork()
  }
}

$('chat-history').addEventListener('click', () => setMode('chat'))
$('work-history').addEventListener('click', () => setMode('work'))
$('chat-mode').addEventListener('click', () => chooseDraftMode('chat'))
$('work-mode').addEventListener('click', () => chooseDraftMode('work'))
$('quick-new-session').addEventListener('click', beginNewConversation)
$('expand-prompt').addEventListener('click', () => setComposerExpanded(!composerExpanded, true))
$('open-settings').addEventListener('click', () => {
  if (mode === 'chat') openModelSettings()
  else if (desktopControl) openDesktopPairing()
  else openWorkSettings()
})
$('scan-pair').addEventListener('click', () => void openScanner())
scanDialog.addEventListener('close', () => {
  scanController?.abort()
  scanPreview.srcObject?.getTracks().forEach(track => track.stop())
})
$('new-qr').addEventListener('click', () => void refreshDesktopQr())
mountDesktopLibrary({
  connection: () => work.origin,
  request: workRequest,
  renderMessages(messages, agent, root) {
    const rich = []
    root.replaceChildren(...messages.map(m => messageRow(m, agentNames[agent], rich)))
    return rich.length ? renderMarkdownMessages(rich) : undefined
  },
  resume(agent, id) {
    sidebar.close()
    const entry = work.summary?.desktopGroups?.filter(g => g.agent === agent).flatMap(g => g.sessions).find(s => s.id === id)
    work.desktop = { agent, id, title: entry?.title || '电脑会话' }
    work.selected = ''; work.session = null; work.sendError = ''; draftingWork = false
    attachments.work = []; resetScroll = true
    persistConnection(); render(); void refreshWork()
  },
})
$('pair-addresses').addEventListener('change', () => void refreshDesktopQr())
$('open-sidebar').addEventListener('click', () => {
  if (mode === 'work') work.deleteError = ''
  sidebar.showModal()
  $('open-sidebar').setAttribute('aria-expanded', 'true')
  renderSidebar()
})
sidebar.addEventListener('close', () => $('open-sidebar').setAttribute('aria-expanded', 'false'))
sidebar.addEventListener('click', event => {
  if (event.target === sidebar && event.clientX > sidebar.getBoundingClientRect().right) sidebar.close()
})
$('confirm-delete').addEventListener('click', deleteConversation)
deleteDialog.addEventListener('close', () => {
  if (!deleteDialog.open) pendingDeletion = undefined
})
$('new-session').addEventListener('click', () => {
  beginNewConversation()
})
$('disconnect').addEventListener('click', () => {
  clearConnection()
  workSettings.close()
})

for (const close of document.querySelectorAll('[data-close]')) {
  close.addEventListener('click', () => close.closest('dialog').close())
}
$('sources-sheet').addEventListener('click', event => {
  const sheet = $('sources-sheet')
  const bounds = sheet.getBoundingClientRect()
  if (event.target === sheet && (event.clientY < bounds.top || event.clientY > bounds.bottom
    || event.clientX < bounds.left || event.clientX > bounds.right)) sheet.close()
})
window.yingluoBack = () => {
  const effortPopover = document.querySelector('#work-effort [popover]:popover-open')
  if (effortPopover) { effortPopover.hidePopover(); return true }
  if ($('model-picker').querySelector('button[aria-expanded="true"]')) { modelPicker?.close(); return true }
  const dialogs = [...document.querySelectorAll('dialog[open]')]
  // A native child sheet stays above React settings; settings stay above the history drawer.
  const child = dialogs.filter(dialog => dialog !== sidebar).at(-1)
  if (child) { child.close(); return true }
  if (modelSettings?.back()) return true
  if (!dialogs.length) {
    if (readingNavigation.close()) return true
    if (composerExpanded) { setComposerExpanded(false); return true }
    return false
  }
  dialogs.at(-1).close()
  return true
}

window.yingluoOpenReply = id => {
  if (!chat.sessions.some(session => session.id === id)) return
  setMode('chat')
  selectChat(id)
}
const liveUpdates = $('oppo-live-updates')
liveUpdates.hidden = !window.YingluoNative?.supportsReplyLiveUpdate?.()
liveUpdates.addEventListener('click', () => window.YingluoNative?.openReplySettings?.())

$('pair-form').addEventListener('submit', pair)
$('attach').addEventListener('click', () => {
  if (mode === 'work' && work.summary?.attachments !== true) {
    work.error = '请更新并重启电脑端 Work 服务，再发送附件。'
    render()
    return
  }
  const input = $('file-input')
  input.accept = mode === 'chat' ? imageTypes.join(',') : ''
  input.click()
})
$('web-search').addEventListener('click', () => {
  webSearchEnabled = !webSearchEnabled
  store('yingluo.web-search.v1', webSearchEnabled)
  render()
  clearTimeout(searchToastTimer)
  const toast = $('search-toast')
  toast.textContent = webSearchEnabled ? '联网搜索已开启' : '联网搜索已关闭'
  toast.hidden = false
  searchToastTimer = setTimeout(() => { toast.hidden = true }, 800)
})
$('file-input').addEventListener('change', event => {
  const files = [...event.target.files]
  event.target.value = ''
  void addFiles(files)
})
$('composer').addEventListener('submit', event => {
  event.preventDefault()
  const text = prompt.value.trim()
  if ($('send').disabled || (!text && !attachments[mode].length)) return
  if (mode === 'chat') sendChat(text)
  else sendWork(text)
})
prompt.addEventListener('focus', () => { composerEditing = true; updateComposerActions() })
prompt.addEventListener('input', () => { composerEditing = true; drafts[mode] = prompt.value; resizePrompt(); updateComposerActions() })
transcript.addEventListener('pointerdown', () => {
  if (!prompt.value && !attachments[mode].length && !composerExpanded) {
    composerEditing = false
    prompt.blur()
    updateComposerActions()
  }
}, { passive: true })
window.addEventListener('resize', resizePrompt)
prompt.addEventListener('paste', event => {
  if (mode !== 'chat' || $('attach').disabled) return
  const images = [...event.clipboardData.files].filter(file => imageTypes.includes(file.type))
  if (!images.length) return
  if (!event.clipboardData.getData('text/plain')) event.preventDefault()
  void addFiles(images)
})
prompt.addEventListener('keydown', event => {
  if (event.key === 'Escape' && composerExpanded) { event.preventDefault(); setComposerExpanded(false); return }
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing && !$('send').disabled) {
    event.preventDefault()
    $('composer').requestSubmit()
  }
})

$('stop').addEventListener('click', () => {
  if (mode === 'chat') chat.run?.abort()
  else if (work.session?.status === 'running') {
    const id = encodeURIComponent(work.selected)
    workMutation('stop', async () => {
      const { session } = await workRequest('/sessions/' + id + '/cancel', { method: 'POST' })
      return session
    })
  }
})

dark.addEventListener('change', applyTheme)
reducedMotion.addEventListener('change', render)
applyTheme()
render()
$('chat-history').setAttribute('aria-pressed', 'true')
resizePrompt()
void loadModelPicker()
if (desktopControl) void initializeDesktop()
