import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Modal } from './primitives.ts'
import { panelMotion } from '../ui/panel-motion.js'

/** Keep the original settings controls mounted until their sheet has slid out. */
export function SettingsSheet({ open, onClose, onClosed, children }: {
  open: boolean; onClose: () => void; onClosed: () => void; children: ReactNode
}) {
  const [present, setPresent] = useState(open)
  const grip = useRef<HTMLDivElement>(null)
  const motion = useRef<ReturnType<typeof panelMotion> | null>(null)
  const callbacks = useRef({ onClose, onClosed })
  callbacks.current = { onClose, onClosed }
  useLayoutEffect(() => {
    if (!present || !grip.current) return
    const panel = grip.current.closest('[role="dialog"]') as HTMLElement
    const layer = panel.parentElement!
    layer.classList.add('settings-sheet-layer')
    motion.current = panelMotion(panel, { handle: grip.current, mask: layer.firstElementChild,
      onDismiss: () => callbacks.current.onClose(),
      onClosed: () => { setPresent(false); callbacks.current.onClosed() },
    })
    return () => { motion.current?.dispose(); motion.current = null }
  }, [present])
  useLayoutEffect(() => {
    if (open && !present) { setPresent(true); return }
    if (present) { if (open) motion.current?.open(); else motion.current?.close() }
  }, [open, present])
  return <Modal open={present} title="设置" closeLabel="关闭" onClose={onClose}
    className="yingluo-model-settings" contentClassName="yingluo-model-settings-content">
    <div ref={grip} className="panel-grip" aria-hidden="true"><span /></div>
    {children}
  </Modal>
}
