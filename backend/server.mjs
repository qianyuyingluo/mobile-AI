import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdir, open, readFile, realpath, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { homedir, networkInterfaces } from 'node:os'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { discoverAgents, reasoningEfforts, runAgent } from './agents.mjs'
import { openState, publicSession } from './state.mjs'
import { createWorkAssistant } from './assistant.mjs'
import { recentAgentSessions } from './recent-sessions.mjs'
import { attachmentPrompt, attachmentText, decodeAttachments, imagePaths, saveAttachments } from './work-attachments.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const requireQr = createRequire(join(root, 'app', 'packages', 'client', 'ui-settings-general', 'package.json'))
const titles = { codex: 'Codex', deepseek: 'DeepSeek Harness', neko: '绫音' }
const name = '绫音'
const version = '1.0.0'
const maxBodyLength = 65536
const previewFiles = new Map([
  ['/', ['app/mobile/ui/index.html', 'text/html']],
  ['/control', ['app/mobile/ui/index.html', 'text/html']],
  ['/app.css', ['app/mobile/ui/app.css', 'text/css']],
  ['/app.js', ['app/mobile/ui/app.js', 'text/javascript']],
  ['/http.js', ['app/mobile/ui/http.js', 'text/javascript']],
  ['/event-stream.js', ['app/mobile/ui/event-stream.js', 'text/javascript']],
  ['/image-viewer.js', ['app/mobile/ui/image-viewer.js', 'text/javascript']],
  ['/reading-navigation.js', ['app/mobile/ui/reading-navigation.js', 'text/javascript']],
  ['/chat-providers.js', ['app/mobile/ui/chat-providers.js', 'text/javascript']],
  ['/assets/picker/model-picker.js', ['app/mobile/picker/dist/model-picker.js', 'text/javascript']],
  ['/assets/picker/model-picker.css', ['app/mobile/picker/dist/model-picker.css', 'text/css']],
  ['/assets/design-platform.css', ['app/packages/client/ui-theme/src/styles/design-platform.css', 'text/css']],
  ['/assets/avatar.webp', ['app/packages/client/ui-brand-official/src/client/assets/neko-avatar.webp', 'image/webp']],
  ['/assets/animations/still.png', ['yingluo-animation-v2/frames-hd/idle/01.png', 'image/png']],
  ...['idle', 'waiting', 'running', 'failed'].map(key =>
    ['/assets/animations/' + key + '.png', ['yingluo-animation-v2/animations/' + key + '.png', 'image/png']]),
])

class RequestError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(data))
}

async function body(request, limit = maxBodyLength) {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
    request.resume()
    throw new RequestError(415, '请发送 JSON 请求。')
  }
  const chunks = []
  let length = 0
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    length += chunk.length
    if (length > limit) {
      request.resume()
      throw new RequestError(413, '消息过长。')
    }
    chunks.push(chunk)
  }
  let parsed
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new RequestError(400, '请求内容格式不正确。') }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new RequestError(400, '请求内容格式不正确。')
  }
  return parsed
}

async function preview(response, pathname) {
  const [file, type] = previewFiles.get(pathname)
  let bytes
  try { bytes = await readFile(join(root, file)) }
  catch (error) {
    if (error.code === 'ENOENT') throw new RequestError(404, '此电脑未安装手机界面资源。')
    throw error
  }
  response.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': type.startsWith('image/') ? 'public, max-age=3600' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(bytes)
}

function storageRoot(env) {
  if (process.platform === 'win32') return join(env.LOCALAPPDATA || homedir(), 'YingluoWork')
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'YingluoWork')
  return join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'yingluo-work')
}

async function acquireLock(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, 'server.lock')
  try {
    const file = await open(path, 'wx', 0o600)
    await file.writeFile(String(process.pid))
    await file.close()
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const owner = Number(await readFile(path, 'utf8'))
    if (!Number.isSafeInteger(owner) || owner < 1) throw new Error('项目数据目录正在启动另一个服务。')
    try { process.kill(owner, 0) }
    catch (probe) {
      if (probe.code !== 'ESRCH') throw new Error('此项目已在另一个电脑服务中打开。')
      await rm(path)
      return acquireLock(directory)
    }
    throw new Error('此项目已在另一个电脑服务中打开。')
  }
  return () => rm(path, { force: true })
}

