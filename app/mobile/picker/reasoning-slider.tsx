import { useId, useRef, type CSSProperties } from 'react'
import { createRoot } from 'react-dom/client'
import './reasoning-slider.css'

const copy = {
  title: '推理强度', reset: '恢复默认推理等级', default: '默认',
  levels: { off: '关闭', none: '关闭', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高' } as Record<string, string>,
}

type Choice = { id: string; name: string }
type SliderProps = {
  levels: readonly Choice[]; value: string; defaultValue: string; model: string;
  disabled: boolean; onChange: (value: string) => void;
}

/** Discrete provider levels keep their original wire values; only captions are localized. */
export function ReasoningSlider({ levels, value, defaultValue, model, disabled, onChange }: SliderProps) {
  const index = Math.max(0, levels.findIndex(level => level.id === value))
  const label = (level: Choice) => level.id === '' ? copy.default : copy.levels[level.id] ?? level.name
  if (!levels.length) return null
  return <div className="reasoning-card" role="group" aria-label={copy.title}
    onKeyDown={event => { if (!['Escape', 'Tab'].includes(event.key)) event.stopPropagation() }}>
    <div className="reasoning-heading">
      <span aria-hidden="true" />
      <div className="reasoning-caption"><strong aria-live="polite">{label(levels[index]!)}</strong><span title={model}>{model}</span></div>
      <button type="button" className="reasoning-reset" aria-label={copy.reset} title={copy.reset}
        disabled={disabled || value === defaultValue} onClick={() => onChange(defaultValue)}><svg width="18" height="18" aria-hidden="true"><use href="#dsw-icon-refresh-outline-regular" /></svg></button>
    </div>
    <div className="reasoning-track" style={{ '--reasoning-fill': levels.length === 1 ? 0 : index / (levels.length - 1) } as CSSProperties}>
      <div className="reasoning-rail" aria-hidden="true"><div className="reasoning-fill" />
        <div className="reasoning-ticks">{levels.map((level, i) => <i key={level.id} className={i <= index ? 'filled' : ''} />)}</div>
      </div>
      <input type="range" min="0" max={Math.max(0, levels.length - 1)} step="1" value={index}
        disabled={disabled || levels.length < 2} aria-label={copy.title} aria-valuetext={label(levels[index]!)}
        onChange={event => onChange(levels[Number(event.target.value)]!.id)} />
    </div>
  </div>
}

type WorkState = { levels: string[]; value: string; model: string; disabled: boolean }

function WorkEffort({ state, onChange }: { state: WorkState; onChange: (value: string) => void }) {
  const id = useId()
  const panel = useRef<HTMLDivElement>(null)
  return <>
    <button type="button" className="control work-effort-trigger" disabled={state.disabled}
      popoverTarget={id} aria-label="选择 Work 推理强度" onClick={event => {
        if (panel.current) panel.current.style.bottom = `${Math.max(12, innerHeight - event.currentTarget.getBoundingClientRect().top + 8)}px`
      }}>{copy.levels[state.value] ?? (state.value || copy.default)}⌄</button>
    <div ref={panel} id={id} popover="auto" className="reasoning-popover">
      <ReasoningSlider levels={[{ id: '', name: copy.default }, ...state.levels.map(id => ({ id, name: id }))]}
        value={state.value} defaultValue="" model={state.model} disabled={state.disabled} onChange={onChange} />
    </div>
  </>
}

/** Mount Work's slider with only levels advertised by the connected agent. */
export function mountWorkEffort(element: HTMLElement, onChange: (value: string) => void) {
  const root = createRoot(element)
  let previous = ''
  return { update(state: WorkState) {
    element.hidden = !state.levels.length
    const signature = JSON.stringify(state)
    if (signature === previous) return
    previous = signature
    if (!state.levels.length || state.disabled) element.querySelector<HTMLElement>('[popover]')?.hidePopover()
    root.render(<WorkEffort state={state} onChange={onChange} />)
  } }
}
