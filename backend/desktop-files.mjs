import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path'
import { homedir } from 'node:os'

const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }
export const fileType = path => types[extname(path).toLowerCase()] || 'application/octet-stream'

export function deliveredFiles(entry, files) {
  return (files || []).filter(f => typeof f?.path === 'string' && isAbsolute(f.path)).map(f => ({
    name: basename(f.path), type: fileType(f.path), description: f.description || '', _path: f.path,
  }))
}

export function contentFiles(entry, content) {
  if (!Array.isArray(content)) return []
  return content.flatMap(part => {
    if (['localImage', 'local_image'].includes(part?.type) && typeof part.path === 'string') {
      return deliveredFiles(entry, [{ path: part.path }])
    }
    const ref = part?.attachment
    const hash = /^sha256:([a-f0-9]{64})$/u.exec(ref?.attachmentId || '')?.[1]
    if (!hash || !entry.home) return []
    const root = join(entry.home, 'attachments', 'v1')
    if (part.type === 'image') return [{ name: ref.name || '图片', type: ref.mediaType,
      _path: join(root, 'objects', hash.slice(0, 2), hash) }]
    if (part.type === 'file' && typeof ref.name === 'string' && ref.name === basename(ref.name)) return [{ name: ref.name, type: fileType(ref.name),
      _path: join(root, 'files', hash.slice(0, 2), hash, ref.name) }]
    return []
  })
}

// Only explicit attachment/deliverable records in a returned conversation page
// grant a file handle. Never accept a phone-supplied filesystem path.
export function desktopFiles() {
  const handles = new Map()
  function expose(entry, messages) {
    return messages.map(message => ({ ...message, ...(message.attachments?.length && {
      attachments: message.attachments.map(({ _path, ...file }) => {
        const id = createHash('sha256').update(entry.agent + ':' + entry.id + ':' + _path).digest('hex')
        handles.set(id, { entry, path: _path, file })
        if (handles.size > 2048) handles.delete(handles.keys().next().value)
        return { ...file, desktopFile: id, desktopAgent: entry.agent, desktopSession: entry.id }
      }),
    }) }))
  }
  async function read(entry, id) {
    const saved = handles.get(id)
    if (!saved || saved.entry.id !== entry.id || saved.entry.agent !== entry.agent) throw new Error('请刷新会话后重新打开文件。')
    const roots = [entry.cwd, entry.home && join(entry.home, 'attachments'),
      entry.agent === 'codex' && join(homedir(), '.codex', 'attachments')].filter(Boolean)
    const path = await realpath(saved.path)
    let allowed = false
    for (const root of roots) {
      const actualRoot = await realpath(root).catch(() => null)
      if (!actualRoot) continue
      const rel = relative(actualRoot, path)
      if (rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep)) allowed = true
    }
    if (!allowed) throw new Error('文件位于此会话工作区之外，请在电脑上打开。')
    const info = await stat(path)
    if (!info.isFile() || info.size > 5 * 1024 * 1024) throw new Error('文件超过 5 MB 的预览限制，请在电脑上打开。')
    const data = await readFile(path)
    return { ...saved.file, size: data.length, data: data.toString('base64') }
  }
  return { expose, read }
}
