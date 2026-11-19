import { attachmentPrompt } from './work-attachments.mjs'

export function createWorkAssistant(env) {
  const base = env.YINGLUO_AI_BASE_URL?.trim()
  const model = env.YINGLUO_AI_MODEL?.trim()
  const key = env.YINGLUO_AI_API_KEY?.trim()
  if (!base || !model) return undefined

  const endpoint = new URL(base)
  if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) {
    throw new Error('YINGLUO_AI_BASE_URL 必须是 HTTP(S) API 地址。')
  }
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, '')
  if (endpoint.pathname === '/') endpoint.pathname = '/v1'
  if (!endpoint.pathname.endsWith('/chat/completions')) endpoint.pathname += '/chat/completions'

  return async (history, { project, available, signal, result }) => {
    const messages = [
      {
        role: 'system',
        content: '你是用户电脑上的 AI 项目助手。当前项目是 ' + project
          + '。用用户的语言回复。用户要求处理项目时，可选一个合适的 agent 完成明确授权的任务。'
          + '普通问答直接回答。用实际返回的结果汇报进度与失败，不要声称执行了没有完成的操作。',
      },
      ...history.slice(-20).map(({ role, text, attachments }) => ({
        role, content: attachments ? attachmentPrompt(text, attachments) : text,
      })),
    ]
    if (result) messages.push({
      role: 'user',
      content: '以下是刚完成的 agent 任务结果。请根据结果回复，不要再派发任务。\n' + result.slice(0, 16000),
    })
    const tools = result || available.length === 0 ? undefined : [{
      type: 'function',
      function: {
        name: 'delegate',
        description: '在当前电脑项目中派发一个任务给已连接的 agent。',
        parameters: {
          type: 'object',
          properties: { agent: { type: 'string', enum: available }, prompt: { type: 'string' } },
          required: ['agent', 'prompt'],
          additionalProperties: false,
        },
      },
    }]
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) },
      body: JSON.stringify({ model, messages, ...(tools ? { tools } : {}) }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(90000)]),
      redirect: 'error',
    })
    if (!response.ok) throw new Error('项目助手模型请求失败（HTTP ' + response.status + '）。')
    const answer = (await response.json()).choices?.[0]?.message
    const call = tools && answer?.tool_calls?.find(item => item.function?.name === 'delegate')
    if (call) {
      const task = JSON.parse(call.function.arguments)
      if (!available.includes(task.agent) || typeof task.prompt !== 'string' || !task.prompt.trim()) {
        throw new Error('项目助手返回了无效的任务。')
      }
      return { task: { agent: task.agent, prompt: task.prompt.trim().slice(0, 20000) } }
    }
    const text = typeof answer?.content === 'string' ? answer.content.trim() : ''
    if (!text) throw new Error('项目助手模型没有返回文字。')
    return { text }
  }
}

