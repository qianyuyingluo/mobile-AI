/**
 * Token totals and generation speed for one Chat transcript.
 *
 * Messages carry provider-reported usage only: `{ input, output }` attached to assistant
 * replies, plus `genMs` measured from the first streamed fragment to the end of the stream.
 * Nothing is estimated, so a provider that reports no usage leaves those fields absent.
 */

/** Sum reported usage across the active reply branch. */
export function sessionUsage(messages = []) {
  let input = 0
  let output = 0
  let replies = 0
  let inputReplies = 0
  let outputReplies = 0
  for (const message of messages) {
    if (message?.role !== 'assistant' || !message.usage) continue
    replies += 1
    if (Number.isFinite(message.usage.input)) { input += Math.max(0, message.usage.input); inputReplies += 1 }
    if (Number.isFinite(message.usage.output)) { output += Math.max(0, message.usage.output); outputReplies += 1 }
  }
  return { input, output, replies, hasInput: inputReplies > 0, hasOutput: outputReplies > 0 }
}

/** Average output rate of one reply; queueing and time to first token are excluded. */
export function replySpeed(message) {
  const output = message?.usage?.output
  const milliseconds = message?.genMs
  if (!Number.isFinite(output) || !Number.isFinite(milliseconds) || output <= 0 || milliseconds <= 0) return null
  return output / (milliseconds / 1000)
}

/** Rate of the newest reply that reported both output tokens and a generation time. */
export function latestSpeed(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const speed = replySpeed(messages[index])
    if (speed !== null) return speed
  }
  return null
}

/** One row per reply that reported usage, labelled by the user turn it answers. */
export function usageRows(messages = []) {
  const rows = []
  let turn = 0
  for (const message of messages) {
    if (message?.role === 'user') { turn += 1; continue }
    if (message?.role !== 'assistant' || !message.usage) continue
    rows.push({ turn: Math.max(turn, 1), input: message.usage.input ?? null,
      output: message.usage.output ?? null, speed: replySpeed(message) })
  }
  return rows
}

/** Thousands-separated token count; an em dash marks a value the provider never sent. */
export function formatTokens(value) {
  return Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : '—'
}

/** One-decimal generation rate in tokens per second. */
export function formatSpeed(value) {
  return Number.isFinite(value) ? value.toFixed(1) + ' tok/s' : '—'
}
