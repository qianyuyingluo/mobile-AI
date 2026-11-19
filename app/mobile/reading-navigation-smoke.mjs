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
const folder = await mkdtemp(join(tmpdir(), 'ayane-reading-'))
await mkdir(join(folder, 'project'))
let reply
const api = createServer(async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Access-Control-Allow-Headers', '*')
  if (request.method === 'OPTIONS') { response.end(); return }
  for await (const chunk of request) { /* Consume fixture body. */ }
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  reply = response
  write('## 正在回复\n\n首段已经到达。')
})
function write(text) {
  reply.write('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n')
}
api.listen(0, '127.0.0.1'); await once(api, 'listening')
const service = await startServer({ projectDir: join(folder, 'project'), dataDir: join(folder, 'state'),
  port: 0, agents: { codex: { id: 'codex', available: true } }, recent: async () => [],
  runner: async () => ({ text: '# 工作回复\n\n' + '这里是电脑返回的内容。\n\n'.repeat(30), resumeId: 'reading-test' }) })
const browser = await chromium.launch({ channel: 'msedge', headless: true })
try {
  const context = await browser.newContext({ viewport: { width: 360, height: 800 }, deviceScaleFactor: 4, isMobile: true, hasTouch: true })
  await context.addInitScript(port => {
    localStorage.setItem('yingluo.chat.settings.v2', JSON.stringify({ selection: { provider: 'fixture', model: 'fixture' }, profiles: {
      fixture: { api: 'openai-completions', baseURL: 'http://127.0.0.1:' + port + '/v1', displayName: '测试模型', models: [{ id: 'fixture' }] },
    } }))
    const questions = ['介绍一下这个项目的整体结构', '怎样实现手机连接电脑', '公式和表格如何正常显示', '帮我分析刚才提到的性能问题',
      '动画和背景素材怎么管理', '如何让正在输出的内容更好阅读', '手机端布局需要注意哪些细节', '长对话输入和草稿怎样保存']
    const messages = Array.from({ length: 24 }, (_, index) => [
      { role: 'user', text: questions[index % questions.length] + '，后面这些补充内容不需要完整显示在目录里。' },
      { role: 'assistant', text: '## 回答 ' + (index + 1) + '\n\n' + '这是一段用来验证长会话阅读位置的内容。保持当前段落，方便从头阅读。\n\n'.repeat(3) },
    ]).flat()
    localStorage.setItem('yingluo.chat.history.v1', JSON.stringify({ selected: 'reading', sessions: [
      { id: 'reading', title: '对话进度验收', messages },
      { id: 'other', title: '另一个会话', messages: [{ role: 'user', text: '只有附件', attachments: [{ name: 'diagram.png', type: 'image/png' }] }] },
    ] }))
  }, api.address().port)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('http://127.0.0.1:' + service.port)
  await page.locator('.message-markdown h2').first().waitFor()
  const cdp = await context.newCDPSession(page)
  const touch = async (type, x, y) => cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }],
  })
  const drag = async (x, y, dx, dy) => {
    await touch('touchStart', x, y)
    for (let step = 1; step <= 8; step++) {
      await touch('touchMove', x + dx * step / 8, y + dy * step / 8)
      await page.waitForTimeout(16)
    }
    await touch('touchEnd')
  }
  const top = () => page.locator('#transcript').evaluate(el => el.scrollTop)
  const assertBottom = () => page.waitForFunction(() => {
    const el = document.getElementById('transcript')
    return el.scrollHeight - el.scrollTop - el.clientHeight < 2
  })
  await assertBottom()
  await page.screenshot({ path: join(folder, 'collapsed-1440x3200.png') })
  await page.locator('#prompt').fill('继续详细解释，验证触屏暂停自动跟随')
  await page.locator('#send').click()
  await page.getByText('首段已经到达。', { exact: true }).waitFor()
  write('\n\n' + '自动跟随阶段。\n\n'.repeat(18))
  await page.getByText('自动跟随阶段。', { exact: true }).last().waitFor()
  await assertBottom()
  // Re-selecting the current session must consume its scroll reset immediately.
  await page.locator('#open-sidebar').click()
  await page.getByRole('button', { name: '对话进度验收', exact: true }).click()
  await assertBottom()
  // Touching at the bottom must pause even without moving away from the 56px threshold.
  await touch('touchStart', 280, 380)
  const heldTop = await top()
  write('\n\n触屏按住时到达的新段落。\n\n' + '持续回复内容。\n\n'.repeat(12))
  await page.getByText('触屏按住时到达的新段落。', { exact: true }).waitFor()
  await page.waitForTimeout(120)
  assert.ok(Math.abs(await top() - heldTop) < 2)
  await touch('touchEnd')
  write('\n\n松手以后仍然保持阅读位置。\n\n' + '后续内容。\n\n'.repeat(8))
  await page.getByText('松手以后仍然保持阅读位置。', { exact: true }).waitFor()
  await page.waitForTimeout(120)
  assert.ok(Math.abs(await top() - heldTop) < 2)
  await page.locator('#scroll-bottom').click()
  write('\n\n恢复跟随后的新段落。\n\n' + '跟随成功。\n\n'.repeat(8))
  await page.getByText('恢复跟随后的新段落。', { exact: true }).waitFor()
  await assertBottom()

  const handle = await page.locator('.question-handle').boundingBox()
  assert.ok(handle.x >= 0 && handle.x < 2 && handle.y < 260)
  const arrow = await page.locator('.question-handle span').boundingBox()
  assert.ok(arrow.x + arrow.width <= 15)
  assert.equal(await page.locator('.question-handle').evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)')
  await drag(handle.x + handle.width / 2, handle.y + handle.height / 2, 120, 0)
  await page.waitForFunction(() => document.querySelector('.question-handle').getAttribute('aria-expanded') === 'true')
  await page.waitForTimeout(350)
  assert.equal(await page.locator('.question-item').count(), 25)
  assert.ok(Math.abs((await page.locator('.question-panel').boundingBox()).width - 360 * .4) < 1)
  assert.ok((await page.locator('.question-label').first().textContent()).length <= 15)
  // Rotate back through several questions using a real touch drag.
  const wheel = await page.locator('.question-wheel').boundingBox()
  await drag(80, wheel.y + wheel.height / 2, 0, 150)
  await page.waitForTimeout(550)
  const selected = Number(await page.locator('.question-item[data-selected]').getAttribute('data-question'))
  assert.ok(selected < 25 && selected > 1)
  // Reverse the drawer before its closing spring settles.
  await drag(100, wheel.y + wheel.height / 2, -90, 0)
  await page.waitForTimeout(25)
  const movingHandle = await page.locator('.question-handle').boundingBox()
  await drag(movingHandle.x + movingHandle.width / 2, movingHandle.y + movingHandle.height / 2, 120, 0)
  await page.waitForTimeout(350)
  assert.equal(await page.locator('.question-handle').getAttribute('aria-expanded'), 'true')
  await page.locator('.question-item[data-selected]').focus()
  await page.keyboard.press('Home')
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowDown')
  await page.locator('.question-item[data-selected]').evaluate(el => el.blur())
  await page.screenshot({ path: join(folder, 'wheel-light-1440x3200.png') })
  await page.locator('[data-question="7"]').click()
  await page.waitForTimeout(350)
  assert.equal(await page.locator('.question-handle').getAttribute('aria-expanded'), 'false')
  const questionTop = await page.locator('.message-user').nth(6).evaluate(el => el.getBoundingClientRect().top)
  assert.ok(Math.abs(questionTop - 64) < 2)
  const jumpedTop = await top()
  write('\n\n跳转后继续流式输出。\n\n' + '追加内容不抢走阅读位置。\n\n'.repeat(10))
  await page.getByText('跳转后继续流式输出。', { exact: true }).waitFor()
  await page.waitForTimeout(120)
  assert.ok(Math.abs(await top() - jumpedTop) < 2)
  reply.end('data: [DONE]\n\n')
  await page.locator('#stop').waitFor({ state: 'hidden' })
  assert.ok(Math.abs(await top() - jumpedTop) < 2)

  await page.locator('.question-handle').click()
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await page.waitForTimeout(80)
  await page.screenshot({ path: join(folder, 'wheel-dark.png') })
  await page.setViewportSize({ width: 320, height: 460 })
  await page.screenshot({ path: join(folder, 'wheel-keyboard.png') })
  assert.ok((await page.locator('.question-close').boundingBox()).x >= 0)
  assert.equal(await page.evaluate(() => window.yingluoBack()), true)
  await page.locator('.question-handle').click()
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('.question-handle').getAttribute('aria-expanded'), 'false')
  await page.locator('.question-handle').click()
  await page.locator('#transcript').click({ position: { x: 280, y: 180 } })
  assert.equal(await page.locator('.question-handle').getAttribute('aria-expanded'), 'false')
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 360, height: 800 })
  await page.locator('#open-sidebar').click()
  await page.getByRole('button', { name: '另一个会话', exact: true }).click()
  assert.equal(await page.locator('.question-item').count(), 1)
  await page.locator('.question-handle').click()
  await page.screenshot({ path: join(folder, 'single-question.png') })
  await page.locator('.question-close').click()
  await page.locator('#quick-new-session').click()
  assert.equal(await page.locator('#question-navigation').isVisible(), false)
  // Work uses the same question index, including replies replaced by polling.
  await page.locator('#work-mode').click()
  await page.getByRole('button', { name: '开始配对', exact: true }).click()
  await page.locator('#host').fill('http://127.0.0.1:' + service.port)
  await page.locator('#pair-code').fill(service.pairingCode)
  await page.locator('#pair-submit').click()
  await page.getByRole('button', { name: '选择助手', exact: true }).click()
  await page.locator('#agent-options').getByRole('button', { name: 'Codex', exact: true }).click()
  await page.locator('#prompt').fill('检查电脑项目结构')
  await page.locator('#send').click()
  await page.getByRole('heading', { name: '工作回复', exact: true }).waitFor()
  await page.locator('.question-handle').click()
  await page.locator('[data-question="1"]').click()
  assert.ok(Math.abs(await page.locator('.message-user').evaluate(el => el.getBoundingClientRect().top) - 64) < 2)
  assert.deepEqual(errors, [])
  await cdp.detach()
  await context.close()
  console.log('Reading navigation smoke passed; screenshots: ' + folder)
} finally {
  await browser.close()
  api.closeAllConnections(); api.close()
  await service.close()
}
