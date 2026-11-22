// One interruptible spring owns each panel's visible position, including drag release.
export function panelMotion(panel, { axis = 'y', mask, handle, onDismiss, onClosed }) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)')
  let value = 1, velocity = 0, target = 1, frame = 0, previous = 0, drag
  // The model settings sheet has its own mask. Animate both compositor layers
  // together while leaving the main thread free for WebView and React work.
  let flight
  const transform = v => `translate${axis.toUpperCase()}(${(axis === 'x' ? -1 : 1) * v * 100}%)`
  const size = () => axis === 'x' ? panel.offsetWidth : panel.offsetHeight
  function paint() {
    panel.style.transform = reduced.matches ? 'none' : transform(value)
    panel.style.opacity = reduced.matches ? String(1 - value) : '1'
    if (mask) mask.style.opacity = String(1 - Math.max(0, Math.min(1, value)))
    else panel.style.setProperty('--panel-progress', String(1 - Math.max(0, Math.min(1, value))))
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
  function interruptFlight() {
    if (!flight) return
    const { slide, shade, sample } = flight
    const point = sample(Number(slide.currentTime || 0) / 1000)
    value = point.position
    velocity = point.speed
    slide.onfinish = null
    slide.cancel(); shade.cancel()
    flight = null
    paint()
  }
  function animateSheet(next) {
    if (flight && target === next) return
    interruptFlight()
    target = next
    const omega = reduced.matches ? 36 : 23
    const offset = value - next, carry = velocity + omega * offset
    const duration = reduced.matches ? 140 : 380
    const sample = seconds => {
      const decay = Math.exp(-omega * seconds)
      return { position: Math.max(0, Math.min(1, next + (offset + carry * seconds) * decay)),
        speed: (carry - omega * (offset + carry * seconds)) * decay }
    }
    const positions = Array.from({ length: 25 }, (_, i) =>
      i === 24 ? next : sample(duration * i / 24000).position)
    const fades = positions.map(v => ({ opacity: 1 - v }))
    const options = { duration, fill: 'both' }
    const slide = panel.animate(reduced.matches ? fades : positions.map(v => ({ transform: transform(v) })), options)
    const shade = mask.animate(fades, options)
    flight = { slide, shade, sample }
    panel.dataset.panelState = next ? 'closing' : 'opening'
    slide.onfinish = () => {
      if (flight?.slide !== slide) return
      flight = null
      value = next; velocity = 0; paint()
      slide.cancel(); shade.cancel()
      panel.dataset.panelState = next ? 'closed' : 'open'
      if (next) onClosed?.()
    }
  }
  function move(next) {
    if (mask && axis === 'y' && panel.animate) { animateSheet(next); return }
    target = next
    panel.dataset.panelState = next ? 'closing' : 'opening'
    if (!frame) { previous = performance.now(); frame = requestAnimationFrame(tick) }
  }
  const coordinate = event => axis === 'x' ? -event.clientX : event.clientY
  function down(event) {
    if (event.button !== 0 || drag || event.target.closest('button, input, textarea, select, a')) return
    interruptFlight()
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
    get position() { return value },
    track(position, speed) {
      cancelAnimationFrame(frame); frame = 0
      value = Math.max(0, Math.min(1, position))
      velocity = speed
      panel.dataset.panelState = 'dragging'
      paint()
    },
    open() { move(0) },
    close() { move(1) },
    dispose() {
      interruptFlight()
      cancelAnimationFrame(frame)
      handle?.removeEventListener('pointerdown', down)
      handle?.removeEventListener('pointermove', pointerMove)
      handle?.removeEventListener('pointerup', end)
      handle?.removeEventListener('pointercancel', end)
    },
  }
}

// Wait for horizontal intent before capturing the pointer, so a tap or a vertical
// scroll on a history row still reaches its native control.
function bindDrawerSwipe(panel, show, getMotion) {
  const surface = document.documentElement
  let swipe
  document.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary || swipe) return
    if (document.querySelector('dialog[open]:not(#sidebar), [role="dialog"][aria-modal="true"], [popover]:popover-open')) return
    const el = event.target
    const closing = panel.contains(el)
    if (!closing && (panel.open || !el.closest('#transcript') ||
      el.closest('button, a, input, textarea, select, pre, table, .katex-display, [contenteditable=true]'))) return
    if (!closing && window.getSelection()?.toString()) return
    swipe = { id: event.pointerId, x: event.clientX, y: event.clientY, closing, active: false }
  }, true)
  document.addEventListener('pointermove', event => {
    if (!swipe || swipe.id !== event.pointerId) return
    const x = event.clientX
    const dx = x - swipe.x, dy = event.clientY - swipe.y
    if (!swipe.active) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 10) return
      if (Math.abs(dx) < 1.35 * Math.abs(dy) || (swipe.closing ? dx >= 0 : dx <= 0)) {
        swipe = null
        return
      }
      surface.setPointerCapture(event.pointerId)
      if (!swipe.closing) show()
      const motion = getMotion()
      if (!motion) { swipe = null; return }
      swipe.start = motion.position
      swipe.width = Math.max(1, panel.offsetWidth)
      swipe.last = swipe.x
      swipe.time = event.timeStamp - 16
      swipe.active = true
    }
    const dt = Math.max(8, event.timeStamp - swipe.time)
    swipe.speed = Math.max(-4, Math.min(4, (swipe.last - x) / swipe.width * 1000 / dt))
    swipe.time = event.timeStamp
    swipe.last = x
    getMotion()?.track(swipe.start - dx / swipe.width, swipe.speed)
  }, true)
  function end(event) {
    if (!swipe || swipe.id !== event.pointerId) return
    const gesture = swipe
    swipe = null
    if (!gesture.active) return
    if (surface.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId)
    const motion = getMotion()
    if (!motion) return
    const speed = event.timeStamp - gesture.time < 100 ? gesture.speed : 0
    const close = event.type === 'pointerup' ? motion.position + speed * .09 > .5 : !gesture.closing
    if (close) panel.close()
    else panel.showModal()
  }
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) document.addEventListener(type, event => {
    // Implicit capture on the original touch target is lost when capture moves to the root.
    if (type !== 'lostpointercapture' || event.target === surface) end(event)
  }, true)
}

// The drawer uses a normal dialog layer so React settings can remain above it.
// Sheets keep native modal focus/keyboard behavior and close only after motion ends.
export function animateDialog(dialog, { drawer = false, onShow } = {}) {
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
        handle: drawer ? null : dialog.querySelector('.panel-grip'),
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
    onShow?.()
  }
  dialog.close = () => { if (dialog.open) { closing = true; motion.close() } }
  if (drawer) bindDrawerSwipe(dialog, () => dialog.showModal(), () => motion)
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
