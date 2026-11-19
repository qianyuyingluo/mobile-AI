import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { startServer } from '../../backend/server.mjs'
const require = createRequire(new URL('../apps/web/package.json', import.meta.url))
const { chromium } = require('playwright')
const folder = await mkdtemp(join(tmpdir(), 'ayane-memory-ui-'))
await mkdir(join(folder, 'project'))
const requests = []
let finish
const api = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*')
  if (req.method === 'OPTIONS') { res.end(); return }
  let body = ''; for await (const c of req) body += c
  requests.push(JSON.parse(body))
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const emit = content => res.write('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n')
  if (requests.length === 1) { emit('喵～'); res.end('data: [DONE]\n\n'); return }
  if (requests.length === 2) {
    for (const c of '好的，小林。<memory_update>{"add":[{"text":"用户希望称呼为小林"}]}</memory_update>') emit(c)
    finish = () => res.end('data: [DONE]\n\n')
    return
  }
  if (requests.length === 4) {
    emit('<memory_update>{"add":[{"text":"用户喜欢回答带一点喵"}]}</memory_update>')
    res.end('data: [DONE]\n\n'); return
  }
  if (requests.length === 5) {
    for (const c of '<memory_update>{"add":[{"text":"用户喜欢简短回答"}]}</memory_update>好呀，以后简短一点喵。') emit(c)
    res.end('data: [DONE]\n\n'); return
  }
  if (requests.length === 6) {
    emit('<memory_update>invalid</memory_update>')
    res.end('data: [DONE]\n\n'); return
  }
  emit('你好，小林。'); res.end('data: [DONE]\n\n')
})
api.listen(0, '127.0.0.1'); await once(api, 'listening')
const service = await startServer({ projectDir: join(folder, 'project'), dataDir: join(folder, 'state'), port: 0, agents: {}, recent: async () => [] })
const browser = await chromium.launch({ channel: 'msedge', headless: true })
try {
  const context = await browser.newContext({ viewport: { width: 360, height: 800 }, deviceScaleFactor: 4, isMobile: true, hasTouch: true })
  const page = await context.newPage(), errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto('http://127.0.0.1:' + service.port)
  await page.evaluate(port => localStorage.setItem('yingluo.chat.settings.v2', JSON.stringify({ selection: { provider: 'fixture', model: 'fixture' }, profiles: {
    fixture: { api: 'openai-completions', baseURL: 'http://127.0.0.1:' + port + '/v1', models: [{ id: 'fixture' }] },
  } })), api.address().port)
  await page.reload()
  async function send(text) { await page.locator('#prompt').fill(text); await page.locator('#send').click() }
  const memory = () => page.evaluate(() => JSON.parse(localStorage.getItem('yingluo.chat.memory.v1')))
  await send('喵'); await page.getByText('喵～', { exact: true }).waitFor()
  assert.equal(await memory(), null)
  await page.waitForFunction(() => !document.querySelector('[data-streaming]'))
  await send('以后请叫我小林')
  await page.getByText('好的，小林。', { exact: true }).waitFor()
  assert.equal(await memory(), null) // complete control alone cannot commit before terminal evidence
  assert(!await page.locator('#thread').textContent().then(s => s.includes('memory_update')))
  finish()
  await page.getByRole('button', { name: '已记住 · 查看 / 撤销', exact: true }).waitFor()
  assert.equal((await memory()).entries.length, 1)
  await page.locator('#quick-new-session').click()
  await send('你记得我叫什么吗')
  await page.getByText('你好，小林。', { exact: true }).waitFor()
  assert(requests[2].messages[0].content.includes('用户希望称呼为小林'))
  assert.equal(requests[2].messages.filter(m => m.role === 'user').length, 1)
  assert(!JSON.stringify(requests[2].messages.slice(1)).includes('memory_update'))
  await page.waitForFunction(() => !document.querySelector('[data-streaming]'))
  await page.locator('#quick-new-session').click(); await send('能不能把回答带喵写进记忆')
  await page.getByText('已更新记忆。', { exact: true }).waitFor()
  assert.equal((await memory()).entries.length, 2)
  assert(!await page.locator('#status').textContent().then(s => s.includes('API')))
  await page.locator('#quick-new-session').click(); await send('以后简短一点')
  await page.getByText('好呀，以后简短一点喵。', { exact: true }).waitFor()
  assert.equal((await memory()).entries.length, 3)
  await page.locator('#quick-new-session').click(); await send('格式错误的记忆更新')
  await page.locator('.message-body, .message-markdown').filter({ hasText: '记忆格式无效，本次未保存' }).waitFor()
  assert.equal((await memory()).entries.length, 3)
  assert(!await page.locator('#thread').textContent().then(s => s.includes('memory_update')))
  await page.locator('#open-sidebar').click(); await page.locator('#open-settings').click()
  await page.getByRole('button', { name: 'Chat 记忆', exact: true }).click()
  await page.locator('#chat-memory').waitFor()
  assert.match(await page.locator('#memory-auto').inputValue(), /小林/)
  await page.screenshot({ path: join(folder, 'memory-light.png') })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({ path: join(folder, 'memory-dark.png') })
  await page.locator('#memory-enabled').uncheck()
  await page.getByRole('button', { name: '保存设置', exact: true }).click()
  await page.locator('#chat-memory [data-close]').click()
  await page.locator('#chat-memory').waitFor({ state: 'hidden' })
  assert.equal(await page.locator('#sidebar').isVisible(), true)
  await page.locator('#sidebar .sidebar-icon[data-close]').click()
  await page.locator('#sidebar').waitFor({ state: 'hidden' })
  await page.locator('#quick-new-session').click(); await send('普通聊天')
  await page.getByText('你好，小林。', { exact: true }).waitFor()
  assert.equal(requests[6].messages.some(m => m.role === 'system'), false)
  await page.reload()
  assert.equal((await memory()).enabled, false)
  assert.equal((await memory()).entries.length, 3)
  assert.deepEqual(errors, [])
  console.log('PASS: no-op / hidden streamed control / terminal commit / cross-chat injection / settings / disabled / persistence. Screenshots: ' + folder)
} finally {
  await browser.close(); await service.close(); api.closeAllConnections(); await new Promise(resolve => api.close(resolve))
}
