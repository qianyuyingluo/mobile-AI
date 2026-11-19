// Uses a local fake SSE model, never a user's API credentials. Restores the normal APK in finally.
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import assert from 'node:assert/strict'

const root = resolve(import.meta.dirname, '../..')
const adb = join(process.env.LOCALAPPDATA, 'Android/Sdk/platform-tools/adb.exe')
const apk = join(root, 'mobile/mobile-AI.apk')
const temp = mkdtempSync(join(tmpdir(), 'yingluo-reply-device-'))
const ui = join(temp, 'ui')
mkdirSync(ui)
const run = (cmd, args) => {
  const result = spawnSync(cmd, args, { windowsHide: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout)
  return result.stdout
}
const device = (...args) => run(adb, args)
const capture = name => writeFileSync(join(temp, name + '.png'), spawnSync(adb, ['exec-out', 'screencap', '-p'], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 }).stdout)
const server = createServer((req, res) => {
  req.resume()
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const emit = value => res.write('data: ' + JSON.stringify(value) + '\n\n')
  emit({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })
  const output = setTimeout(() => {
    emit({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } })
    emit({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '这是本地测试回复。' } })
  }, 9000)
  const end = setTimeout(() => { emit({ type: 'message_stop' }); res.end() }, 16000)
  res.on('close', () => { clearTimeout(output); clearTimeout(end) })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
writeFileSync(join(ui, 'app.css'), '')
writeFileSync(join(ui, 'index.html'), '<!doctype html><html><meta name="viewport" content="width=device-width"><h1>mobile-AI · 本地实况测试</h1><p>测试结束后恢复正常应用。</p><script src="test-' + port + '.js"></script></html>')
writeFileSync(join(ui, 'test-' + port + '.js'), `window.yingluoHttpChunk=()=>{}; window.yingluoHttpResult=(id,status)=>{document.body.dataset.status=status;console.log('ReplyDeviceResult:'+status)};
setTimeout(()=>{YingluoNative.setReplySession('device-smoke');YingluoNative.request('smoke','http://127.0.0.1:${port}/stream','POST','{"Accept":"text/event-stream"}','{}')},1000);`)
try {
  console.log('Building device fixture: ' + temp)
  run(process.execPath, [join(root, 'mobile/android/build.mjs'), '--ui', ui, '--output', join(temp, 'fixture.apk')])
  device('reverse', `tcp:${port}`, `tcp:${port}`)
  device('install', '-r', join(temp, 'fixture.apk'))
  await sleep(1500)
  device('shell', 'am', 'force-stop', 'app.mobileai.mobile')
  device('shell', 'am', 'start', '-n', 'app.mobileai.mobile/app.yingluo.mobile.MainActivity')
  await sleep(4000)
  capture('permission')
  const permissions = device('shell', 'dumpsys', 'package', 'app.mobileai.mobile')
  if (!/android.permission.POST_NOTIFICATIONS: granted=true/.test(permissions)) {
    console.log('Waiting for notification permission on phone (60 seconds).')
    await sleep(60000)
    device('shell', 'am', 'force-stop', 'app.mobileai.mobile')
    device('shell', 'am', 'start', '-n', 'app.mobileai.mobile/app.yingluo.mobile.MainActivity')
    await sleep(4000)
  }
  device('shell', 'input', 'keyevent', 'KEYCODE_HOME')
  await sleep(1800)
  capture('thinking')
  await sleep(250)
  capture('thinking-next-frame')
  const inspect = name => {
    const dump = device('shell', 'dumpsys', 'notification', '--noredact')
    const records = dump.split(/(?=NotificationRecord\()/).filter(block => block.startsWith('NotificationRecord(') && block.split('\n')[0].includes('pkg=app.mobileai.mobile'))
    const relevant = records.map(block => block.split(/\n\s*(?:NotificationRecord\(|Zen Mode|Ranking Config|Notification listeners)/)[0]).join('\n')
    writeFileSync(join(temp, name + '.txt'), relevant)
    console.log(name + ': ' + relevant.split('\n').filter(line => /NotificationRecord\(|android.title=|android.text=|requestPromoted|mFgs|flags=/.test(line)).join('\n').slice(0, 1800))
    return relevant
  }
  const thinking = inspect('thinking')
  assert.match(thinking, /思考中/)
  assert.match(thinking, /PROMOTED_ONGOING/)
  await sleep(6000)
  capture('replying')
  assert.match(inspect('replying'), /正在回复/)
  await sleep(6500)
  capture('completed')
  await sleep(250)
  capture('completed-next-frame')
  assert.match(inspect('completed'), /回复完成/)
  device('shell', 'cmd', 'statusbar', 'expand-notifications')
  await sleep(700)
  capture('completed-expanded')
  device('shell', 'cmd', 'statusbar', 'collapse')
  await sleep(15000)
  assert.equal(inspect('expired'), '', 'Finished reply notification must expire')
  console.log('PASS: OPPO native background progress, completion and expiry; animation playback requires visual review. Screenshots: ' + temp)
} finally {
  try {
    device('shell', 'am', 'force-stop', 'app.mobileai.mobile')
    device('install', '-r', apk)
    device('reverse', '--remove', `tcp:${port}`)
  } finally {
    server.closeAllConnections()
    server.close()
  }
}
