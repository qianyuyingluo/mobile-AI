import type { ComponentProps, ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { Context } from '@deepseek-ai/cordis'
import type { ModelSelection } from '../../packages/api/session-controller/src/types.ts'
import { RemoteError } from '../../packages/typert/protocol/src/remote-error.ts'
import { createSnapshotStore } from '../../packages/client/store/src/index.ts'
import type {} from '../../packages/client/ui-model-selection/src/client/index.ts'
import { ModelSelect } from '../../packages/client/ui-model-selection/src/client/ModelSelect.tsx'
import type { ModelDirectoryState } from '../../packages/client/ui-model-selection/src/client/directory.ts'
import { zh as modelCopy } from '../../packages/client/ui-model-selection/src/client/locales.ts'
import { installIconSprite } from '../../packages/client/ui-theme/src/client/icon-sprite.ts'
import '../../packages/client/ui-theme/src/styles/base.css'
import '../../packages/client/ui-theme/src/styles/gradient-shadow-text.css'
import './model-picker.css'
import { ReasoningSlider, reasoningLabel, subscribeReasoningNames } from './reasoning-slider.tsx'
export { mountWorkEffort } from './reasoning-slider.tsx'
export { mountModelSettings } from './model-settings.tsx'
export { renderMarkdownMessages } from './message-markdown.tsx'
export { default as decodeQr } from 'jsqr'

type Props = ComponentProps<typeof ModelSelect>
type Provider = ModelDirectoryState['groups'][number]
type PickerState = { selection: ModelSelection | null; locked: boolean; providers: readonly Provider[] }

const t: Props['t'] = (key, options = {}) => (modelCopy[key] ?? key)
  .replace(/\{(\w+)\}/g, (match, name: string) => String(options[name] ?? match))

/** Mount the original Harness model picker in the companion Chat composer. */
export function mountModelPicker(element: HTMLElement, { onSelect }: {
  onSelect: (selection: ModelSelection) => boolean
}) {
  if (!document.querySelector('[data-dsh-icon-sprite]')) installIconSprite(new Context(), undefined)
  const directory = createSnapshotStore<ModelDirectoryState>({
    groups: [], current: null, routable: null, status: 'ready', failures: [], pending: null, error: null,
  })
  element.classList.add('yingluo-model-picker')
  const root = createRoot(element)
  let current: PickerState = { selection: null, locked: false, providers: [] }
  const select: Props['select'] = async selection => {
    const model = current.providers.find(group => group.id === selection.provider)?.models.find(model => model.id === selection.model)
    const sameModel = current.selection?.provider === selection.provider && current.selection?.model === selection.model
    const effort = sameModel ? current.selection?.reasoningEffort : model?.reasoning?.defaultEffort
    return onSelect({ ...selection, ...(effort === undefined ? {} : { reasoningEffort: effort }) })
      ? { ok: true, value: undefined }
      : { ok: false, error: new RemoteError('gateway/internal', '无法保存模型选择。', {}) }
  }
  const renderSlot: Props['renderSlot'] = (name, _owner, options?: { fallback?: ReactNode }) => {
    if (name !== 'conversation.input.model.options') return options?.fallback ?? null
    const selection = current.selection
    const model = current.providers.find(group => group.id === selection?.provider)?.models.find(model => model.id === selection?.model)
    const reasoning = model?.reasoning
    if (!selection || !model || !reasoning?.efforts.length) return null
    const levels = [...(reasoning.defaultEffort === undefined ? [{ id: '', name: '默认' }] : []), ...reasoning.efforts]
    return <ReasoningSlider levels={levels} model={model.name} disabled={current.locked}
      value={selection.reasoningEffort ?? reasoning.defaultEffort ?? ''} defaultValue={reasoning.defaultEffort ?? ''}
      onChange={effort => {
        if (!current.locked) onSelect({ provider: selection.provider, model: selection.model, ...(effort ? { reasoningEffort: effort } : {}) })
      }} />
  }

  const currentEffortLabel = () => {
    const selection = current.selection
    const reasoning = current.providers.find(group => group.id === selection?.provider)?.models.find(model => model.id === selection?.model)?.reasoning
    if (!reasoning?.efforts.length) return undefined
    const effort = selection?.reasoningEffort ?? reasoning.defaultEffort ?? ''
    return reasoningLabel(effort, reasoning.efforts.find(level => level.id === effort)?.name ?? effort)
  }
  subscribeReasoningNames(() => directory.set({ ...directory.getSnapshot(), retainedEffort: currentEffortLabel() }))
  let locked: boolean | undefined
  let previousGroups: readonly Provider[] = []
  let previous = ''
  return {
    update(next: PickerState) {
      current = next
      const signature = JSON.stringify(next.selection)
      const changed = signature !== previous || next.providers.length !== previousGroups.length
        || next.providers.some((group, i) => group !== previousGroups[i])
      if (changed) {
        previousGroups = next.providers
        previous = signature
        // The companion owns the effort slider in the options slot; keep the Harness model list.
        const groups = next.providers.map(group => ({ ...group, models: group.models.map(({ reasoning, ...model }) => model) }))
        directory.set({ ...directory.getSnapshot(), groups,
          current: next.selection, retainedEffort: currentEffortLabel(), routable: next.selection !== null })
      }
      if (locked === next.locked && !changed) return
      locked = next.locked
      root.render(<ModelSelect available locked={locked} directory={directory}
        load={() => {}} select={select} t={t} renderSlot={renderSlot}
        resolveText={text => typeof text === 'string' ? text : text.zh ?? text.en ?? ''} />)
    },
    close() {
      const trigger = element.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')
      if (trigger?.getAttribute('aria-expanded') === 'true') trigger.click()
    },
  }
}
