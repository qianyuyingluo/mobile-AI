import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'

export async function installHarnessSync(env = process.env) {
  const home = env.DSH_HOME || join(homedir(), '.dsh')
  const patch = join(home, 'profiles', 'desktop', 'cordis.patch.yml')
  try { await access(home) } catch { return }
  const text = await readFile(patch, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
  const directory = join(env.LOCALAPPDATA || homedir(), 'YingluoWork')
  await mkdir(directory, { recursive: true })
  const source = await readFile(fileURLToPath(new URL('./harness-desktop-plugin.mjs', import.meta.url)))
  const version = createHash('sha256').update(source).digest('hex').slice(0, 16)
  const plugin = join(directory, 'harness-desktop-plugin-' + version + '.mjs')
  // A new module path makes the installed Harness loader import the new code.
  // Merely changing the source file leaves its cached ESM module running.
  try { await access(plugin) } catch { await writeFile(plugin, source) }
  const quote = value => "'" + value.replaceAll('\\', '/').replaceAll("'", "''") + "'"
  let next
  if (text.includes('id: ayane-desktop-sync')) {
    const owned = /(id: ayane-desktop-sync\r?\n[ \t]+name: )[^\r\n]+/u
    if (!owned.test(text)) throw new Error('Harness 同步插件配置格式已更改，请检查 desktop profile。')
    next = text.replace(owned, (_match, prefix) => prefix + quote(plugin))
  } else next = text + '\n- insert:\n    - id: ayane-desktop-sync\n      name: ' + quote(plugin) +
    '\n      config:\n        descriptor: ' + quote(join(directory, 'harness-desktop.json')) + '\n'
  if (next === text) return
  if (text) await copyFile(patch, join(directory, 'desktop-patch-' + Date.now() + '-' + randomUUID() + '.backup'))
  await mkdir(join(home, 'profiles', 'desktop'), { recursive: true })
  await writeFile(patch, next)
}
