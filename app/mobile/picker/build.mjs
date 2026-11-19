import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))
const app = resolve(here, '..', '..')
const web = createRequire(join(app, 'apps', 'web', 'package.json'))
const packages = join(app, 'packages')
const httpModule = resolve(here, '../ui/http.js').replaceAll('\\', '/')

/** Build the shared ESM and CSS assets for Android and the browser companion. */
export async function buildMobilePicker(outDir = join(here, 'dist')) {
  const reactAliases = ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client']
    .map(id => ({ find: new RegExp('^' + id.replaceAll('/', '\\/') + '$'), replacement: web.resolve(id) }))
  await build({
    configFile: false,
    root: here,
    logLevel: 'warn',
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    resolve: { alias: [
      ...reactAliases,
      { find: /^@deepseek-ai\/cordis$/, replacement: join(app, 'vendor', 'cordis', 'src', 'index.ts') },
      { find: '@deepseek-ai/dsh-client-ui-primitives', replacement: join(here, 'primitives.ts') },
      { find: '@deepseek-ai/schemastery', replacement: join(app, 'vendor', 'schemastery', 'src', 'index.ts') },
      { find: '@deepseek-ai/dsh-util-text-search', replacement: join(packages, 'util', 'text-search', 'src', 'index.ts') },
    ] },
    oxc: { jsx: { runtime: 'automatic' } },
    build: {
      target: 'es2022',
      rollupOptions: {
        // The page owns the native response callback. Reuse its HTTP module from this bundle.
        external: id => id === '../ui/http.js' || id.replaceAll('\\', '/') === httpModule,
        output: { paths: () => '../../http.js', codeSplitting: false },
      },
      lib: {
        entry: join(here, 'model-picker.tsx'),
        formats: ['es'],
        fileName: () => 'model-picker.js',
        cssFileName: 'model-picker',
      },
      outDir,
      emptyOutDir: false,
    },
  })
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await buildMobilePicker()
}
