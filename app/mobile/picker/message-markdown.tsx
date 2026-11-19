import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { MarkdownText, type MarkdownLabels } from '../../packages/client/ui-primitives/src/markdown/MarkdownText.tsx'

const labels: MarkdownLabels = {
  code: { copyLabel: '复制', copiedLabel: '已复制',
    toolbarLabels: { codeLabel: '代码', wrapLabel: '自动换行', unwrapLabel: '取消自动换行' } },
  footnotes: '脚注',
}

type Message = { element: HTMLElement; text: string; streaming?: boolean }

export function renderMarkdownMessages(messages: readonly Message[]) {
  const roots = messages.map(({ element }) => createRoot(element))
  const update = (next: readonly Message[]) => flushSync(() => {
    next.forEach(({ text, streaming }, index) => roots[index]!.render(<MarkdownText text={text} streaming={streaming} omitHtml labels={labels} />))
  })
  update(messages)
  return Object.assign(() => { for (const root of roots) root.unmount() }, { update })
}
