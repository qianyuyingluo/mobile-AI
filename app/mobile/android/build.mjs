import { spawnSync } from 'node:child_process'
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { buildMobilePicker } from '../picker/build.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const appRoot = resolve(here, '..', '..')
const assetRoot = join(appRoot, '..', 'yingluo-animation-v2')
const windows = process.platform === 'win32'
const exe = windows ? '.exe' : ''
const collator = new Intl.Collator('en', { numeric: true })
const minSdk = '26'
const targetSdk = '34'

const { values: args } = parseArgs({
  options: { ui: { type: 'string' }, output: { type: 'string' } },
})
const ui = args.ui === undefined ? resolve(here, '../ui') : resolve(args.ui)
const output = args.output === undefined ? resolve(here, '../Yingluo.apk') : resolve(args.output)
const sdk = resolveSdk()
const platform = latestDirectory(join(sdk, 'platforms'), /^android-\d+$/, name => Number(name.slice(8)) >= 36)
const tools = latestDirectory(join(sdk, 'build-tools'), /^\d+\.\d+\.\d+$/)
const javaBin = resolveJavaBin()

/**
 * Select a fully installed Android tooling directory.
 */
function latestDirectory(parent, pattern, fits = () => true) {
  if (!existsSync(parent)) throw new Error('Android SDK is missing ' + basename(parent))
  const candidates = readdirSync(parent, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && pattern.test(entry.name) && fits(entry.name))
    .map(entry => entry.name)
    .sort(collator.compare)
  const chosen = candidates.at(-1)
  if (!chosen) throw new Error('Android SDK has no supported version in ' + basename(parent))
  return join(parent, chosen)
}

function resolveSdk() {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Android', 'Sdk'),
    join(homedir(), 'Library', 'Android', 'sdk'),
    join(homedir(), 'Android', 'Sdk'),
  ]
  const chosen = candidates.find(path => path && existsSync(join(path, 'platforms')))
  if (!chosen) throw new Error('Set ANDROID_HOME to an Android SDK with a platform and Build Tools')
  return resolve(chosen)
}

function resolveJavaBin() {
  const candidates = [
    process.env.JAVA_HOME && join(process.env.JAVA_HOME, 'bin'),
    ...((process.env.PATH ?? '').split(delimiter).filter(Boolean)),
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'Android', 'Android Studio', 'jbr', 'bin'),
    '/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin',
  ]
  const chosen = candidates.find(path => path
    && existsSync(join(path, 'javac' + exe)) && existsSync(join(path, 'keytool' + exe))
    && existsSync(join(path, 'jar' + exe)))
  if (!chosen) throw new Error('Set JAVA_HOME to a JDK 17 or newer, such as Android Studio’s bundled JDK')
  return resolve(chosen)
}

function run(file, argv, options = {}) {
  const child = spawnSync(file, argv, { stdio: 'inherit', windowsHide: true, ...options })
  if (child.error) throw child.error
  if (child.status !== 0) throw new Error(basename(file) + ' exited with status ' + child.status)
}

function copy(source, destination) {
  mkdirSync(dirname(destination), { recursive: true })
  cpSync(source, destination, { recursive: statSync(source).isDirectory() })
}

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => {
      const file = join(directory, entry.name)
      if (entry.isDirectory()) return sourceFiles(file)
      return extname(file) === '.java' ? [file] : []
    })
}

function debugKeystore() {
  const file = join(homedir(), '.android', 'yingluo-debug.keystore')
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true })
    run(join(javaBin, 'keytool' + exe), ['-genkeypair', '-keystore', file, '-storetype', 'PKCS12',
      '-storepass', 'android', '-keypass', 'android', '-alias', 'yingluo-debug',
      '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000', '-dname', 'CN=Yingluo Debug'])
  }
  return file
}

