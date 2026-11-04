import type { InlineConfig, Plugin, ViteDevServer } from 'vite'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEVTOOLS_MOUNT_PATH } from '@vitejs/devtools-kit/constants'
import { createServer, resolveConfig } from 'vite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DevToolsInjection } from '../injection'

const HTML_PLUGIN = 'vite:devtools:injection'
const VITE_CLIENT_PLUGIN = 'vite:devtools:injection-client'

function injectedTags(plugin: Plugin) {
  const transform = plugin.transformIndexHtml as { handler: () => unknown }
  return transform.handler() as Array<{ tag: string, attrs: Record<string, string>, children?: string, injectTo: string }>
}

function count(code: string, search: string) {
  return code.split(search).length - 1
}

describe('devToolsInjection', () => {
  let root: string
  let server: ViteDevServer | undefined

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'devtools-injection-')))
  })

  afterEach(async () => {
    await server?.close()
    server = undefined
    await rm(root, { recursive: true, force: true })
  })

  async function startDevServer(config: InlineConfig = {}) {
    server = await createServer({
      configFile: false,
      root,
      logLevel: 'silent',
      devtools: false,
      server: { middlewareMode: true, ws: false },
      plugins: [DevToolsInjection()],
      ...config,
    })
    return server
  }

  async function resolvePlugins(config: InlineConfig, command: 'build' | 'serve') {
    const resolved = await resolveConfig({ configFile: false, root, logLevel: 'silent', devtools: false, ...config }, command)
    const plugins = resolved.plugins.filter(plugin => plugin.name.startsWith('vite:devtools:injection'))
    return { resolved, plugins }
  }

  it('appends the bootstrap to the Vite client in dev, relative to its own URL', async () => {
    const devServer = await startDevServer()
    const result = await devServer.environments.client.transformRequest('/@vite/client')

    expect(count(result!.code, 'embedded.js')).toBe(1)
    expect(result!.code).toContain(`s.src = new URL(${JSON.stringify(`${DEVTOOLS_MOUNT_PATH}embedded.js`)}, import.meta.url);`)
    expect(result!.code).toContain('document.body.appendChild(s);')
  })

  it('does not inject into the HTML in dev', async () => {
    const devServer = await startDevServer()
    const html = await devServer.transformIndexHtml('/', '<html><head></head><body></body></html>')

    expect(html).not.toContain('embedded.js')
  })

  it('only applies to environments whose consumer is the browser', async () => {
    const devServer = await startDevServer({ environments: { rsc: { consumer: 'server' } } })
    const names = (name: string) => devServer.environments[name]!.plugins.map(plugin => plugin.name)

    expect(names('client')).toContain(VITE_CLIENT_PLUGIN)
    expect(names('ssr')).not.toContain(VITE_CLIENT_PLUGIN)
    expect(names('rsc')).not.toContain(VITE_CLIENT_PLUGIN)
  })

  it('leaves other `client.mjs` modules untouched', async () => {
    await writeFile(join(root, 'client.mjs'), 'export const value = 1\n')
    const devServer = await startDevServer()
    const result = await devServer.environments.client.transformRequest('/client.mjs')

    expect(result!.code).not.toContain('embedded.js')
  })

  it('injects an inline module into the HTML for build with injection, under the base', async () => {
    const { plugins } = await resolvePlugins({
      base: '/app/',
      plugins: [DevToolsInjection({ withApp: true, injection: true })],
    }, 'build')

    expect(plugins.map(plugin => plugin.name)).toEqual([HTML_PLUGIN])
    // Inline module (no static `src`) so Vite never pre-transforms the
    // hub-served `<base>embedded.js` through its own module pipeline.
    expect(injectedTags(plugins[0]!)).toEqual([
      {
        tag: 'script',
        attrs: { type: 'module' },
        children: `const s = document.createElement('script'); s.type = 'module'; s.src = "/app${DEVTOOLS_MOUNT_PATH}embedded.js"; document.body.appendChild(s);`,
        injectTo: 'body',
      },
    ])
  })

  it('injects into the HTML under bundled dev, where the Vite client is not a separate module', async () => {
    const { resolved, plugins } = await resolvePlugins({
      experimental: { bundledDev: true },
      plugins: [DevToolsInjection()],
    }, 'serve')
    const [viteClientPlugin, htmlPlugin] = plugins

    expect(plugins.map(plugin => plugin.name)).toEqual([VITE_CLIENT_PLUGIN, HTML_PLUGIN])
    expect(injectedTags(htmlPlugin!)[0]!.children).toContain(`s.src = "${DEVTOOLS_MOUNT_PATH}embedded.js"`)
    expect(viteClientPlugin!.applyToEnvironment!({ config: resolved.environments.client } as never)).toBe(false)
  })
})
