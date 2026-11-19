/** Reading position and the touch-operated question index share one scroll owner. */
export function createReadingNavigation({ transcript, thread, host, bottom }) {
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
  const panel = host.querySelector('.question-panel')
  const handle = host.querySelector('.question-handle')
  const wheel = host.querySelector('.question-wheel')
  const count = host.querySelector('.question-count')
  const close = host.querySelector('.question-close')
  let follow = true
  let sessionKey = ''
  let signature = ''
  let questions = []
  let buttons = []
  let current = 0
  let expanded = false
  let gesture = null
  let suppressClick = false
  let frame = 0
  let lastTime = 0
  let scrollFrame = 0
  let lastScrolledTop = transcript.scrollTop
  // Positions stay live during spring motion, so a new drag can interrupt it.
  const drawer = { value: 0, target: 0, velocity: 0 }
  const rotation = { value: 0, target: 0, velocity: 0 }
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
  const lastIndex = () => Math.max(0, questions.length - 1)
  const width = () => host.getBoundingClientRect().width
  const spacing = () => Math.min(68, Math.max(50, wheel.clientHeight / 5))

  function paint() {
    host.style.transform = `translate3d(${(drawer.value - 1) * width()}px,0,0)`
    const step = spacing()
    const radius = step / .28
    const center = wheel.clientHeight / 2
    const selected = clamp(Math.round(rotation.value), 0, lastIndex())
    buttons.forEach((button, index) => {
      const distance = index - rotation.value
      const visible = Math.abs(distance) < Math.min(3.6, (center - 12) / step + .45)
      if (button.hidden === visible) button.hidden = !visible
      button.tabIndex = index === selected ? 0 : -1
      button.toggleAttribute('data-selected', index === selected)
      if (!visible) return
      const angle = distance * .28
      const x = 8 + (Math.cos(angle) - 1) * radius * .12
      const y = center + Math.sin(angle) * radius
      const scale = Math.max(.78, 1 - Math.abs(distance) * .065)
      button.style.transform = `translate3d(${x}px,${y}px,0) translateY(-50%) scale(${scale})`
      button.style.opacity = String(Math.max(.24, 1 - Math.abs(distance) * .23))
    })
    count.textContent = questions.length ? `${selected + 1} / ${questions.length}` : ''
  }

  function tick(time) {
    frame = 0
    const dt = Math.min((time - (lastTime || time - 16)) / 1000, .032)
    lastTime = time
    let moving = false
    for (const [state, dragging] of [[drawer, gesture?.axis === 'x'], [rotation, gesture?.axis === 'y']]) {
      if (dragging) continue
      if (reducedMotion.matches) { state.value = state.target; state.velocity = 0; continue }
      // Critically damped spring; release velocity is inherited from the drag.
      state.velocity += ((state.target - state.value) * 360 - state.velocity * 38) * dt
      state.value += state.velocity * dt
      if (Math.abs(state.value - state.target) < .001 && Math.abs(state.velocity) < .008) {
        state.value = state.target; state.velocity = 0
      } else moving = true
    }
    paint()
    if (moving) frame = requestAnimationFrame(tick)
    else lastTime = 0
  }

  function animate() {
    if (!frame) { lastTime = 0; frame = requestAnimationFrame(tick) }
  }

  function pause() { follow = false }

  function setExpanded(next, focus = false) {
    if (!questions.length) next = false
    const opening = next && !expanded
    expanded = next
    drawer.target = next ? 1 : 0
    panel.inert = !next
    panel.setAttribute('aria-hidden', String(!next))
    handle.setAttribute('aria-expanded', String(next))
    handle.setAttribute('aria-label', next ? '收起对话进度' : '展开对话进度')
    host.toggleAttribute('data-expanded', next)
    if (opening) {
      pause()
      rotation.value = rotation.target = current
      rotation.velocity = 0
      paint()
      if (focus) buttons[current]?.focus({ preventScroll: true })
    } else if (!next && panel.contains(document.activeElement)) handle.focus({ preventScroll: true })
    animate()
  }

  function syncPosition() {
    bottom.hidden = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 56
    const readingLine = transcript.getBoundingClientRect().top + 80
    // The last question above the reading line owns its following answer.
    let low = 0, high = questions.length - 1, found = 0
    while (low <= high) {
      const middle = (low + high) >> 1
      if (questions[middle].element.getBoundingClientRect().top <= readingLine) {
        found = middle; low = middle + 1
      } else high = middle - 1
    }
    current = found
    buttons.forEach((button, index) => {
      if (index === current) button.setAttribute('aria-current', 'location')
      else button.removeAttribute('aria-current')
    })
    if (!expanded) rotation.value = rotation.target = current
  }

  function latest() {
    follow = true
    transcript.scrollTop = transcript.scrollHeight
    lastScrolledTop = transcript.scrollTop
    syncPosition()
  }

  function jump(index) {
    const question = questions[index]
    if (!question) return
    pause()
    const clearance = parseFloat(getComputedStyle(transcript).scrollPaddingTop) || 64
    transcript.scrollTop += question.element.getBoundingClientRect().top - transcript.getBoundingClientRect().top - clearance
    // Keep screen-reader and keyboard focus at the destination without scrolling it again.
    question.element.tabIndex = -1
    setExpanded(false)
    question.element.focus({ preventScroll: true })
    syncPosition()
  }

  function preview(text) {
    const compact = text.replace(/\s+/g, ' ').trim()
    const words = compact.split(' ')
    const excerpt = words.length > 3 ? words.slice(0, 3).join(' ') : compact
    const chars = Array.from(excerpt)
    return chars.slice(0, 14).join('') + (chars.length > 14 || excerpt !== compact ? '…' : '')
  }

  function update(key, messages) {
    const next = messages.filter(message => message.role === 'user')
    const elements = thread.querySelectorAll('.message-user')
    const nextSignature = JSON.stringify([key, next.map(message => [message.text, message.attachments?.map(file => file.name)])])
    questions = next.map((message, index) => ({ element: elements[index],
      label: preview(message.text || message.attachments?.[0]?.name || '附件提问') }))
    if (key !== sessionKey) {
      sessionKey = key
      gesture = null
      setExpanded(false)
      drawer.value = drawer.target = 0
      drawer.velocity = 0
    }
    host.hidden = questions.length === 0
    if (!questions.length) { gesture = null; setExpanded(false) }
    if (nextSignature !== signature) {
      signature = nextSignature
      buttons = questions.map((question, index) => {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'question-item'
        button.hidden = true
        button.dataset.question = String(index + 1)
        button.setAttribute('aria-label', `第 ${index + 1} 个问题：${question.label}`)
        const number = document.createElement('span')
        number.className = 'question-number'
        number.textContent = String(index + 1).padStart(2, '0')
        const label = document.createElement('span')
        label.className = 'question-label'
        label.textContent = question.label
        button.append(number, label)
        button.addEventListener('click', event => { if (!suppressClick || event.detail === 0) jump(index) })
        return button
      })
      wheel.replaceChildren(...buttons)
      rotation.value = clamp(rotation.value, 0, lastIndex())
      rotation.target = clamp(rotation.target, 0, lastIndex())
    }
    syncPosition()
    paint()
  }

  function pointerDown(event) {
    if (!event.isPrimary || event.button !== 0 || gesture) return
    pause()
    suppressClick = false
    gesture = { id: event.pointerId, startX: event.clientX, startY: event.clientY,
      drawer: drawer.value, rotation: rotation.value, fromHandle: handle.contains(event.target), axis: '',
      samples: [{ x: event.clientX, y: event.clientY, time: event.timeStamp }] }
    drawer.target = drawer.value; drawer.velocity = 0
    rotation.target = rotation.value; rotation.velocity = 0
  }

  function pointerMove(event) {
    if (!gesture || event.pointerId !== gesture.id) return
    const dx = event.clientX - gesture.startX, dy = event.clientY - gesture.startY
    if (!gesture.axis && Math.hypot(dx, dy) > 7) {
      gesture.axis = gesture.fromHandle || Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
      host.setPointerCapture(event.pointerId)
      suppressClick = true
    }
    if (!gesture.axis) return
    gesture.samples.push({ x: event.clientX, y: event.clientY, time: event.timeStamp })
    gesture.samples = gesture.samples.filter(sample => event.timeStamp - sample.time < 100)
    if (gesture.axis === 'x') {
      drawer.value = clamp(gesture.drawer + dx / width(), 0, 1)
    } else {
      const value = gesture.rotation - dy / spacing()
      const bound = clamp(value, 0, lastIndex())
      const overshoot = value - bound
      rotation.value = bound + overshoot * .35 / (1 + Math.abs(overshoot))
    }
    paint()
  }

  function pointerEnd(event) {
    if (!gesture || event.pointerId !== gesture.id) return
    const ended = gesture
    gesture = null
    if (host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId)
    const first = ended.samples[0]
    const last = ended.samples.at(-1)
    const elapsed = Math.max(16, last.time - first.time) / 1000
    const fresh = event.timeStamp - last.time < 100 && event.type !== 'pointercancel'
    if (ended.axis === 'x') {
      drawer.velocity = fresh ? (last.x - first.x) / elapsed / width() : 0
      const projected = drawer.value + drawer.velocity * .16
      setExpanded(event.type === 'pointercancel' ? expanded : projected > .5)
    } else if (ended.axis === 'y') {
      rotation.velocity = fresh ? clamp(-(last.y - first.y) / elapsed / spacing(), -18, 18) : 0
      // Exponential-decay projection (0.995), snapped to a question.
      rotation.target = clamp(Math.round(rotation.value + rotation.velocity / 1000 * .995 / .005), 0, lastIndex())
      animate()
    } else {
      drawer.target = expanded ? 1 : 0
      rotation.target = clamp(Math.round(rotation.value), 0, lastIndex())
      animate()
    }
  }

  host.addEventListener('pointerdown', pointerDown)
  host.addEventListener('pointermove', pointerMove)
  host.addEventListener('pointerup', pointerEnd)
  host.addEventListener('pointercancel', pointerEnd)
  handle.addEventListener('click', event => { if (!suppressClick || event.detail === 0) setExpanded(!expanded, true) })
  close.addEventListener('click', event => { if (!suppressClick || event.detail === 0) setExpanded(false) })
  wheel.addEventListener('wheel', event => {
    event.preventDefault()
    rotation.target = clamp(rotation.target + Math.sign(event.deltaY), 0, lastIndex())
    animate()
  }, { passive: false })
  wheel.addEventListener('keydown', event => {
    const actions = { ArrowDown: rotation.target + 1, ArrowUp: rotation.target - 1, Home: 0, End: lastIndex() }
    if (!(event.key in actions)) return
    event.preventDefault()
    rotation.target = clamp(actions[event.key], 0, lastIndex())
    // Make a keyboard destination visible before focusing it.
    rotation.value = rotation.target; rotation.velocity = 0
    paint()
    buttons[rotation.target]?.focus({ preventScroll: true })
  })
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && expanded) { event.preventDefault(); setExpanded(false) }
    if (transcript.contains(event.target) && ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) pause()
  })
  document.addEventListener('pointerdown', event => {
    // Touch means the reader has taken control, even while still near the bottom.
    if (event.pointerType === 'touch' || transcript.contains(event.target)) pause()
    if (expanded && !host.contains(event.target)) setExpanded(false)
  }, { capture: true, passive: true })
  transcript.addEventListener('wheel', pause, { passive: true })
  transcript.addEventListener('scroll', () => {
    if (transcript.scrollTop < lastScrolledTop - 1) pause()
    lastScrolledTop = transcript.scrollTop
    if (!scrollFrame) scrollFrame = requestAnimationFrame(() => { scrollFrame = 0; syncPosition() })
  }, { passive: true })
  bottom.addEventListener('click', latest)
  const resize = new ResizeObserver(() => {
    if (follow) { transcript.scrollTop = transcript.scrollHeight; lastScrolledTop = transcript.scrollTop }
    syncPosition()
    paint()
  })
  resize.observe(thread)
  resize.observe(transcript)
  resize.observe(wheel)
  reducedMotion.addEventListener('change', animate)

  return {
    /** Capture before replacing rows; an append must not reclaim a paused reader. */
    beforeRender(reset) { if (reset) follow = true; return transcript.scrollTop },
    afterRender(key, messages, previousTop) {
      transcript.scrollTop = follow ? transcript.scrollHeight : previousTop
      lastScrolledTop = transcript.scrollTop
      update(key, messages)
    },
    latest,
    close() { if (!expanded) return false; setExpanded(false); return true },
  }
}
