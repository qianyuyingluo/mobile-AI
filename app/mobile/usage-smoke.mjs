import assert from 'node:assert/strict'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from '../../backend/server.mjs'

const require = createRequire(new URL('../apps/web/package.json', import.meta.url))
const { chromium } = require('playwright')
const folder = await mkdtemp(join(tmpdir(), 'mobile-ai-usage-'))
await mkdir(join(folder, 'project'))
const requests = []
const api = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', '*')
  if (req.method === 'OPTIONS') { res.end(); return }
  let body = ''
  for await (const chunk of req) body += chunk
  requests.push(JSON.parse(body))
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const emit = event => res.write('data: ' + JSON.stringify(event) + '\n\n')
  emit({ type: 'message_start', message: { usage: { input_tokens: 1200, output_tokens: 1 } } })
  emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '第一段' } })
  await new Promise(resolve => setTimeout(resolve, 120))
  emit({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '到达。' } })
  await new Promise(resolve => setTimeout(resolve, 180))
  emit({ type: 'message_delta', usage: { output_tokens: 600 } })
  emit({ type: 'message_stop' })
  res.end()
})
api.listen(0, '127.0.0.1')
await once(api, 'listening')
const baseURL = 'http://127.0.0.1:' + api.address().port + '/v1'
const service = await startServer({ projectDir: join(folder, 'project'), dataDir: join(folder, 'state'), port: 0, agents: {}, recent: async () => [] })
const browser = await chromium.launch({ channel: 'msedge', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 360, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  await page.goto('http://127.0.0.1:' + service.port)
  await page.evaluate(({ baseURL }) => {
    localStorage.clear()
    localStorage.setItem('yingluo.chat.settings.v2', JSON.stringify({ selection: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' }, profiles: {
      'deepseek-official': { api: 'anthropic-messages', baseURL },
    } }))
    sessionStorage.setItem('yingluo.secret.chatApiKey', JSON.stringify({ target: 'yingluo.chat.providers.v2', value: JSON.stringify({
      'deepseek-official': { endpoint: baseURL + '/messages', key: 'fixture-only' },
    }) }))
  }, { baseURL })
  await page.reload()

  const line = page.locator('#usage-line')
  const sheet = page.locator('#usage-sheet')
  const settled = () => page.locator('#stop').waitFor({ state: 'hidden' })
  assert.equal(await line.isVisible(), false, 'Usage stays hidden before the first reply')

  await page.locator('#prompt').fill('第一轮问题')
  await page.locator('#send').click()
  await page.getByText('第一段到达。', { exact: true }).waitFor()
  await settled()

  await line.waitFor()
  const first = await line.innerText()
  assert.match(first, /输入 1,200/)
  assert.match(first, /输出 600/)
  assert.match(first, /\d+\.\d tok\/s/, 'Latest reply speed uses the generation window: ' + first)

  await line.click()
  await sheet.waitFor()
  assert.equal(await sheet.getAttribute('open'), '')
  const rows = await page.locator('#usage-list').innerText()
  assert.match(rows, /第 1 轮/)
  assert.match(rows, /输入 1,200/)
  assert.match(rows, /输出 600/)
  assert.match(rows, /合计/)
  await page.locator('#usage-sheet [data-close]').first().click()
  await sheet.waitFor({ state: 'hidden' })

  await page.locator('#prompt').fill('第二轮问题')
  await page.locator('#send').click()
  await page.getByText('第一段到达。', { exact: true }).waitFor({ state: 'visible' })
  await settled()
  const second = await line.innerText()
  assert.match(second, /输入 2,400/, 'Turn two accumulates input tokens: ' + second)
  assert.match(second, /输出 1,200/, 'Turn two accumulates output tokens: ' + second)
  await line.click()
  await sheet.waitFor()
  assert.equal(await page.locator('#usage-list .usage-row').count(), 3, 'Two replies plus the total row')
  await page.screenshot({ path: join(folder, 'usage-sheet-720x1600.png') })
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(folder, 'usage-sheet-settled-720x1600.png') })

  // Tapping the handle, swiping it down, or tapping above the sheet all dismiss it.
  await page.locator('#usage-sheet .sheet-handle').click()
  await sheet.waitFor({ state: 'hidden' })

  await line.click()
  await sheet.waitFor()
  const grip = await page.locator('#usage-sheet .sheet-handle').boundingBox()
  const gripX = grip.x + grip.width / 2
  const gripY = grip.y + grip.height / 2
  await page.mouse.move(gripX, gripY)
  await page.mouse.down()
  await page.mouse.move(gripX, gripY + 40, { steps: 3 })
  await page.mouse.move(gripX, gripY + 180, { steps: 6 })
  await page.mouse.up()
  await sheet.waitFor({ state: 'hidden' })

  // A short pull follows the finger but springs back instead of closing.
  await line.click()
  await sheet.waitFor()
  await page.mouse.move(gripX, gripY)
  await page.mouse.down()
  await page.mouse.move(gripX, gripY + 34, { steps: 3 })
  assert.match(await sheet.evaluate(element => element.style.transform), /translateY\(3\dpx\)/, 'Sheet follows the drag')
  await page.mouse.up()
  await page.waitForTimeout(400)
  assert.equal(await sheet.isVisible(), true, 'Short drag springs back instead of closing')
  await page.locator('#usage-sheet [data-close]').first().click()
  await sheet.waitFor({ state: 'hidden' })

  await line.click()
  await sheet.waitFor()
  await page.mouse.click(180, 120)
  await sheet.waitFor({ state: 'hidden' })

  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('yingluo.chat.history.v1')))
  const replies = saved.sessions[0].messages.filter(message => message.role === 'assistant')
  assert.deepEqual(replies[0].usage, { input: 1200, output: 600 })
  assert.ok(replies[0].genMs > 0, 'Generation window is stored with the reply')

  await page.reload()
  await page.locator('#usage-line').waitFor()
  assert.match(await page.locator('#usage-line').innerText(), /输入 2,400/)
  assert.equal(requests.length, 2)
  await page.screenshot({ path: join(folder, 'usage-720x1600.png') })
  console.log('PASS: chat token totals, latest reply speed and per-turn detail survive reload. Screenshots: ' + folder)
} finally {
  await browser.close()
  api.close()
  await service.close?.()
}
