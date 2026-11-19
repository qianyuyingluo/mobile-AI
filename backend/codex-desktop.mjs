import { createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'
import { fileType } from './desktop-files.mjs'

// The installed desktop owns the thread and applies its existing model/permissions.
// This local IPC protocol is versioned; never fall back to a second CLI process.
export async function connectCodexDesktop(path = '\\\\.\\pipe\\codex-ipc') {
  const socket = createConnection(path)
  const pending = new Map()
  let bytes = Buffer.alloc(0), clientId = 'initializing-client'
  function close(error = new Error('Codex 桌面连接已断开，请核对原会话后重试。')) {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error) }
    pending.clear()
    socket.destroy()
  }
  socket.on('error', () => close(new Error('无法连接 Codex，请先打开桌面软件。')))
  socket.on('close', () => close())
  socket.on('data', chunk => {
    bytes = Buffer.concat([bytes, chunk])
    while (bytes.length >= 4) {
      const size = bytes.readUInt32LE()
      if (size > 16 * 1024 * 1024) return close(new Error('Codex IPC 响应过大。'))
      if (bytes.length < size + 4) return
      let response
      try { response = JSON.parse(bytes.subarray(4, size + 4).toString()) }
      catch { return close(new Error('Codex IPC 响应格式无效。')) }
      bytes = bytes.subarray(size + 4)
      if (response.type !== 'response') continue
      const p = pending.get(response.requestId)
      if (!p) continue
      clearTimeout(p.timer)
      pending.delete(response.requestId)
      if (response.resultType === 'success') p.resolve(response)
      else p.reject(new Error(response.error === 'no-client-found'
        ? '请先在 Codex 桌面打开这条会话，再从手机发送。'
        : 'Codex 桌面未接受请求：' + String(response.error).slice(0, 160)))
    }
  })
  function request(method, params, version = 0, targetClientId) {
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId)
        reject(new Error('Codex 桌面请求超时，请核对原会话是否已收到消息。'))
      }, 30000)
      pending.set(requestId, { resolve, reject, timer })
      const payload = Buffer.from(JSON.stringify({ type: 'request', requestId, sourceClientId: clientId,
        method, params, version, targetClientId, timeoutMs: 28000 }))
      const header = Buffer.alloc(4)
      header.writeUInt32LE(payload.length)
      socket.write(Buffer.concat([header, payload]))
    })
  }
  try {
    const initialized = await request('initialize', { clientType: 'ayane-mobile' })
    clientId = initialized.result.clientId
    return { request, close }
  } catch (error) { close(); throw error }
}

export async function sendCodexDesktopMessage(threadId, text, requestId = randomUUID(), { pipe, attachments = [] } = {}) {
  const client = await connectCodexDesktop(pipe)
  try {
    const owner = await client.request('thread-owner-discovery', { hostId: 'local', conversationId: threadId }, 1)
    await client.request('thread-follower-start-turn', {
      conversationId: threadId,
      turnStart: {
        request: { threadId, clientUserMessageId: requestId, input: [{ type: 'text', text, text_elements: [] },
          ...attachments.filter(f => fileType(f.path).startsWith('image/')).map(f => ({ type: 'localImage', path: f.path }))] },
        context: { inheritThreadSettings: true },
      },
    }, 2, owner.handledByClientId)
    return { accepted: true }
  } finally { client.close() }
}
