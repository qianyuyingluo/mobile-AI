import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ICON_SYMBOLS } from '../../packages/client/ui-primitives/src/icons/artwork.ts'

export const variants = Object.freeze({
  'mobile-ai': { name: 'mobile-AI', assistant: 'AI', companion: false, pairScheme: 'mobile-ai',
    package: 'app.mobileai.mobile', apk: 'mobile-AI.apk', versionCode: '4', versionName: '1.0.3' },
})

/** Apply branding only inside the staged APK; the shared source and existing app stay intact. */
export function stageVariant(variant, { assets, resources, manifest }) {
  const { name, assistant, companion, pairScheme } = variant
  writeFileSync(join(assets, 'brand.js'), 'export const brand = Object.freeze(' + JSON.stringify({ name, assistant, companion, pairScheme }) + ')\n')
  if (companion) return

  const gear = ICON_SYMBOLS['dsw-icon-settings-outline-regular']
  const icon = gear.replace('<svg ', '<svg class="brand-gear" aria-hidden="true" width="24" height="24" ')
  let html = readFileSync(join(assets, 'index.html'), 'utf8')
    .replaceAll('绫音', name)
    .replace('href="./assets/avatar.webp"', 'href="./assets/mobile-ai.svg"')
    .replaceAll('<img src="./assets/avatar.webp" alt="" width="30" height="30">', icon)
    .replace('<span>mobile-AI</span>', '')
    .replace('class="brand" aria-label="展开会话侧边栏"', 'class="brand brand-icon-only" aria-label="打开会话与设置"')
    .replace(/<img id="animation"[^>]+>/, '<div id="animation" hidden aria-hidden="true"></div>')
    .replace('placeholder="发消息给mobile-AI…"', 'placeholder="输入消息…"')
  if (html.includes('avatar.webp') || html.includes('assets/animations/')) throw new Error('Companion artwork remains in mobile-AI HTML')
  writeFileSync(join(assets, 'index.html'), html)
  writeFileSync(join(assets, 'assets', 'mobile-ai.svg'), gear.replaceAll('currentColor', '#111214'))
  const css = readFileSync(join(assets, 'app.css'), 'utf8')
  if (!css.includes('.topbar .brand-icon-only')) writeFileSync(join(assets, 'app.css'), css + `
.topbar .brand-icon-only { width: 44px; height: 44px; padding: 0; justify-content: center; }
.brand-gear { flex: none; color: inherit; opacity: 1; }
.sidebar .brand-gear { margin-inline: 5px; }
`)

  const values = join(resources, 'values', 'strings.xml')
  writeFileSync(values, readFileSync(values, 'utf8').replace('>绫音<', '>' + name + '<')
    .replace('>yingluo<', '>' + pairScheme + '<').replace('>true</bool>', '>false</bool>'))
  writeFileSync(manifest, readFileSync(manifest, 'utf8').replace('package="app.yingluo.mobile"', 'package="' + variant.package + '"')
    .replace('android:scheme="yingluo"', 'android:scheme="' + pairScheme + '"')
    .replace('@drawable/yingluo', '@drawable/mobile_ai'))

  // Reuse the existing settings artwork for both the launcher and native status icon.
  const paths = [...gear.matchAll(/<path[^>]+\sd="([^"]+)"[^>]*>/g)].map(match => match[1])
  if (!paths.length) throw new Error('Settings icon has no vector paths')
  const vectorPaths = color => paths.map(path => `<path android:pathData="${path}" android:fillColor="#00000000" android:strokeColor="${color}" android:strokeWidth="1" />`).join('')
  const drawables = join(resources, 'drawable')
  mkdirSync(drawables, { recursive: true })
  writeFileSync(join(drawables, 'mobile_ai.xml'), `<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="108dp" android:height="108dp" android:viewportWidth="108" android:viewportHeight="108"><path android:fillColor="#ffffff" android:pathData="M0,0H108V108H0Z"/><group android:translateX="24" android:translateY="24" android:scaleX="3.75" android:scaleY="3.75">${vectorPaths('#111214')}</group></vector>`)
  writeFileSync(join(drawables, 'reply_status.xml'), `<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="24dp" android:height="24dp" android:viewportWidth="16" android:viewportHeight="16">${vectorPaths('#ffffff')}</vector>`)
}
