import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { startServer } from '../../backend/server.mjs'

const require = createRequire(new URL('../apps/web/package.json', import.meta.url))
const { chromium } = require('playwright')
const folder = await mkdtemp(join(tmpdir(), 'mobile-ai-replies-'))
await mkdir(join(folder, 'project'))
const requests = []
let behavior = 'thinking', pending
const api = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*')
  if (req.method === 'OPTIONS') { res.end(); return }
  let body = ''; for await (const chunk of req) body += chunk
  requests.push(JSON.parse(body))
  if (behavior === 'error') { res.writeHead(401); res.end('{}'); return }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const emit = event => res.write('data: ' + JSON.stringify(event) + '\n\n')
  emit({ type: 'message_start' })
  pending = {
    think(text) { emit({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: text } }) },
    finish(text) {
      emit({ type: 'content_block_start', index: 1, content_block: { type: 'text', text } })
      emit({ type: 'message_stop' }); res.end()
    },
  }
  if (behavior === 'thinking') emit({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '先核对题目中的条件。' } })
})
api.listen(0, '127.0.0.1'); await once(api, 'listening')
const baseURL = 'http://127.0.0.1:' + api.address().port + '/v1'
const service = await startServer({ projectDir: join(folder, 'project'), dataDir: join(folder, 'state'), port: 0, agents: {}, recent: async () => [] })
const browser = await chromium.launch({ channel: 'msedge', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 360, height: 800 }, deviceScaleFactor: 4, isMobile: true, hasTouch: true })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('http://127.0.0.1:' + service.port)
  const image = (await readFile(new URL('../packages/client/ui-brand-official/src/client/assets/neko-avatar.webp', import.meta.url))).toString('base64')
  await page.evaluate(({ baseURL, image }) => {
    localStorage.setItem('yingluo.chat.settings.v2', JSON.stringify({ selection: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' }, profiles: {
      'deepseek-official': { api: 'anthropic-messages', baseURL },
    } }))
    sessionStorage.setItem('yingluo.secret.chatApiKey', JSON.stringify({ target: 'yingluo.chat.providers.v2', value: JSON.stringify({
      'deepseek-official': { endpoint: baseURL + '/messages', key: 'fixture-only' },
    }) }))
    localStorage.setItem('yingluo.chat.history.v1', JSON.stringify({ selected: 'original', sessions: [{ id: 'original', title: '回复功能测试', messages: [
      { id: 'q1', role: 'user', text: '图片中的公式是什么？', attachments: [{ name: '测试.webp', type: 'image/webp', data: image }] },
      { id: 'a1', role: 'assistant', text: '旧的第一条回复' },
      { id: 'q2', role: 'user', text: '再解释一下公式' },
      { id: 'a2', role: 'assistant', text: '旧的第二条回复' },
    ] }] }))
  }, { baseURL, image })
  await page.reload()
  const replies = page.locator('.message-assistant')
  const retry = () => replies.last().getByRole('button', { name: '重新生成回复', exact: true })
  const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('yingluo.chat.history.v1')))
  const settled = () => page.locator('#stop').waitFor({ state: 'hidden' })
  await retry().waitFor()
  assert.equal(await page.locator('.message-reasoning').count(), 0)
  await page.locator('#prompt').fill('这条草稿不能丢')
  await retry().click()
  await page.getByText('正在思考…', { exact: true }).waitFor()
  assert.equal(requests.length, 1)
  assert.equal(requests[0].messages.length, 3)
  assert.equal(requests[0].messages.at(-1).content, '再解释一下公式')
  assert.equal(requests[0].thinking.type, 'enabled')
  assert.equal(requests[0].output_config.effort, 'high')
  assert.equal(await retry().isDisabled(), true)
  assert.equal(await page.locator('.reasoning-text').isVisible(), false)
  await page.locator('.message-reasoning summary').click()
  await page.locator('.message-reasoning').evaluate(el => { el.dataset.stable = 'yes' })
  pending.think('\n再将每个变量代入验证，确保单位和结果一致。')
  await page.getByText('先核对题目中的条件。\n再将每个变量代入验证，确保单位和结果一致。', { exact: true }).waitFor()
  assert.equal(await page.locator('.message-reasoning').getAttribute('data-stable'), 'yes')
  await page.screenshot({ path: join(folder, 'thinking-light-1440x3200.png') })
  pending.finish('## 新的回复\n\n公式：$E=mc^2$\n\n| 项目 | 结果 |\n| --- | --- |\n| 重试 | 完成 |')
  await settled()
  await page.locator('.katex').waitFor()
  assert.equal(await page.locator('.message-user').count(), 2)
  assert.equal(await page.locator('.message-reasoning').getAttribute('open'), '')
  assert.equal(await page.locator('#prompt').inputValue(), '这条草稿不能丢')
  assert.equal((await saved()).sessions[0].messages.at(-1).reasoning, '先核对题目中的条件。\n再将每个变量代入验证，确保单位和结果一致。')
  assert(!JSON.stringify(requests[0]).includes('先核对题目'))
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({ path: join(folder, 'reply-dark-1440x3200.png') })

  // The same icon remains usable after replacing a reply, including failure and cancellation.
  behavior = 'error'
  await retry().click(); await page.getByText('重试失败，已保留原回复', { exact: true }).waitFor(); await settled()
  assert.equal(await replies.last().getByRole('heading', { name: '新的回复' }).count(), 1)
  assert.equal(await page.locator('#prompt').inputValue(), '这条草稿不能丢')
  behavior = 'thinking'
  await retry().click(); await page.getByText('正在思考…', { exact: true }).waitFor()
  await page.locator('#stop').click(); await page.getByText('已停止重试，保留原回复', { exact: true }).waitFor()
  assert.equal(await replies.last().getByRole('heading', { name: '新的回复' }).count(), 1)

  // Earlier replies fork at the question; images survive and the original continuation is untouched.
  behavior = 'plain'
  const before = await saved()
  await replies.first().getByRole('button', { name: '重新生成回复' }).click()
  await page.waitForFunction(() => document.querySelector('[data-streaming]'))
  const deadline = Date.now() + 5000
  while (requests.length < 4) {
    assert(Date.now() < deadline, 'Earlier-question retry did not reach the model')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(requests[3].messages.length, 1)
  assert.equal(requests[3].messages[0].content[1].source.data, image)
  pending.finish('重试后的第一条回复')
  await settled(); await page.getByText('重试后的第一条回复', { exact: true }).waitFor()
  const after = await saved()
  assert.equal(after.sessions.length, 2)
  assert.deepEqual(after.sessions.find(s => s.id === 'original'), before.sessions[0])
  assert.equal(after.sessions.find(s => s.id === after.selected).messages.length, 2)
  assert.equal(await page.locator('.message-reasoning').count(), 0)
  assert.equal(await page.locator('#prompt').inputValue(), '这条草稿不能丢')

  // A failed first attempt keeps its question and gains a usable retry icon.
  behavior = 'error'
  await page.locator('#prompt').fill('测试失败后的重试'); await page.locator('#send').click()
  await page.getByText('回复已中断，已保留收到的内容', { exact: true }).waitFor(); await settled()
  assert.equal(await page.locator('.message-user').count(), 2)
  behavior = 'thinking'
  await retry().click(); await page.getByText('正在思考…', { exact: true }).waitFor()
  pending.finish('恢复成功')
  await settled(); await page.getByText('恢复成功', { exact: true }).waitFor()
  assert.equal(await page.locator('.message-user').count(), 2)
  assert.equal(requests[5].messages.at(-1).content, '测试失败后的重试')
  await page.reload()
  await page.locator('.message-reasoning summary').click()
  await page.getByText('先核对题目中的条件。', { exact: true }).waitFor()
  await page.setViewportSize({ width: 320, height: 710 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({ path: join(folder, 'narrow-persisted.png') })
  assert.deepEqual(errors, [])
  console.log('PASS: reasoning streams / folds / persists; retry preserves prompts, images, drafts and original history; failure and cancellation recover. Screenshots: ' + folder)
} finally {
  await browser.close(); api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); await service.close()
}
