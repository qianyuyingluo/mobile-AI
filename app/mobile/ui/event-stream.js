/** SSE framing is independent of network chunks (including split CRLF lines). */
export function eventStreamParser(onEvent) {
  let buffer = '', data = [], event = ''
  function line(value) {
    if (!value) {
      if (data.length) onEvent({ event, data: data.join('\n') })
      data = []; event = ''
    } else if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''))
    else if (value.startsWith('event:')) event = value.slice(6).trim()
  }
  return {
    push(chunk) {
      buffer += chunk
      if (buffer.length > 8 * 1024 * 1024) throw new Error('Stream event too large')
      let match
      while ((match = /\r\n|\r(?!$)|\n/.exec(buffer))) {
        line(buffer.slice(0, match.index))
        buffer = buffer.slice(match.index + match[0].length)
      }
    },
    finish() { if (buffer) line(buffer.replace(/\r$/, '')); line(''); buffer = '' },
  }
}
