import { eventStreamParser } from './event-stream.js'
const bridge = window.YingluoNative
const responses = new Map()
const chunks = new Map()
let sequence = 0

window.yingluoHttpResult = (id, status, text) => {
  responses.get(id)?.(Number(status), text)
}
window.yingluoHttpChunk = (id, text) => chunks.get(id)?.(text)

function nativeRequest(url, { method, headers, body, signal, onChunk }) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException('Request aborted', 'AbortError'))
      return
    }
    const id = String(++sequence)
    const finish = (status, text) => {
      responses.delete(id)
      chunks.delete(id)
      signal.removeEventListener('abort', abort)
      resolve({ status, text })
    }
    const abort = () => {
      responses.delete(id)
      chunks.delete(id)
      try {
        bridge.cancel?.(id)
      } finally {
        reject(signal.reason ?? new DOMException('Request aborted', 'AbortError'))
      }
    }
    signal.addEventListener('abort', abort, { once: true })
    responses.set(id, finish)
    if (onChunk) chunks.set(id, text => {
      try { onChunk(text) } catch (error) {
        responses.delete(id)
        chunks.delete(id)
        signal.removeEventListener('abort', abort)
        bridge.cancel?.(id)
        reject(error)
      }
    })
    try {
      bridge.request(id, url, method, JSON.stringify(headers), body ?? '')
    } catch {
      finish(0, '')
    }
  })
}

/** Deliver real SSE chunks through Android's bridge or the browser reader. */
export async function requestStream(url, { token, headers: extraHeaders, data, signal, timeout = 240000, onEvent }) {
  const controller = new AbortController()
  const cancel = () => controller.abort(signal.reason)
  if (signal?.aborted) cancel()
  else signal?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), timeout)
  const headers = { ...extraHeaders, Accept: 'text/event-stream', 'Content-Type': 'application/json' }
  if (token) headers.Authorization = 'Bearer ' + token
  const parser = eventStreamParser(onEvent)
  let bytes = 0
  const onChunk = chunk => {
    bytes += chunk.length
    if (bytes > 8 * 1024 * 1024) throw new Error('Stream response too large')
    parser.push(chunk)
  }
  let reader
  try {
    const body = JSON.stringify(data)
    if (typeof bridge?.request === 'function') {
      const result = await nativeRequest(url, { method: 'POST', headers, body, signal: controller.signal, onChunk })
      if (result.status < 200 || result.status > 299) throw Object.assign(new Error('HTTP request failed'), { status: result.status })
      // Older app transports may buffer the SSE body; still parse it safely.
      if (result.text) onChunk(result.text)
    } else {
      const response = await fetch(url, { method: 'POST', headers, body, signal: controller.signal,
        redirect: 'error', credentials: 'omit', cache: 'no-store' })
      if (!response.ok) throw Object.assign(new Error('HTTP request failed'), { status: response.status })
      if (!response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('Expected event stream')
      reader = response.body.getReader()
      const decoder = new TextDecoder()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        onChunk(decoder.decode(value, { stream: true }))
      }
      onChunk(decoder.decode())
    }
    parser.finish()
  } finally {
    if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock() }
    controller.abort()
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
  }
}

/** Read JSON from the bundled app's native transport or an ordinary browser. */
export async function requestJson(url, { method = 'GET', token, headers: extraHeaders, data, signal, timeout = 15000 } = {}) {
  const controller = new AbortController()
  const cancel = () => controller.abort(signal.reason)
  if (signal?.aborted) cancel()
  else signal?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), timeout)
  const headers = { Accept: 'application/json', ...extraHeaders }
  if (token) headers.Authorization = 'Bearer ' + token
  if (data !== undefined) headers['Content-Type'] = 'application/json'
  const body = data === undefined ? undefined : JSON.stringify(data)
  let result
  try {
    if (typeof bridge?.request === 'function') {
      result = await nativeRequest(url, { method, headers, body, signal: controller.signal })
    } else {
      const response = await fetch(url, {
        method, headers, body, signal: controller.signal, redirect: 'error', credentials: 'omit', cache: 'no-store',
      })
      result = { status: response.status, text: await response.text() }
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
  }

  if (result.status < 200 || result.status > 299) {
    const error = new Error('HTTP request failed')
    error.status = result.status
    throw error
  }
  return JSON.parse(result.text)
}

function serverUrl(value) {
  const url = new URL(value.trim())
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Unsupported URL')
  }
  return url
}

/** Resolve an OpenAI-compatible API base or already-complete endpoint. */
export function completionUrl(value) {
  const url = serverUrl(value)
  url.pathname = url.pathname.replace(/\/+$/, '')
  if (url.pathname === '/') url.pathname = '/v1'
  if (!url.pathname.endsWith('/chat/completions')) url.pathname += '/chat/completions'
  return url.toString()
}

/** Resolve a Work bridge origin. Work endpoints are rooted at /v1. */
export function workOrigin(value) {
  const url = serverUrl(value)
  if (url.pathname !== '/') throw new Error('Not a Work bridge origin')
  return url.origin
}

const secretKey = name => 'yingluo.secret.' + name

/** Load a credential only for the endpoint it was saved with. */
export function readSecret(name, target) {
  try {
    const raw = typeof bridge?.getSecret === 'function'
      ? bridge.getSecret(name)
      : sessionStorage.getItem(secretKey(name))
    const saved = raw && JSON.parse(raw)
    return saved?.target === target && typeof saved.value === 'string' ? saved.value : ''
  } catch {
    return ''
  }
}

/** Keep credentials out of persistent Web storage. */
export function saveSecret(name, value, target) {
  try {
    const raw = value ? JSON.stringify({ value, target }) : ''
    if (typeof bridge?.setSecret === 'function') {
      return bridge.setSecret(name, raw)
    }
    if (raw) {
      sessionStorage.setItem(secretKey(name), raw)
    } else {
      sessionStorage.removeItem(secretKey(name))
    }
    return true
  } catch {
    return false
  }
}
