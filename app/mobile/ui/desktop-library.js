import { desktopRequestId } from './desktop-history.js'

export function mountDesktopLibrary({ request, renderMessages, resume, connection }) {
  const $ = id => document.getElementById(id)
  const dialog = $('desktop-library'), content = $('library-content')
  let group, session, before, timer, requestController, unmount, lastKey
  let agent = 'codex'
  let sending = false
  const viewKey = () => 'ayane.desktop-view.' + connection()
  const sendKey = () => 'ayane.desktop-send.' + connection() + '.' + group.agent + '.' + session.id

  function row(label, click) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'sidebar-session'
    button.textContent = label
    button.addEventListener('click', click)
    return button
  }
  function status(text) {
    $('library-status').textContent = text
    $('library-status').hidden = !text
  }
  function reset() {
    clearTimeout(timer)
    requestController?.abort()
    unmount?.()
    unmount = undefined
    content.replaceChildren()
    lastKey = undefined
    status('正在读取…')
    $('library-tools').hidden = true
    $('library-composer').hidden = !session
    let draft
    try { if (session) draft = JSON.parse(localStorage.getItem(sendKey())) } catch {}
    $('library-prompt').value = draft?.text || ''
    if (session) localStorage.setItem(viewKey(), JSON.stringify({ agent: group.agent, groupId: group.id, sessionId: session.id }))
    $('library-agents').hidden = Boolean(group)
    for (const button of $('library-agents').children) button.setAttribute('aria-pressed', String(button.dataset.agent === agent))
    $('library-back').hidden = !group
    $('library-title').textContent = session?.title || group?.name || '项目与工作区'
  }
  async function refresh() {
    clearTimeout(timer)
    requestController?.abort()
    const controller = new AbortController()
    requestController = controller
    const scroll = content.scrollTop
    try {
      if (session) {
        const path = '/library/' + group.agent + '/' + encodeURIComponent(session.id)
        const page = await request(path + (before == null ? '' : '?before=' + before), { signal: controller.signal, timeout: 60000 })
        if (controller.signal.aborted) return
        const key = [session.id, page.revision, before].join('/')
        if (key !== lastKey) {
          const firstLoad = lastKey === undefined
          unmount?.()
          unmount = renderMessages(page.messages, group.agent, content)
          content.scrollTop = firstLoad && before == null ? content.scrollHeight : scroll
          lastKey = key
        }
        status(page.total ? '' : '这条对话还没有消息。')
        $('library-tools').hidden = false
        $('library-resume').hidden = true
        $('library-composer').hidden = !page.liveSend
        $('library-latest').hidden = before == null
        $('library-older').hidden = page.before === 0
        $('library-older').onclick = () => { before = page.before; content.scrollTop = 0; void refresh() }
      } else {
        const { groups } = await request('/library', { signal: controller.signal })
        if (controller.signal.aborted) return
        const selected = group && groups.find(g => g.id === group.id && g.agent === group.agent)
        const key = JSON.stringify(group ? selected?.sessions ?? [] : groups.map(g => [g.id, g.name, g.sessions.length]))
        if (key !== lastKey) {
          content.replaceChildren()
          if (group) {
            for (const s of selected?.sessions ?? []) content.append(row(s.title, () => {
              session = s; before = undefined; reset(); void refresh()
            }))
          } else {
            for (const g of groups.filter(g => g.agent === agent)) content.append(row(g.name + ' · ' + g.sessions.length, () => {
              group = g; reset(); void refresh()
            }))
          }
          content.scrollTop = scroll
          lastKey = key
        }
        status(group && !selected?.sessions.length ? '此工作区暂无对话。' :
          !group && !groups.some(g => g.agent === agent) ? '电脑上暂无此软件的工作区。' : '')
      }
    } catch {
      if (!controller.signal.aborted) status('暂时无法读取电脑记录，请检查 Work 服务。')
    } finally {
      if (!controller.signal.aborted && dialog.open) timer = setTimeout(refresh, 6000)
    }
  }
  $('open-library').addEventListener('click', async () => {
    group = session = undefined
    reset(); dialog.showModal()
    try {
      const saved = JSON.parse(localStorage.getItem(viewKey()))
      if (saved) {
        const { groups } = await request('/library')
        if (!dialog.open) return
        group = groups.find(g => g.agent === saved.agent && g.id === saved.groupId)
        session = group?.sessions.find(s => s.id === saved.sessionId)
        if (session) agent = group.agent
        before = undefined
        reset()
      }
    } catch {}
    void refresh()
  })
  $('library-back').onclick = () => {
    if (session) session = undefined
    else group = undefined
    reset(); void refresh()
  }
  for (const button of $('library-agents').children) button.onclick = () => {
    agent = button.dataset.agent; reset(); void refresh()
  }
  $('library-latest').onclick = () => { before = undefined; reset(); void refresh() }
  $('library-resume').onclick = () => { dialog.close(); void resume(group.agent, session.id) }
  $('library-composer').onsubmit = async event => {
    event.preventDefault()
    const text = $('library-prompt').value.trim()
    if (!text || sending || !session) return
    const selected = session, selectedGroup = group
    const key = sendKey()
    let receipt
    try { receipt = JSON.parse(localStorage.getItem(key)) } catch {}
    if (!receipt || receipt.text !== text) receipt = { text, requestId: desktopRequestId() }
    localStorage.setItem(key, JSON.stringify(receipt))
    sending = true
    $('library-send').disabled = true
    status('正在发送到电脑…')
    try {
      await request('/library/' + selectedGroup.agent + '/' + encodeURIComponent(selected.id), {
        method: 'POST', data: receipt, timeout: 45000,
      })
      localStorage.removeItem(key)
      if (session === selected) { $('library-prompt').value = ''; before = undefined; await refresh() }
    } catch {
      status('发送结果待确认。请查看此对话的最新消息，重试将沿用原发送编号。')
    } finally {
      sending = false
      $('library-send').disabled = false
    }
  }
  dialog.addEventListener('close', reset)
}
