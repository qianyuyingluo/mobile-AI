import { execFile, spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { delimiter, extname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const isWindows = process.platform === 'win32'
const sessionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u
const maxEventLength = 2 * 1024 * 1024
const workImagePath = /^\.yingluo-uploads\/turn-[A-Za-z0-9]+\/file-[1-8]\.(?:jpg|jpeg|png|webp|gif)$/u
export const reasoningEfforts = {
  codex: ['low', 'medium', 'high', 'xhigh'],
  deepseek: ['off', 'low', 'high', 'max'],
}

function readEnv(env, name) {
  if (!isWindows) return env[name]
  return Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
}

async function executable(file) {
  try {
    if (!(await stat(file)).isFile()) return false
    await access(file, isWindows ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function findCommand(name, env) {
  const suffixes = !isWindows || extname(name) ? [''] : ['.exe', '.com', '.cmd', '.bat']
  const roots = isAbsolute(name) || /[\\/]/u.test(name)
    ? ['']
    : (readEnv(env, 'PATH') ?? '').split(delimiter).map(root => root.replace(/^"|"$/gu, '')).filter(isAbsolute)
  for (const root of roots) {
    for (const suffix of suffixes) {
      const file = resolve(root, `${name}${suffix}`)
      if (await executable(file)) return file
    }
  }
  return undefined
}

async function windowsInstallRoots(env) {
  const windows = readEnv(env, 'SystemRoot')
  if (!isWindows || !windows) return {}
  const powershell = join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const command = [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    "$roots = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'",
    "$harness = @(Get-ItemProperty -Path $roots -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq 'DeepSeek Harness' -and $_.InstallLocation } | ForEach-Object { $_.InstallLocation })",
    "$codex = @(Get-AppxPackage -Name OpenAI.Codex -ErrorAction SilentlyContinue | ForEach-Object { $_.InstallLocation })",
    '@{ harness = $harness; codex = $codex } | ConvertTo-Json -Compress',
  ].join('\n')
  try {
    const { stdout } = await exec(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 4_000 })
    return JSON.parse(stdout)
  } catch {
    return {}
  }
}

async function installedExecutable(roots, relativePath) {
  for (const root of Array.isArray(roots) ? roots : []) {
    if (typeof root !== 'string' || !isAbsolute(root)) continue
    const file = join(root, ...relativePath)
    if (await executable(file)) return file
  }
  return undefined
}

function agentDescriptor(id, launch, override, name) {
  if (launch) return { id, available: true, ...launch }
  const reason = override
    ? `${override} 指定的可执行文件无法访问。`
    : `未找到 ${name}。请安装到 PATH，或在电脑上设置 ${id === 'codex' ? 'YINGLUO_CODEX_COMMAND' : 'YINGLUO_DSH_COMMAND'}。`
  return { id, available: false, reason }
}

export async function discoverAgents({ env = process.env } = {}) {
  const codexOverride = readEnv(env, 'YINGLUO_CODEX_COMMAND')?.trim()
  const dshOverride = readEnv(env, 'YINGLUO_DSH_COMMAND')?.trim()
  let [codex, dsh] = await Promise.all([
    findCommand(codexOverride || 'codex', env),
    findCommand(dshOverride || 'dsh', env),
  ])
  if ((!codex && !codexOverride) || (!dshOverride && isWindows)) {
    const roots = await windowsInstallRoots(env)
    if (!codex && !codexOverride) codex = await installedExecutable(roots.codex, ['app', 'resources', 'codex.exe'])
    if (!dshOverride && isWindows) {
      dsh = await installedExecutable(roots.harness, ['resources', 'runtime', 'cli', 'bin', 'dsh.cmd']) ?? dsh
    }
  }
  return {
    codex: agentDescriptor('codex', codex && { command: codex, prefix: [] }, codexOverride && 'YINGLUO_CODEX_COMMAND', 'Codex'),
    deepseek: agentDescriptor('deepseek', dsh && { command: dsh, prefix: [], supportsReasoning: false },
      dshOverride && 'YINGLUO_DSH_COMMAND', 'DeepSeek Harness'),
  }
}

function taskArguments(id, resumeId, effort, images) {
  if (id === 'codex') {
    return ['exec', ...(resumeId ? ['resume', resumeId] : []), '--json', '--skip-git-repo-check',
      '-c', "sandbox_mode='workspace-write'", '-c', "approval_policy='never'",
      ...(effort ? ['-c', "model_reasoning_effort='" + effort + "'"] : []),
      ...images.flatMap(path => ['--image', path]), '-']
  }
  return ['headless', '--json', '--permission-mode', 'workspace-write', '--approval-policy', 'ask',
    ...(effort ? ['--reasoning-effort', effort] : []),
    ...(resumeId ? ['--session-id', resumeId] : []), '-']
}

function launchAgent(agent, projectDir, args, agentHome) {
  const env = agent.id === 'deepseek' && agentHome ? { ...process.env, DSH_HOME: agentHome } : process.env
  const options = { cwd: projectDir, env, windowsHide: true, detached: !isWindows, stdio: ['pipe', 'pipe', 'pipe'] }
  const argv = [...agent.prefix, ...args]
  if (!isWindows || !/^\.(?:cmd|bat)$/iu.test(extname(agent.command))) return spawn(agent.command, argv, options)

  // Only fixed options and validated session IDs reach cmd.exe. The script's
  // path is expanded inside quotes once, and the prompt always uses stdin.
  if (!argv.every(value => workImagePath.test(value) || /^[A-Za-z0-9_.='-]+$/u.test(value))) {
    throw new Error('命令参数不适用于 Windows 启动脚本。')
  }
  const commandLine = `""%YINGLUO_AGENT_SCRIPT%" ${argv.join(' ')}"`
  return spawn(readEnv(process.env, 'ComSpec') || 'cmd.exe', ['/d', '/v:off', '/s', '/c', commandLine], {
    ...options, windowsVerbatimArguments: true, env: { ...env, YINGLUO_AGENT_SCRIPT: agent.command },
  })
}

function terminate(child) {
  if (!child.pid) return
  if (isWindows) {
    if (child.exitCode !== null) return
    const root = readEnv(process.env, 'SystemRoot')
    const taskkill = root ? join(root, 'System32', 'taskkill.exe') : 'taskkill.exe'
    execFile(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, error => {
      if (error && child.exitCode === null) child.kill()
    })
    return
  }
  const kill = signal => {
    try { process.kill(-child.pid, signal) } catch (error) { if (error.code !== 'ESRCH') child.kill(signal) }
  }
  kill('SIGTERM')
  const timer = setTimeout(() => kill('SIGKILL'), 750)
  timer.unref()
}

function displayText(value) {
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, '')
}

function reportFailure(failure, agent) {
  // Provider errors can include a request body, URL, or credentials. Inspect
  // them here and report only fixed, actionable diagnostics to the phone.
  const details = typeof failure === 'string' ? failure : JSON.stringify(failure ?? '')
  if (agent.id === 'deepseek' && /MISSING_CREDENTIAL/iu.test(details) && details.includes('DEEPSEEK_API_KEY')) {
    return '电脑端 DeepSeek 缺少 API Key。请在电脑的 Harness 设置 → 模型 → DeepSeek 中填写，或设置 DEEPSEEK_API_KEY 后重启 Work。'
  }
  if (/missing.credential|no api key|api key is missing|missing.*key|not logged in|\b401\b|unauthorized|incorrect api key|invalid.credential|authentication/iu.test(details)) {
    return agent.id === 'codex'
      ? 'Codex 认证失败。请在电脑上登录 Codex 或配置所需的 API 密钥。'
      : 'DeepSeek Harness 认证失败。请在电脑上配置模型和 API 密钥。'
  }
  if (/\b429\b|rate.limit|quota/iu.test(details)) return '模型服务达到限流或额度上限。'
  if (/session.*not found|unknown (session|thread)|no session found|does not exist/iu.test(details)) return '电脑上的该会话已找不到。请新建会话。'
  if (/outside.*workspace|permission.denied|sandbox|approval/iu.test(details)) return '任务遇到权限限制。请检查电脑上的 agent 设置或将操作范围限制在项目目录内。'
  return `${agent.id === 'codex' ? 'Codex' : 'DeepSeek Harness'} 未能完成本轮。请检查电脑上的 agent、模型和网络设置。`
}

function applyEvent(event, state, onEvent) {
  const publish = (type, text) => { if (typeof text === 'string' && text.trim()) onEvent({ type, text: displayText(text) }) }
  const message = (text, append = false) => {
    if (typeof text !== 'string') return
    state.text = append && state.text ? `${state.text}\n\n${text}` : text
    publish('message', text)
  }
  const setId = value => {
    if (typeof value !== 'string' || !sessionPattern.test(value) || value === state.resumeId) return
    state.resumeId = value
    onEvent({ type: 'session', resumeId: value })
  }
  const setReason = reason => {
    if (reason?.kind === 'error') state.terminalFailure = reason.error ?? reason
    if (reason?.kind === 'blocked') state.terminalFailure = 'approval blocked'
    if (['aborted', 'cancelled', 'interrupted'].includes(reason?.kind)) state.cancelled = true
  }

  switch (event.type) {
    case 'thread.started':
      setId(event.thread_id)
      break
    case 'turn.started':
      publish('status', 'Codex 正在处理')
      break
    case 'item.started':
      if (event.item?.type === 'command_execution') publish('status', 'Codex 正在运行项目命令')
      if (event.item?.type === 'mcp_tool_call') publish('status', 'Codex 正在调用工具')
      break
    case 'item.completed':
      if (event.item?.type === 'agent_message') message(event.item.text)
      if (event.item?.type === 'file_change') publish('status', 'Codex 更新了项目文件')
      break
    case 'turn.completed':
      state.finished = true
      break
    case 'turn.failed':
      state.terminalFailure = event.error ?? event
      break
    case 'error':
      state.failure = event.error ?? event.message ?? event
      break
    case 'session':
      setId(event.sessionId)
      break
    case 'status':
      if (event.phase === 'turn_start') publish('status', 'DeepSeek Harness 正在处理')
      if (event.phase === 'turn_end') setReason(event.reason)
      break
    case 'text':
      message(event.text, true)
      break
    case 'tool_call': {
      const name = typeof event.tool === 'string' && /^[\w.-]{1,80}$/u.test(event.tool) ? `：${event.tool}` : ''
      publish('status', `DeepSeek Harness 正在调用工具${name}`)
      break
    }
    case 'tool_result':
      if (event.status === 'error') publish('status', 'DeepSeek Harness 的工具返回了错误')
      break
    case 'session_event': {
      setId(event.sessionId)
      if (event.event?.type === 'turn/start') publish('status', 'DeepSeek Harness 正在处理')
      if (event.event?.type === 'turn/end') setReason(event.event.data?.reason)
      if (event.event?.type === 'assistant/message') {
        const blocks = event.event.data?.message?.content
        if (Array.isArray(blocks)) message(blocks.filter(block => block?.type === 'text').map(block => block.text).join(''), true)
      }
      break
    }
    case 'result':
    case 'final':
      setId(event.sessionId)
      setReason(event.reason)
      state.finished = true
      if (typeof (event.text ?? event.output) === 'string') state.text = event.text ?? event.output
      break
  }
}

export async function runAgent(agent, { projectDir, prompt, resumeId, agentHome, reasoningEffort, images = [], signal, onEvent = () => {} }) {
  if (!agent?.available) throw new Error(agent?.reason ?? '电脑上没有可用的 agent。')
  if (agent.id !== 'codex' && agent.id !== 'deepseek') throw new Error('不支持的工作 agent。')
  if (resumeId !== undefined && (typeof resumeId !== 'string' || !sessionPattern.test(resumeId))) throw new Error('会话 ID 无效。')
  if (reasoningEffort !== undefined && !reasoningEfforts[agent.id].includes(reasoningEffort)) throw new Error('推理等级无效。')
  if (!images.every(path => typeof path === 'string' && workImagePath.test(path))) throw new Error('图片路径无效。')
  signal?.throwIfAborted()

  return new Promise((resolveRun, rejectRun) => {
    const child = launchAgent(agent, projectDir, taskArguments(agent.id, resumeId, reasoningEffort, images), agentHome)
    const state = { text: '', resumeId, finished: false, failure: undefined, terminalFailure: undefined, cancelled: false }
    let pending = ''
    let droppingLine = false
    let diagnostics = ''
    let callbackFailure
    const abort = () => terminate(child)
    const unlisten = () => signal?.removeEventListener('abort', abort)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()

    function parseLine(line) {
      if (!line.startsWith('{') || line.length > maxEventLength || callbackFailure) return
      let event
      try { event = JSON.parse(line) } catch { return }
      try { applyEvent(event, state, onEvent) } catch (error) {
        callbackFailure = error
        abort()
      }
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      const lines = chunk.split('\n')
      for (const line of lines.slice(0, -1)) {
        if (!droppingLine) parseLine(pending + line)
        pending = ''
        droppingLine = false
      }
      if (droppingLine) return
      pending += lines.at(-1)
      if (pending.length > maxEventLength) {
        pending = ''
        droppingLine = true
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-8192) })
    child.stdin.on('error', () => {})
    child.once('error', error => {
      unlisten()
      rejectRun(signal?.aborted ? signal.reason : new Error(`无法启动 ${agent.id === 'codex' ? 'Codex' : 'DeepSeek Harness'}（${error.code ?? '运行失败'}）。`))
    })
    child.once('close', code => {
      unlisten()
      if (pending && !droppingLine) parseLine(pending)
      if (signal?.aborted) return rejectRun(signal.reason)
      if (callbackFailure) return rejectRun(callbackFailure)
      if (state.cancelled) return rejectRun(new DOMException('任务已取消。', 'AbortError'))
      if (code !== 0 || !state.finished || !state.resumeId || state.terminalFailure) {
        return rejectRun(new Error(reportFailure(state.terminalFailure ?? state.failure ?? diagnostics, agent)))
      }
      const text = displayText(state.text)
      if (state.failure && !text) return rejectRun(new Error(reportFailure(state.failure, agent)))
      if (!text.trim()) return rejectRun(new Error('Agent 本轮没有返回文字。'))
      resolveRun({ text, resumeId: state.resumeId })
    })
    child.stdin.end(prompt, 'utf8')
  })
}
