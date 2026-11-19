// Run against assets/web extracted from the built mobile-AI APK.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, mkdtemp } from 'node:fs/promises'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { resolve, join, extname, sep } from 'node:path'
import { tmpdir } from 'node:os'

if (!process.argv[2]) throw new Error('Usage: node app/mobile/variant-smoke.mjs <extracted assets/web directory>')
const root = resolve(process.argv[2])
const require = createRequire(new URL('../apps/web/package.json', import.meta.url))
const { chromium } = require('playwright')
const screenshots = await mkdtemp(join(tmpdir(), 'mobile-ai-ui-'))
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' }
const requests = [], errors = [], artworkRequests = []
const server = createServer(async (req, res) => {
  if (req.url === '/v1/chat/completions') {
    let body = ''; for await (const chunk of req) body += chunk
    requests.push(JSON.parse(body))
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: '# 测试回复\n\n公式：$E=mc^2$' } }] }) + '\n\ndata: [DONE]\n\n')
    return
  }
  const file = resolve(root, '.' + (req.url === '/' ? '/index.html' : new URL(req.url, 'http://localhost').pathname))
  if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return }
  try { res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' }); res.end(await readFile(file)) }
  catch { res.writeHead(404).end() }
})
server.listen(0, '127.0.0.1'); await once(server, 'listening')
const origin = 'http://127.0.0.1:' + server.address().port
const browser = await chromium.launch({ channel: 'msedge', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 360, height: 800 }, deviceScaleFactor: 4, isMobile: true, hasTouch: true })
  page.on('pageerror', e => errors.push(e.message))
  page.on('request', req => { if (/avatar\.webp|animations\//.test(req.url())) artworkRequests.push(req.url()) })
  await page.goto(origin)
  assert.equal(await page.title(), 'mobile-AI')
  assert.equal(await page.locator('#open-sidebar img, #open-sidebar span').count(), 0)
  assert.equal(await page.locator('#open-sidebar svg').count(), 1)
  assert.equal(await page.locator('#animation').isVisible(), false)
  assert(!await page.locator('body').innerText().then(text => /绫音|樱洛|猫娘/.test(text)))
  await page.getByRole('button', { name: '设置模型', exact: true }).click()
  await page.locator('.yingluo-model-settings[data-panel-state="open"]').waitFor()
  await page.getByRole('button', { name: '添加模型提供商', exact: true }).waitFor()
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.locator('.yingluo-model-settings').waitFor({ state: 'hidden' })
  await page.screenshot({ path: join(screenshots, 'light.png') })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.locator('#open-sidebar').click()
  await page.locator('#sidebar[data-panel-state="open"]').waitFor()
  assert.equal(await page.locator('#sidebar-title').innerText(), 'mobile-AI')
  assert.equal(await page.locator('#sidebar .brand-gear').count(), 1)
  await page.screenshot({ path: join(screenshots, 'dark-sidebar.png') })
  await page.locator('#open-settings').click()
  await page.locator('.yingluo-model-settings[data-panel-state="open"]').waitFor()
  await page.getByRole('button', { name: 'Chat 记忆', exact: true }).click()
  await page.locator('#chat-memory[data-panel-state="open"]').waitFor()
  assert.equal(await page.locator('#memory-auto').inputValue(), '')
  await page.locator('#chat-memory [data-close]').click()
  await page.locator('#chat-memory').waitFor({ state: 'hidden' })
  await page.locator('#sidebar .sidebar-icon[data-close]').click()
  await page.locator('#sidebar').waitFor({ state: 'hidden' })
  await page.evaluate(origin => localStorage.setItem('yingluo.chat.settings.v2', JSON.stringify({ selection: { provider: 'fixture', model: 'fixture' }, profiles: {
    fixture: { api: 'openai-completions', baseURL: origin + '/v1', displayName: '测试模型', models: [{ id: 'fixture' }] },
  } })), origin)
  await page.reload()
  await page.locator('#prompt').fill('你好')
  await page.locator('#send').click()
  await page.getByRole('heading', { name: '测试回复', exact: true }).waitFor()
  await page.locator('.katex').first().waitFor()
  assert.equal(requests.length, 1)
  assert(requests[0].messages[0].content.startsWith('你是AI 助手。'))
  assert(!JSON.stringify(requests[0]).includes('绫音'))
  await page.screenshot({ path: join(screenshots, 'dark-chat.png') })
  await page.locator('#quick-new-session').click()
  await page.locator('#work-mode').click()
  await page.getByRole('button', { name: '开始配对', exact: true }).click()
  await page.locator('#work-settings[data-panel-state="open"]').waitFor()
  assert.deepEqual(artworkRequests, [])
  assert.deepEqual(errors, [])
  console.log('PASS: packaged mobile-AI branding / settings / neutral Chat memory prompt / streamed Markdown / Work entry. Screenshots: ' + screenshots)
} finally {
  await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
}
