export function createImageViewer(dialog) {
  const image = dialog.querySelector('#viewer-image')
  const stage = dialog.querySelector('#viewer-stage')
  const zoom = dialog.querySelector('#viewer-zoom')
  const pointers = new Map()
  let files = [], index = 0, scale = 1, x = 0, y = 0, gesture
  const clamp = (value, bound) => Math.max(-bound, Math.min(bound, value))
  function paint() {
    x = clamp(x, stage.clientWidth * (scale - 1) / 2)
    y = clamp(y, stage.clientHeight * (scale - 1) / 2)
    image.style.transform = `translate(${x}px, ${y}px) scale(${scale})`
    zoom.textContent = scale > 1 ? '还原' : '放大'
  }
  function show(next) {
    index = Math.max(0, Math.min(files.length - 1, next))
    const file = files[index]
    image.src = 'data:' + file.type + ';base64,' + file.data
    image.alt = file.name
    dialog.querySelector('#viewer-count').textContent = `${index + 1} / ${files.length}`
    dialog.querySelector('#viewer-name').textContent = file.name
    dialog.querySelector('#viewer-prev').disabled = index === 0
    dialog.querySelector('#viewer-next').disabled = index === files.length - 1
    scale = 1; x = y = 0
    paint()
  }
  const toggleZoom = () => { scale = scale > 1 ? 1 : 3; x = y = 0; paint() }
  zoom.onclick = toggleZoom
  stage.ondblclick = toggleZoom
  dialog.querySelector('#viewer-prev').onclick = () => show(index - 1)
  dialog.querySelector('#viewer-next').onclick = () => show(index + 1)
  dialog.addEventListener('keydown', event => {
    if (event.key === 'ArrowLeft') show(index - 1)
    if (event.key === 'ArrowRight') show(index + 1)
  })
  const distance = () => { const [a, b] = [...pointers.values()]; return Math.hypot(a.x - b.x, a.y - b.y) }
  stage.addEventListener('pointerdown', event => {
    stage.setPointerCapture(event.pointerId)
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    gesture = pointers.size === 2 ? { distance: distance(), scale }
      : { start: event.clientX, lastX: event.clientX, lastY: event.clientY, swipe: scale === 1 }
  })
  stage.addEventListener('pointermove', event => {
    if (!pointers.has(event.pointerId)) return
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (pointers.size === 2 && gesture.distance) {
      scale = Math.max(1, Math.min(5, gesture.scale * distance() / Math.max(1, gesture.distance)))
    } else if (pointers.size === 1 && !gesture.distance) {
      if (scale > 1) { x += event.clientX - gesture.lastX; y += event.clientY - gesture.lastY }
      gesture.lastX = event.clientX; gesture.lastY = event.clientY
    }
    paint()
  })
  function release(event) {
    if (event.type === 'pointerup' && pointers.size === 1 && gesture?.swipe && Math.abs(event.clientX - gesture.start) > 60) {
      show(index + (event.clientX < gesture.start ? 1 : -1))
    }
    pointers.delete(event.pointerId)
    const remaining = [...pointers.values()][0]
    gesture = remaining ? { start: remaining.x, lastX: remaining.x, lastY: remaining.y, swipe: false } : undefined
  }
  stage.addEventListener('pointerup', release)
  stage.addEventListener('pointercancel', release)
  dialog.addEventListener('close', () => { files = []; pointers.clear(); image.removeAttribute('src') })
  return (gallery, selected) => { files = gallery; dialog.showModal(); show(selected) }
}
