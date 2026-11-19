// Reload the visible range from the computer. Reconnection can add more than one page.
export function desktopRequestId() {
  if (crypto.randomUUID) return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}

export async function desktopHistory(request, before) {
  let latest = await request()
  const target = Math.max(0, before ?? latest.before)
  const messages = [...latest.messages]
  let cursor = latest.before
  while (cursor > target) {
    const page = await request(cursor)
    if (page.before >= cursor) throw new Error('电脑历史记录分页未前进，请重新打开会话。')
    messages.unshift(...page.messages)
    cursor = page.before
  }
  return { ...latest, before: cursor, messages }
}