function protectOutput(env) {
  const secrets = Object.entries(env)
    .filter(([key, value]) => /(?:TOKEN|SECRET|PASSWORD|(?:API|ACCESS)_KEY)$/i.test(key) && value?.length >= 8)
    .map(([, value]) => value)
  return text => secrets.reduce((safe, secret) => safe.replaceAll(secret, '[已隐藏]'), String(text))
}

/** Start the paired computer service for one explicitly selected directory. */
export async function startServer({
  projectDir = process.cwd(), host = '127.0.0.1', port = 3197, dataDir,
  env = process.env, agents, runner = runAgent, assistant, recent = recentAgentSessions,
} = {}) {
  const projectPath = await realpath(projectDir)
  if (!(await stat(projectPath)).isDirectory()) throw new Error('请选择一个项目文件夹。')
  const project = basename(projectPath) || projectPath
  const projectId = createHash('sha256').update(projectPath).digest('hex').slice(0, 24)
  const drivers = agents ?? await discoverAgents({ harnessRoot: join(root, 'app'), env })
  const dispatch = assistant ?? createWorkAssistant(env)
  const available = Object.fromEntries(
    ['codex', 'deepseek'].map(key => [key, { available: drivers[key]?.available === true }]),
  )
  available.neko = { available: dispatch !== undefined }
  const supportedEfforts = Object.fromEntries(Object.entries(reasoningEfforts)
    .filter(([agent]) => available[agent].available && drivers[agent]?.supportsReasoning !== false))
  const sanitize = protectOutput(env)
  const release = await acquireLock(resolve(dataDir || storageRoot(env), projectId))
  let state
  try { state = openState(resolve(dataDir || storageRoot(env), projectId)) }
  catch (error) { await release(); throw error }
  let pairingCode = randomBytes(5).toString('hex').toUpperCase()
  let consumed = false
  let expiresAt = Date.now() + 15 * 60 * 1000
  const desktopToken = randomBytes(32).toString('base64url')
  let recentCache
  let active

  function listRecent() {
    if (!recentCache || Date.now() >= recentCache.expires) {
      recentCache = { expires: Date.now() + 15000, records: Promise.resolve()
        .then(() => recent(projectPath, env, available)).catch(() => []) }
    }
    return recentCache.records
  }

  function addEvent(session, event) {
    if (event.type === 'session') session.resumeId = event.resumeId
    else if (event.text) {
      session.events.push({ type: event.type, text: sanitize(event.text).slice(0, 8000),
        ...(event.sessionId ? { sessionId: event.sessionId } : {}) })
      if (session.events.length > 240) session.events.splice(0, session.events.length - 240)
    }
    state.save(session)
  }

  function setStatus(session, status) {
    session.status = status
    state.save(session)
  }

  async function runDirect(session, prompt, signal, files, previews, parent) {
    const result = await runner(drivers[session.agent], {
      projectDir: projectPath, prompt: attachmentPrompt(prompt, files, previews), resumeId: session.resumeId, signal,
      ...(session.agentHome && { agentHome: session.agentHome }),
      ...(supportedEfforts[session.agent]?.includes(session.reasoningEffort) && { reasoningEffort: session.reasoningEffort }),
      ...(session.agent === 'codex' && files.length && { images: imagePaths(files) }),
      onEvent(event) {
        addEvent(session, event)
        if (parent && event.type !== 'session') addEvent(parent, event)
      },
    })
    signal.throwIfAborted()
    if (result.resumeId) session.resumeId = result.resumeId
    const text = sanitize(result.text).slice(0, 100000)
    session.messages.push({ role: 'assistant', text })
    setStatus(session, 'idle')
    return text
  }

  async function execute(session, prompt, files, previews, job) {
    const signal = job.controller.signal
    try {
      if (session.agent !== 'neko') {
        await runDirect(session, prompt, signal, files, previews)
        return
      }
      const settings = { project, available: ['codex', 'deepseek'].filter(key => available[key].available), signal }
      let answer = await dispatch(session.messages, settings)
      if (answer.task) {
        signal.throwIfAborted()
        const { agent, prompt: task } = answer.task
        if (!settings.available.includes(agent)) throw new Error('请求的 agent 当前不可用。')
        const child = state.create(agent, titles[agent] + ' · ' + task.slice(0, 36))
        job.childId = child.id
        child.messages.push({ role: 'user', text: task, ...(files.length && { attachments: files }) })
        setStatus(child, 'running')
        addEvent(session, { type: 'dispatch', text: '已派发给 ' + titles[agent], sessionId: child.id })
        let result
        try { result = await runDirect(child, task, signal, files, previews, session) }
        catch (error) {
          setStatus(child, signal.aborted ? 'cancelled' : 'failed')
          addEvent(child, { type: 'error', text: error.message })
          if (signal.aborted) throw error
          result = '任务失败。' + sanitize(error.message)
        }
        try { answer = await dispatch(session.messages, { ...settings, result }) }
        catch (error) {
          if (signal.aborted) throw error
          answer = { text: result }
        }
      }
      session.messages.push({ role: 'assistant', text: sanitize(answer.text).slice(0, 100000) })
      setStatus(session, 'idle')
    } catch (error) {
      setStatus(session, signal.aborted ? 'cancelled' : 'failed')
      addEvent(session, { type: signal.aborted ? 'status' : 'error',
        text: signal.aborted ? '任务已取消。' : error.message })
    }
  }

  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname
      const desktopHost = '127.0.0.1:' + server.address().port
      const desktopLocal = request.socket.remoteAddress === '127.0.0.1' && request.headers.host === desktopHost
      if (pathname === '/control' && !desktopLocal) throw new RequestError(403, '请在本机打开控制页面。')
      if (request.method === 'GET' && previewFiles.has(pathname)) return await preview(response, pathname)
      if (pathname === '/v1/control' || pathname === '/v1/control/pairing') {
        if (request.method !== 'POST' || !desktopLocal || request.headers.origin !== 'http://' + desktopHost) {
          throw new RequestError(403, '请在本机打开控制页面。')
        }
        if (pathname === '/v1/control') return json(response, 200, { token: desktopToken, addresses: lanOrigins(host, server.address().port) })
        const { origin } = await body(request)
        if (!lanOrigins(host, server.address().port).includes(origin)) throw new RequestError(400, '请选择本机的局域网地址。')
        const code = randomBytes(5).toString('hex').toUpperCase()
        const qr = await requireQr('qrcode').toDataURL(pairLink(origin, code), { margin: 2, width: 300 })
        pairingCode = code
        consumed = false
        expiresAt = Date.now() + 15 * 60 * 1000
        return json(response, 200, { qr, code, expiresAt })
      }
      if (request.method === 'GET' && pathname === '/v1/health') {
        return json(response, 200, { name, version })
      }
      if (request.method === 'POST' && pathname === '/v1/pair') {
        const input = await body(request)
        if (consumed || Date.now() >= expiresAt) throw new RequestError(410, '配对码已失效，请重新启动电脑服务。')
        const code = typeof input.code === 'string' ? input.code.trim().toUpperCase() : ''
        if (!/^[A-F0-9]{10}$/.test(code) || !timingSafeEqual(Buffer.from(code), Buffer.from(pairingCode))) {
          throw new RequestError(401, '配对码不正确。')
        }
        const label = typeof input.label === 'string' ? input.label.trim().slice(0, 80) : ''
        const token = state.pair(label || '手机')
        consumed = true
        return json(response, 200, { token })
      }
      if (!pathname.startsWith('/v1/work')) throw new RequestError(404, '页面不存在。')
      const token = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/i)?.[1]
      if (!token || (!(token === desktopToken && desktopLocal) && !state.authorized(token))) {
        throw new RequestError(401, '请先连接电脑。')
      }

      if (request.method === 'GET' && pathname === '/v1/work') {
        const rows = state.list()
        const imported = new Set(rows.filter(row => row.resumeId).map(row => row.agent + ':' + row.resumeId))
        const recentSessions = (await listRecent()).filter(row => !imported.has(row.agent + ':' + row.id))
          .map(({ agent, id, title, updatedAt, canResume }) => ({ agent, id, title: sanitize(title).slice(0, 120), updatedAt, canResume }))
        const sessions = rows.map(({ id, agent, title, status, updatedAt }) => ({ id, agent, title, status, updatedAt }))
        return json(response, 200, { project: { name: project }, agents: available, sessions, deleteSessions: true,
          attachments: true, reasoningEfforts: supportedEfforts, recentSessions })
      }
      if (request.method === 'POST' && pathname === '/v1/work/sessions') {
        const input = await body(request)
        if (typeof input.agent !== 'string' || !Object.hasOwn(available, input.agent) || !available[input.agent].available) {
          throw new RequestError(400, '此 agent 当前不可用。')
        }
        const title = typeof input.title === 'string' ? input.title.trim().slice(0, 80) : ''
        if (input.recentId !== undefined) {
          const entry = (await listRecent()).find(row => row.agent === input.agent && row.id === input.recentId)
          if (!entry) throw new RequestError(404, '找不到该电脑会话。')
          if (entry.canResume === false) throw new RequestError(409, '请在电脑端继续使用 Agent 预设的会话。')
          const existing = state.list().find(row => row.agent === entry.agent && row.resumeId === entry.id)
          return json(response, existing ? 200 : 201, {
            session: publicSession(existing ?? state.create(entry.agent, sanitize(entry.title).slice(0, 80) || titles[entry.agent], entry.id, entry.home)),
          })
        }
        return json(response, 201, { session: publicSession(state.create(input.agent, title || titles[input.agent])) })
      }
      const route = pathname.match(/^\/v1\/work\/sessions\/([a-f0-9-]{36})(?:\/(messages|cancel))?$/)
      if (!route) throw new RequestError(404, '页面不存在。')
      const [_, id, action] = route
      let session = state.get(id)
      if (!session) throw new RequestError(404, '找不到该会话。')
      if (request.method === 'GET' && !action) return json(response, 200, { session: publicSession(session) })
      if (request.method === 'DELETE' && !action) {
        request.resume()
        if (active?.id === id || active?.childId === id || session.status === 'running') {
          throw new RequestError(409, '请先停止这条会话的任务。')
        }
        state.delete(id)
        return json(response, 200, { deleted: id })
      }

      if (request.method === 'POST' && action === 'messages') {
        const input = await body(request, 18 * 1024 * 1024)
        const prompt = typeof input.text === 'string' ? input.text.trim() : ''
        const effort = input.reasoningEffort
        if (effort !== undefined && (!supportedEfforts[session.agent] ||
          (effort !== '' && !supportedEfforts[session.agent].includes(effort)))) {
          throw new RequestError(400, '该助手不支持此推理等级。')
        }
        let uploads
        try { uploads = decodeAttachments(input.attachments) }
        catch (error) { throw new RequestError(400, error.message) }
        if ((!prompt && !uploads.length) || prompt.length > 20000) throw new RequestError(400, '请输入消息或添加附件，消息最多 20000 个字符。')
        if (active) throw new RequestError(409, '当前项目已有任务在运行。')
        session = state.get(id)
        if (!session) throw new RequestError(404, '找不到该会话。')
        if (!available[session.agent]?.available) throw new RequestError(409, '此 agent 当前不可用。')
        const controller = new AbortController()
        const job = { id, controller }
        active = job
        try {
          const files = uploads.length ? await saveAttachments(projectPath, uploads) : []
          if (effort === '') delete session.reasoningEffort
          else if (effort !== undefined) session.reasoningEffort = effort
          session.events = session.events.filter(event => event.type === 'dispatch')
          session.messages.push({ role: 'user', text: prompt, ...(files.length && { attachments: files }) })
          setStatus(session, 'running')
          job.promise = execute(session, prompt, files, attachmentText(uploads, files), job).finally(() => { active = undefined })
        } catch (error) {
          active = undefined
          throw error
        }
        return json(response, 202, { session: publicSession(session) })
      }
      if (request.method === 'POST' && action === 'cancel') {
        request.resume()
        if (active?.id === id || active?.childId === id) active.controller.abort()
        return json(response, 200, { session: publicSession(session) })
      }
      throw new RequestError(405, '请求方法不支持。')
    } catch (error) {
      if (error instanceof RequestError) return json(response, error.status, { error: error.message })
      console.error(sanitize(error.message))
      json(response, 500, { error: '电脑服务无法处理请求。' })
    }
  })
  try {
    await new Promise((ready, failed) => {
      server.once('error', failed)
      server.listen(port, host, () => { server.removeListener('error', failed); ready() })
    })
  } catch (error) {
    state.close()
    await release()
    throw error
  }

  return {
    host, port: server.address().port, project, available, get pairingCode() { return pairingCode },
    async close() {
      const closed = new Promise((ready, failed) => server.close(error => error ? failed(error) : ready()))
      active?.controller.abort()
      await closed
      await active?.promise
      state.close()
      await release()
    },
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    project: { type: 'string' }, host: { type: 'string' }, port: { type: 'string' },
    lan: { type: 'boolean' }, qr: { type: 'boolean' }, 'data-dir': { type: 'string' }, help: { type: 'boolean' },
  } })
  if (values.help) {
    console.log('node backend/server.mjs --project <项目目录> [--lan | --host <本地 IP>] [--port 3197] [--qr]')
    return
  }
  const port = Number(values.port ?? process.env.YINGLUO_PORT ?? '3197')
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('端口必须是 0–65535 之间的整数。')
  if (values.lan && values.host) throw new Error('请选择 --lan 或 --host。')
  const service = await startServer({
    projectDir: values.project ?? process.env.YINGLUO_PROJECT_DIR ??
      (process.cwd() === join(root, 'backend') ? root : process.cwd()),
    host: values.host ?? (values.lan ? '0.0.0.0' : '127.0.0.1'),
    port, dataDir: values['data-dir'] ?? process.env.YINGLUO_DATA_DIR,
  })
  console.log('项目  ' + service.project)
  const origins = lanOrigins(service.host, service.port)
  for (const origin of origins) console.log('Work 地址  ' + origin)
  if (['0.0.0.0', '127.0.0.1'].includes(service.host)) {
    console.log('电脑控制页  http://127.0.0.1:' + service.port + '/control')
  }
  console.log('一次性配对码（15 分钟有效）  ' + service.pairingCode)
  console.log(Object.entries(service.available).map(([key, item]) => titles[key] + (item.available ? ' 可用' : ' 未配置')).join('  ·  '))
  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    try { await service.close() }
    catch (error) { console.error(error.message); process.exitCode = 1 }
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  if (values.qr) {
    const origin = origins.find(url => !/^http:\/\/(?:127\.|localhost[:/]|\[::1\])/.test(url))
    if (origin) await printPairQr(origin, service.pairingCode)
    else console.log('请绑定局域网地址后生成手机配对码。')
  }
}

function lanOrigins(host, port) {
  const ips = host === '0.0.0.0'
    ? Object.values(networkInterfaces()).flat().filter(item => item.family === 'IPv4' && !item.internal
      && !/^(?:169\.254\.|198\.(?:18|19)\.)/u.test(item.address)).map(item => item.address)
    : [host]
  return [...new Set(ips.map(ip => 'http://' + (ip.includes(':') ? '[' + ip + ']' : ip) + ':' + port))]
}

function pairLink(origin, code) {
  const link = new URL('yingluo://pair')
  link.searchParams.set('url', origin)
  link.searchParams.set('code', code)
  return link.href
}

async function printPairQr(origin, code) {
  try {
    console.log(await requireQr('qrcode').toString(pairLink(origin, code), { type: 'terminal', small: true }))
    console.log('手机扫码后打开绫音，确认配对。')
  } catch {
    console.log('二维码组件不可用，可在手机 Work 模式输入上面的地址和配对码。')
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
