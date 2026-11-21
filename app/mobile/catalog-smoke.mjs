import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from '../../backend/server.mjs'

const { chromium } = createRequire(new URL('../apps/web/package.json', import.meta.url))('playwright')
const folder = await mkdtemp(join(tmpdir(), 'mobile-catalog-'))
await mkdir(join(folder, 'project'))
const server = await startServer({ port: 0, projectDir: join(folder, 'project'), dataDir: join(folder, 'state'), agents: {}, recent: async () => [] })
const browser = await chromium.launch({ channel: 'msedge' })
try {
  const page = await browser.newPage({ viewport: { width: 360, height: 800 }, deviceScaleFactor: 4, isMobile: true, hasTouch: true })
  page.setDefaultTimeout(8000)
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto('http://127.0.0.1:' + server.port)
  await page.getByRole('button', { name: '设置模型', exact: true }).click()
  await page.getByRole('button', { name: '添加模型提供商' }).click()
  const providers = page.locator('select').filter({ has: page.locator('option[value="kimi-coding"]') })
  assert.equal(await providers.locator('option[value="deepseek-account"]').count(), 0)
  await providers.selectOption('kimi-coding')
  await page.locator('input[type=password]:visible').fill('fixture-only')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.getByRole('button', { name: '添加模型提供商' }).waitFor()
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.locator('#prompt').focus()
  const trigger = page.locator('#model-picker button[aria-haspopup=menu]')
  await trigger.click()
  await page.locator('[role=menuitemradio][title="Kimi K3"]').click()
  await trigger.click()
  const slider = page.getByRole('slider', { name: '推理强度' })
  assert.equal(await slider.getAttribute('max'), '3')
  await slider.press('End')
  assert.equal(await slider.getAttribute('aria-valuetext'), '最高')
  await slider.press('Escape')
  await page.reload()
  let request
  await page.route('https://api.kimi.com/coding/v1/search', async route => {
    assert.equal(route.request().postDataJSON().text_query, '描述图片')
    await route.fulfill({ json: { search_results: [{ title: '来源资料', url: 'https://example.org/test', snippet: '搜索摘要测试' }] } })
  })
  await page.route('https://api.kimi.com/coding/v1/chat/completions', async route => {
    request = route.request().postDataJSON()
    await route.fulfill({ contentType: 'text/event-stream', body: 'data: {"choices":[{"delta":{"reasoning_content":"检查图像"}}]}\n\ndata: {"choices":[{"delta":{"content":"测试完成"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n' })
  })
  const image = await readFile(new URL('../packages/client/ui-brand-official/src/client/assets/neko-avatar.webp', import.meta.url))
  await page.locator('#file-input').setInputFiles({ name: 'fixture.webp', mimeType: 'image/webp', buffer: image })
  await page.locator('#prompt').fill('描述图片')
  await page.locator('#web-search').click()
  await page.locator('#send').click()
  await page.getByText('测试完成', { exact: true }).waitFor()
  assert.equal(request.model, 'k3')
  assert.equal(request.reasoning_effort, 'max')
  assert(request.messages.at(-1).content.some(part => part.type === 'image_url' && part.image_url.url.startsWith('data:image/')))
  assert(request.messages.at(-1).content.some(part => part.type === 'text' && part.text.includes('搜索摘要测试')))
  await page.getByRole('button', { name: '1 个来源' }).click()
  assert.equal(await page.locator('.source-card a').getAttribute('href'), 'https://example.org/test')
  // A Responses-compatible deployment can emit its citations only in the terminal event.
  await page.evaluate(() => {
    const profiles = { proxy: { api: 'openai-responses', baseURL: location.origin + '/v1', models: [{ id: 'local-vision' }] } }
    localStorage.setItem('yingluo.chat.settings.v2', JSON.stringify({ profiles, selection: { provider: 'proxy', model: 'local-vision' } }))
    sessionStorage.setItem('yingluo.secret.chatApiKey', JSON.stringify({ target: 'yingluo.chat.providers.v2',
      value: JSON.stringify({ proxy: { endpoint: location.origin + '/v1/responses', key: 'fixture-only' } }) }))
  })
  await page.reload()
  await page.locator('#quick-new-session').click()
  let responseRequest
  await page.route('**/v1/responses', async route => {
    responseRequest = route.request().postDataJSON()
    const output = [{ type: 'web_search_call', action: { sources: [{ url: 'https://example.org/reference' }] } },
      { type: 'message', content: [{ type: 'output_text', text: '联网图片回复', annotations: [{ type: 'url_citation', url: 'https://example.org/reference', title: '参考网页' }] }] }]
    await route.fulfill({ contentType: 'text/event-stream',
      body: 'data: ' + JSON.stringify({ type: 'response.completed', response: { output } }) + '\n\n' })
  })
  await page.locator('#file-input').setInputFiles({ name: 'fixture.webp', mimeType: 'image/webp', buffer: image })
  await page.locator('#prompt').fill('搜一下这张图片')
  if (await page.locator('#web-search').getAttribute('aria-pressed') !== 'true') await page.locator('#web-search').click()
  await page.locator('#send').click()
  await page.getByText('联网图片回复', { exact: true }).waitFor()
  assert.deepEqual(responseRequest.tools, [{ type: 'web_search' }])
  assert.deepEqual(responseRequest.include, ['web_search_call.action.sources'])
  assert(responseRequest.input.at(-1).content.some(part => part.type === 'input_image'))
  await page.getByRole('button', { name: '1 个来源' }).click()
  await page.locator('.source-card summary').click()
  assert.equal(await page.locator('.source-card a').innerText(), 'https://example.org/reference')
  assert.deepEqual(errors, [])
  console.log('PASS: 1440×3200 Kimi Coding and custom Responses search, vision, citations and source sheets')
} finally {
  await browser.close()
  await server.close()
}
