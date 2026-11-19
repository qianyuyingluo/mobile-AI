import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

export const name = 'ayane-desktop-sync'
export const inject = ['sessionController']

export async function apply(ctx, config) {
  const token = randomBytes(32).toString('hex')
  const server = createServer(async (request, response) => {
    const supplied = Buffer.from(request.headers.authorization?.replace(/^Bearer /, '') || '')
    const expected = Buffer.from(token)
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      response.writeHead(401).end()
      return
    }
    response.setHeader('Content-Type', 'application/json')
    try {
      if (request.method === 'GET' && request.url === '/health') {
        response.end(JSON.stringify({ ready: true, protocol: 2 }))
        return
      }
      if (request.method !== 'POST' || request.url !== '/prompt') {
        response.writeHead(404).end()
        return
      }
      let text = ''
      for await (const chunk of request) {
        text += chunk
        if (text.length > 18 * 1024 * 1024) throw new Error('Message too large')
      }
      const input = JSON.parse(text)
      if (typeof input.sessionId !== 'string' || typeof input.text !== 'string' || !input.text.trim() ||
        typeof input.requestId !== 'string') throw new Error('Invalid prompt')
      const result = await ctx.sessionController.prompt({
        sessionId: input.sessionId, requestId: input.requestId, mode: 'queue',
        content: [{ type: 'text', text: input.text }, ...(input.images || []).map(image => ({
          type: 'image', name: image.name, mediaType: image.mediaType, data: image.data,
        }))],
      }, new AbortController().signal)
      response.end(JSON.stringify(result))
    } catch {
      response.writeHead(409).end(JSON.stringify({ error: '桌面会话未接受消息。' }))
    }
  })
  ctx.on('dispose', async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(config.descriptor, { force: true })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  await mkdir(dirname(config.descriptor), { recursive: true })
  await writeFile(config.descriptor, JSON.stringify({ port: server.address().port, token }), { mode: 0o600 })
}
