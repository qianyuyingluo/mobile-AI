import { useSyncExternalStore, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import Schema from '@deepseek-ai/schemastery'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '../../packages/client/store/src/index.ts'
import { SettingsSchemaService } from '../../packages/client/ui-settings/src/client/schema.ts'
import { ModelsSection } from '../../packages/client/ui-settings-models/src/client/ModelsSection.tsx'
import type { ModelsOperations } from '../../packages/client/ui-settings-models/src/client/operations.ts'
import { deriveKeyRef, type ModelsSettingsState } from '../../packages/client/ui-settings-models/src/client/store.ts'
import { zh } from '../../packages/client/ui-settings-models/src/client/locales.ts'
import { providerEndpoint, providerProtocol, providerProtocols } from '../ui/chat-providers.js'
import { requestJson } from '../ui/http.js'
import { SettingsSheet } from './settings-sheet.tsx'
import { closeTopModal } from '../../packages/client/ui-primitives/src/useModalLayer.ts'
import './model-settings.css'

type Provider = {
  id: string
  name: string
  endpoint: string
  protocol: string
  models: readonly { id: string; name: string }[]
}
type Profile = Record<string, unknown>
type Profiles = Record<string, Profile>
type Props = ComponentProps<typeof ModelsSection>
type Settings = {
  openMemory?: () => void
  read: () => { catalog: Provider[]; profiles: Profiles; keys: Record<string, string>; locked: boolean }
  writeProfiles: (profiles: Profiles) => boolean
  writeKey: (provider: string, value: string) => boolean
}

const namespaceId = 'llm-pi-ai'
const schema = SettingsSchemaService.prototype
const shape = Schema.object({ providers: Schema.dict(Schema.object({
  api: Schema.union(Object.keys(providerProtocols).map(id => Schema.const(id))),
  apiKeyEnv: Schema.string(),
  baseURL: Schema.string(),
  displayName: Schema.string(),
  models: Schema.array(Schema.object({ id: Schema.string(), name: Schema.string() })),
})) })
const serializedShape = shape.toJSON() as SettingsNamespaceView['schema']
const t = (key: keyof typeof zh) => zh[key]
const neverRender: Props['renderSlot'] = () => null
const empty: ModelsSettingsState = {
  status: 'ready', error: null, credentialError: null, writable: true, rows: [], namespaces: new Map(),
}

function inspectProfile(id: string, profile: Profile, preset: Provider | undefined): void {
  if (id === 'deepseek-account') throw new Error('请选择 API Key 提供商。')
  const api = typeof profile.api === 'string' ? profile.api : preset && providerProtocol(preset)
  const endpoint = typeof profile.baseURL === 'string' && profile.baseURL ? profile.baseURL : preset?.endpoint
  if (!api || !endpoint) throw new Error('请填写自定义接口地址与协议。')
  providerEndpoint(endpoint, api)
  if (!preset && (!Array.isArray(profile.models) || profile.models.length === 0)) {
    throw new Error('请为自定义提供商添加模型。')
  }
  if (Object.hasOwn(profile, 'apiKeyEnv') && profile.apiKeyEnv !== deriveKeyRef(id)) {
    throw new Error('API 密钥引用无效。')
  }
}

/** Mount the Harness Models section with device-local settings and secure credentials. */
export function mountModelSettings(element: HTMLElement, settings: Settings) {
  const root = createRoot(element)
  const state = createSnapshotStore(empty)
  let open = false
  let afterClose: (() => void) | undefined
  let revision = 0

  function namespace(): SettingsNamespaceView {
    const { catalog, profiles } = settings.read()
    const base = Object.fromEntries(catalog.map(preset => [preset.id, {
      displayName: preset.name, api: providerProtocol(preset), baseURL: preset.endpoint, models: preset.models,
    }]))
    const value = Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(profiles)])]
      .map(id => [id, { ...base[id], ...profiles[id] }]))
    // All data comes from the local serializable settings document.
    return {
      ns: namespaceId, schema: serializedShape, autoGenerate: false, applies: 'live',
      secrets: [], revision, base: { providers: base } as SettingsNamespaceView['base'],
      user: { providers: profiles } as SettingsNamespaceView['user'],
      value: { providers: value } as SettingsNamespaceView['value'],
    }
  }

  function update() {
    const { catalog, profiles, keys, locked } = settings.read()
    const view = namespace()
    const rows = [...new Set([...catalog.map(p => p.id), ...Object.keys(profiles)])]
      .filter(id => id !== 'deepseek-account')
      .map(id => {
        const preset = catalog.find(item => item.id === id)
        const profile = profiles[id]
        const configured = id === 'deepseek-official' || id === 'saved-provider' || !!profile || !!keys[id]
        const apiKeyEnv = deriveKeyRef(id)
        const credential = keys[id]
          ? { configured: true, writable: !locked, source: 'store', masked: '••••••••' }
          : { configured: false, writable: !locked }
        return {
          entry: {
            provider: id, displayName: typeof profile?.displayName === 'string' && profile.displayName || preset?.name || id,
            settingsNs: namespaceId, settingsPath: ['providers', id], active: configured,
            declared: !preset, defaultBaseURL: preset?.endpoint,
          },
          configured, removable: configured && id !== 'deepseek-official' && id !== 'saved-provider', apiKeyEnv, credential,
          credentialChecks: { [apiKeyEnv]: credential },
        }
      })
    state.set({ ...empty, writable: !locked, rows, namespaces: new Map([[namespaceId, view]]) })
  }

  const writeKey = async (ref: string, key: string) => {
    const { catalog, profiles, locked } = settings.read()
    const id = [...catalog.map(item => item.id), ...Object.keys(profiles)].find(item => deriveKeyRef(item) === ref)
    if (locked) return '请先等待当前回复结束。'
    // A deleted custom provider can have had its key removed on a first attempt.
    if (!id && !key) return undefined
    if (!id || !settings.writeKey(id, key)) return '无法保存 API 密钥。'
    update()
    return undefined
  }

  const operations: ModelsOperations = {
    storeCredential: writeKey,
    removeCredential: ref => writeKey(ref, ''),
    async writeSettings(ns, ops, expectedRevision) {
      const { catalog, profiles, locked } = settings.read()
      if (ns !== namespaceId || locked) return { kind: 'refused', message: '目前无法修改模型设置。' }
      if (expectedRevision !== undefined && expectedRevision !== revision) {
        return { kind: 'conflict', message: '设置已变更，请重新打开编辑器。' }
      }
      let draft: Record<string, unknown> = { providers: profiles }
      try {
        for (const operation of ops) {
          if (operation.path[0] !== 'providers' || operation.path.length < 2 ||
             operation.path.some(key => ['__proto__', 'constructor', 'prototype'].includes(key))) {
            throw new Error('提供商路径无效。')
          }
          draft = operation.op === 'set'
            ? schema.setPath(draft, operation.path, operation.value)
            : schema.deletePath(draft, operation.path)
        }
        const next = draft.providers as Profiles
        for (const [id, profile] of Object.entries(next)) {
          inspectProfile(id, profile, catalog.find(item => item.id === id))
          if ([...catalog.map(item => item.id), ...Object.keys(next)].some(other => other !== id && deriveKeyRef(other) === deriveKeyRef(id))) {
            throw new Error('提供商名称与已有密钥引用冲突。')
          }
        }
        if (!settings.writeProfiles(next)) throw new Error('无法保存模型设置。')
        revision++
        update()
        return { kind: 'written', view: namespace() }
      } catch (error) {
        return { kind: 'refused', message: error instanceof Error ? error.message : '无法保存模型设置。' }
      }
    },
    async discoverModels(_ns, request) {
      const preset = settings.read().catalog.find(item => item.id === request.provider)
      if (preset && (!request.baseURL || request.baseURL === preset.endpoint)) {
        return { kind: 'found', models: preset.models }
      }
      try {
        if (!request.baseURL || !request.api) throw new Error()
        const endpoint = new URL(providerEndpoint(request.baseURL, request.api))
        endpoint.pathname = endpoint.pathname.replace(/\/(?:chat\/completions|responses|messages)$/, '') + '/models'
        const key = request.apiKey
        const options = request.api === 'google-generative-ai'
          ? { headers: key ? { 'x-goog-api-key': key } : {} }
          : request.api === 'anthropic-messages'
            ? { headers: { 'anthropic-version': '2023-06-01', ...(key ? { 'x-api-key': key } : {}) } }
            : { token: key }
        const response = await requestJson(endpoint.href, options)
        const rows = response.data ?? response.models
        if (!Array.isArray(rows)) throw new Error()
        return { kind: 'found', models: rows.flatMap(row => {
          const id = row?.id ?? row?.name?.replace(/^models\//, '')
          return typeof id === 'string' && id ? [{ id, name: row.display_name ?? row.displayName ?? id }] : []
        }) }
      } catch {
        return { kind: 'refused', message: '无法获取模型列表，可以手动添加模型。' }
      }
    },
  }

  const controller = { store: state, load: async () => { update() } }
  const useSnapshot: NonNullable<Props['useSnapshot']> = selector =>
    selector(useSyncExternalStore(state.subscribe, state.getSnapshot))
  function render() {
    root.render(<SettingsSheet open={open} onClose={() => close()} onClosed={() => { const next = afterClose; afterClose = undefined; next?.() }}>
      {settings.openMemory && <button type="button" className="control" onClick={() => close(settings.openMemory)}>Chat 记忆</button>}
      <ModelsSection controller={controller} useSnapshot={useSnapshot} t={t}
        operations={operations} schema={schema} renderSlot={neverRender} />
    </SettingsSheet>)
  }
  function close(next?: () => void) { afterClose = next; open = false; render() }
  return {
    open() { afterClose = undefined; update(); open = true; render() },
    close,
    back() {
      if (!document.querySelector('.yingluo-model-settings')) return false
      closeTopModal(document)
      return true
    },
    update() { if (open) update() },
  }
}
