import type { Plugin } from 'vite'
import { DEVTOOLS_MOUNT_PATH } from '@vitejs/devtools-kit/constants'
import { describe, expect, it } from 'vitest'
import { DevToolsInjection } from '../injection'

const viteClientId = '/project/node_modules/vite/dist/client/client.mjs'

interface TransformHook {
  filter: { id: RegExp }
  handler: (this: unknown, code: string, id: string) => Promise<{ code: string } | undefined>
}

function configure(plugin: Plugin, config: Record<string, unknown>) {
  const hook = plugin.configResolved as (config: unknown) => void
  hook({ base: '/', experimental: {}, ...config })
  return plugin
}

function htmlTags(plugin: Plugin) {
  const transform = plugin.transformIndexHtml as { handler: () => unknown }
  return transform.handler() as Array<{ tag: string, attrs: Record<string, string>, children?: string, injectTo: string }> | undefined
}

function transformAs(plugin: Plugin, consumer: 'client' | 'server', id: string) {
  const transform = plugin.transform as unknown as TransformHook
  if (!transform.filter.id.test(id))
    return Promise.resolve(undefined)
  const context = {
    environment: { config: { consumer } },
    resolve: async (specifier: string) => specifier === '/@vite/client' ? { id: viteClientId } : null,
  }
  return transform.handler.call(context, '/* vite client */', id)
}

describe('devToolsInjection in dev', () => {
  it('appends the embedded bootstrap to the Vite client of a client environment', async () => {
    const plugin = configure(DevToolsInjection(), { command: 'serve' })
    const result = await transformAs(plugin, 'client', viteClientId)
    expect(result?.code).toContain('/* vite client */')
    expect(result?.code).toContain(`new URL(${JSON.stringify(`${DEVTOOLS_MOUNT_PATH}embedded.js`)}, import.meta.url)`)
    expect(result?.code).toContain('document.head.appendChild(s)')
  })

  it('leaves server environments (ssr, rsc) untouched', async () => {
    const plugin = configure(DevToolsInjection(), { command: 'serve' })
    expect(await transformAs(plugin, 'server', viteClientId)).toBeUndefined()
  })

  it('leaves other modules named client.mjs untouched', async () => {
    const plugin = configure(DevToolsInjection(), { command: 'serve' })
    expect(await transformAs(plugin, 'client', '/project/node_modules/other/dist/client/client.mjs')).toBeUndefined()
  })

  it('does not also inject into index.html, so an SPA gets the dock once', () => {
    const plugin = configure(DevToolsInjection(), { command: 'serve' })
    expect(htmlTags(plugin)).toBeUndefined()
  })

  it('falls back to index.html in bundled dev mode', async () => {
    const plugin = configure(DevToolsInjection(), { command: 'serve', experimental: { bundledDev: true } })
    expect(await transformAs(plugin, 'client', viteClientId)).toBeUndefined()
    expect(htmlTags(plugin)?.[0]?.children).toContain(`${DEVTOOLS_MOUNT_PATH}embedded.js`)
  })
})

describe('devToolsInjection in build', () => {
  it('injects an inline module that loads the embedded bootstrap from the app base', () => {
    const plugin = configure(DevToolsInjection({ withApp: true, injection: true }), { command: 'build', base: '/app/' })
    const tag = htmlTags(plugin)?.[0]
    expect(tag?.tag).toBe('script')
    expect(tag?.attrs).toEqual({ type: 'module' })
    expect(tag?.injectTo).toBe('body')
    expect(tag?.children).toContain(JSON.stringify(`/app${DEVTOOLS_MOUNT_PATH}embedded.js`))
  })
})
