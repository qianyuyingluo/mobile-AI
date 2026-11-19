// One interruptible spring owns each panel's visible position, including drag release.
export function panelMotion(panel, { axis = 'y', mask, handle, onDismiss, onClosed }) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)')
  let value = 1, velocity = 0, target = 1, frame = 0, previous = 0, drag
  const size = () => axis === 'x' ? panel.offsetWidth : panel.offsetHeight
  function paint() {
    panel.style.transform = reduced.matches ? 'none' : `translate${axis.toUpperCase()}(${(axis === 'x' ? -1 : 1) * value * 100}%)`
    panel.style.opacity = reduced.matches ? String(1 - value) : '1'
    if (mask) mask.style.opacity = String(1 - Math.max(0, Math.min(1, value)))
    panel.style.setProperty('--panel-progress', String(1 - Math.max(0, Math.min(1, value))))
  }
  function tick(time) {
    const dt = Math.min((time - previous) / 1000 || .016, .032)
    previous = time
    // Critical damping: fast arrival without bounce. The current velocity survives retargeting.
    const omega = reduced.matches ? 36 : 23
    const offset = value - target, decay = Math.exp(-omega * dt)
    const carry = velocity + omega * offset
    value = target + (offset + carry * dt) * decay
    velocity = (velocity - omega * carry * dt) * decay
    if (Math.abs(value - target) < .001 && Math.abs(velocity) < .012) {
      value = target; velocity = 0; frame = 0; paint()
      panel.dataset.panelState = target ? 'closed' : 'open'
      if (target === 1) onClosed?.()
      return
    }
    paint(); frame = requestAnimationFrame(tick)
  }
  function move(next) {
    target = next
    panel.dataset.panelState = next ? 'closing' : 'opening'
    if (!frame) { previous = performance.now(); frame = requestAnimationFrame(tick) }
  }
  const coordinate = event => axis === 'x' ? -event.clientX : event.clientY
  function down(event) {
    if (event.button !== 0 || drag || event.target.closest('button, input, textarea, select, a')) return
    cancelAnimationFrame(frame); frame = 0
    drag = { id: event.pointerId, start: coordinate(event), value, last: coordinate(event), time: performance.now(), moved: false }
    handle.setPointerCapture(event.pointerId)
  }
  function pointerMove(event) {
    if (!drag || drag.id !== event.pointerId) return
    const point = coordinate(event), delta = point - drag.start
    if (!drag.moved && Math.abs(delta) < 8) return
    drag.moved = true
    panel.dataset.panelState = 'dragging'
    const now = performance.now(), elapsed = now - drag.time
    velocity = elapsed > 0 ? (point - drag.last) / elapsed * 1000 / size() : 0
    value = Math.max(0, Math.min(1, drag.value + delta / size()))
    drag.last = point; drag.time = now; paint()
  }
  function end(event) {
    if (!drag || drag.id !== event.pointerId) return
    const dismiss = event.type !== 'pointercancel' && drag.moved &&
      (value > .28 || (value > .04 && velocity > .65 && performance.now() - drag.time < 100))
    drag = undefined
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId)
    if (dismiss) onDismiss()
    else move(0)
  }
  handle?.addEventListener('pointerdown', down)
  handle?.addEventListener('pointermove', pointerMove)
  handle?.addEventListener('pointerup', end)
  handle?.addEventListener('pointercancel', end)
  paint()
  return {
    open() { move(0) },
    close() { move(1) },
    dispose() {
      cancelAnimationFrame(frame)
      handle?.removeEventListener('pointerdown', down)
      handle?.removeEventListener('pointermove', pointerMove)
      handle?.removeEventListener('pointerup', end)
      handle?.removeEventListener('pointercancel', end)
    },
  }
}

// The drawer uses a normal dialog layer so React settings can remain above it.
// Sheets keep native modal focus/keyboard behavior and close only after motion ends.
export function animateDialog(dialog, { drawer = false } = {}) {
  const nativeClose = dialog.close.bind(dialog)
  const nativeShow = (drawer ? dialog.show : dialog.showModal).bind(dialog)
  const opener = () => document.activeElement
  let previousFocus, motion, closing = false
  const mask = drawer ? document.createElement('div') : null
  if (mask) {
    mask.className = 'drawer-mask'; mask.hidden = true
    dialog.before(mask)
    mask.addEventListener('click', () => dialog.close())
  }
  if (!drawer) {
    const grip = document.createElement('div')
    grip.className = 'panel-grip'; grip.setAttribute('aria-hidden', 'true')
    grip.append(document.createElement('span')); dialog.prepend(grip)
    dialog.classList.add('settings-sheet')
  }
  dialog.setAttribute('aria-modal', 'true')
  dialog.showModal = () => {
    closing = false
    if (!dialog.open) {
      previousFocus = opener()
      nativeShow()
      if (mask) { mask.hidden = false; document.querySelector('.app').inert = true }
      motion = panelMotion(dialog, { axis: drawer ? 'x' : 'y', mask,
        handle: dialog.querySelector(drawer ? '.sidebar-header' : '.panel-grip'),
        onDismiss: () => dialog.close(),
        onClosed: () => {
          if (!closing) return
          motion.dispose(); motion = undefined
          nativeClose()
          if (mask) { mask.hidden = true; document.querySelector('.app').inert = false }
          if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
        },
      })
    }
    motion.open()
  }
  dialog.close = () => { if (dialog.open) { closing = true; motion.close() } }
  dialog.addEventListener('cancel', event => { event.preventDefault(); dialog.close() })
  if (drawer) document.addEventListener('keydown', event => {
    if (!dialog.open || document.querySelector('[role="dialog"][aria-modal="true"], dialog[open]:not(#sidebar), [role="menu"]')) return
    if (event.key === 'Escape') { event.preventDefault(); dialog.close() }
    if (event.key !== 'Tab') return
    const items = [...dialog.querySelectorAll('button:not(:disabled), summary, input, [tabindex="0"]')].filter(el => el.getClientRects().length)
    const next = event.shiftKey ? items.at(-1) : items[0]
    if (document.activeElement === (event.shiftKey ? items[0] : items.at(-1))) { event.preventDefault(); next?.focus() }
  })
}
