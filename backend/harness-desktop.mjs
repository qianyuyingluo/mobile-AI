import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { fileType } from './desktop-files.mjs'

export async function sendHarnessDesktopMessage(sessionId, text, requestId, { attachments = [] } = {}) {
  const path = join(process.env.LOCALAPPDATA || homedir(), 'YingluoWork', 'harness-desktop.json')
  const target = JSON.parse(await readFile(path, 'utf8').catch(() => {
    throw new Error('请先在 Harness 桌面启用桌面同步插件。')
  }))
  if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535 ||
    !/^[a-f0-9]{64}$/u.test(target.token)) throw new Error('Harness 同步连接配置无效。')
  const health = await fetch('http://127.0.0.1:' + target.port + '/health', {
    headers: { Authorization: 'Bearer ' + target.token }, signal: AbortSignal.timeout(5000),
  })
  if (!health.ok) throw new Error('Harness 桌面同步连接已失效，请重新打开 Harness。')
  const capability = await health.json()
  if (attachments.some(f => fileType(f.path).startsWith('image/')) && capability.protocol !== 2) {
    throw new Error('Harness 图片同步插件需要更新，请重新打开 Harness 后发送图片。')
  }
  const response = await fetch('http://127.0.0.1:' + target.port + '/prompt', {
    method: 'POST', headers: { Authorization: 'Bearer ' + target.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, text, requestId, images: attachments.filter(f => fileType(f.path).startsWith('image/'))
      .map(f => ({ name: f.name, mediaType: fileType(f.path), data: f.data.toString('base64') })) }), signal: AbortSignal.timeout(30000),
  })
  if (!response.ok) throw new Error('Harness 桌面尚未接受消息。')
  return response.json()
}
