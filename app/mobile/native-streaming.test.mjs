import assert from 'node:assert/strict'
import test from 'node:test'
let active, cancellations = 0
globalThis.window = {
  YingluoNative: {
    request(id, url, method, headers, body) { active = { id, url, method, headers: JSON.parse(headers), body: JSON.parse(body) } },
    cancel() { cancellations++ },
  },
}
const { requestStream } = await import('./ui/http.js')
test('Android callback delivers incremental events, completes and ignores late chunks', async () => {
  const events = []
  const pending = requestStream('https://fixture.invalid', { data: { stream: true }, onEvent: event => events.push(event.data) })
  assert.equal(active.headers.Accept, 'text/event-stream')
  window.yingluoHttpChunk(active.id, 'data: first\n\n')
  assert.deepEqual(events, ['first'])
  window.yingluoHttpChunk(active.id, 'data: [DONE]\n\n')
  window.yingluoHttpResult(active.id, 200, '')
  await pending
  window.yingluoHttpChunk(active.id, 'data: ignored\n\n')
  assert.deepEqual(events, ['first', '[DONE]'])
})
test('Android cancellation and parser errors clear callbacks and cancel transport', async () => {
  const controller = new AbortController()
  const pending = requestStream('https://fixture.invalid', { data: {}, signal: controller.signal, onEvent() { assert.fail('late callback') } })
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  window.yingluoHttpChunk(active.id, 'data: late\n\n')
  window.yingluoHttpResult(active.id, 200, '')
  const failed = requestStream('https://fixture.invalid', { data: {}, onEvent() { throw new Error('bad event') } })
  window.yingluoHttpChunk(active.id, 'data: error\n\n')
  await assert.rejects(failed, /bad event/)
  assert.equal(cancellations, 2)
})