async function build(work) {
  if (!existsSync(join(ui, 'index.html'))) throw new Error('Mobile UI index.html is missing')
  const android = join(platform, 'android.jar')
  const java = join(javaBin, 'java' + exe)
  const assets = join(work, 'assets', 'web')
  const resources = join(work, 'res')
  const classes = join(work, 'classes')
  const dex = join(work, 'dex')
  const compiled = join(work, 'compiled.zip')
  const unaligned = join(work, 'unaligned.apk')
  const aligned = join(work, 'aligned.apk')
  const signed = join(work, 'signed.apk')

  copy(ui, assets)
  if (args.ui === undefined) {
    const pickerDist = join(appRoot, 'mobile', 'picker', 'dist')
    await buildMobilePicker(pickerDist)
    for (const file of ['model-picker.js', 'model-picker.css']) {
      copy(join(pickerDist, file), join(assets, 'assets', 'picker', file))
    }
  }
  const styleRoot = join(appRoot, 'packages', 'client', 'ui-theme', 'src', 'styles')
  copy(join(styleRoot, 'design-platform.css'), join(assets, 'assets', 'design-platform.css'))
  copy(join(appRoot, 'packages', 'client', 'ui-brand-official', 'src', 'client', 'assets', 'neko-avatar.webp'),
    join(assets, 'assets', 'avatar.webp'))
  for (const state of ['idle', 'waiting', 'running', 'failed', 'waving']) {
    copy(join(assetRoot, 'animations', state + '.png'), join(assets, 'assets', 'animations', state + '.png'))
  }
  const idleFrames = join(assetRoot, 'frames-hd', 'idle')
  const firstFrame = readdirSync(idleFrames).filter(name => name.endsWith('.png')).sort(collator.compare)[0]
  if (!firstFrame) throw new Error('No idle frame found for reduced motion')
  copy(join(idleFrames, firstFrame), join(assets, 'assets', 'animations', 'still.png'))
  copy(join(here, 'res'), resources)
  // ColorOS displays local resource frames in its native Live Update capsule.
  for (const state of ['running', 'waving']) {
    const frames = readdirSync(join(assetRoot, 'frames-hd', state)).filter(name => name.endsWith('.png')).sort(collator.compare)
    if (frames.length !== 8) throw new Error('Reply animation must contain eight frames: ' + state)
    frames.forEach((file, index) => {
      const name = `reply_${state}_${String(index + 1).padStart(2, '0')}`
      copy(join(assetRoot, 'frames-hd', state, file), join(resources, 'drawable-nodpi', name + '.png'))
    })
    mkdirSync(join(resources, 'drawable'), { recursive: true })
    writeFileSync(join(resources, 'drawable', `reply_${state}.xml`),
      `<animation-list xmlns:android="http://schemas.android.com/apk/res/android" android:oneshot="false">${frames.map((_, i) => `<item android:duration="125" android:drawable="@drawable/reply_${state}_${String(i + 1).padStart(2, '0')}" />`).join('')}</animation-list>`)
  }
  copy(join(appRoot, 'apps', 'web', 'public', 'icon-192.png'), join(resources, 'drawable-nodpi', 'yingluo.png'))

  mkdirSync(classes)
  mkdirSync(dex)
  run(join(javaBin, 'javac' + exe), ['-encoding', 'UTF-8', '--release', '8',
    '-classpath', android, '-d', classes, ...sourceFiles(join(here, 'src'))])
  run(java, ['-cp', join(tools, 'lib', 'd8.jar'), 'com.android.tools.r8.D8',
    '--min-api', minSdk, '--lib', android, '--output', dex,
    ...classFiles(classes)])
  run(join(tools, 'aapt2' + exe), ['compile', '--dir', resources, '-o', compiled])
  run(join(tools, 'aapt2' + exe), ['link', '-I', android, '--manifest',
    join(here, 'AndroidManifest.xml'), '--min-sdk-version', minSdk, '--target-sdk-version', targetSdk,
    '--version-code', '25', '--version-name', '0.8.9', '-o', unaligned, compiled])
  // The Windows aapt2 -A path gives nested assets backslashes in ZIP entry names.
  run(join(javaBin, 'jar' + exe), ['--update', '--file', unaligned, '--no-manifest',
    '-C', work, 'assets', '-C', dex, 'classes.dex'])
  run(join(tools, 'zipalign' + exe), ['-f', '4', unaligned, aligned])
  const signer = join(tools, 'lib', 'apksigner.jar')
  run(java, ['-jar', signer, 'sign', '--ks', debugKeystore(), '--ks-key-alias',
    'yingluo-debug', '--ks-pass', 'pass:android', '--key-pass', 'pass:android', '--out', signed, aligned])
  run(java, ['-jar', signer, 'verify', signed])
  copy(signed, output)
}

function classFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => {
      const file = join(directory, entry.name)
      if (entry.isDirectory()) return classFiles(file)
      return extname(file) === '.class' ? [file] : []
    })
}

const tempRoot = realpathSync(tmpdir())
const work = mkdtempSync(join(tempRoot, 'yingluo-android-'))
try {
  await build(work)
  console.log('APK: ' + output)
} finally {
  const target = realpathSync(work)
  if (dirname(target) === tempRoot && basename(target).startsWith('yingluo-android-')) {
    rmSync(target, { recursive: true, force: true })
  }
}
