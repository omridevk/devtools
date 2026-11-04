import type { Plugin } from 'vite'
import type { DevToolsUserOptions } from '../plugin-options'
import { DEVTOOLS_MOUNT_PATH } from '@vitejs/devtools-kit/constants'
import { diagnostics } from '../diagnostics'

const VITE_CLIENT_ID_FILTER = /\/dist\/client\/client\.mjs(?:\?.*)?$/

/**
 * Loads the `@devframes/hub-ui` embedded bootstrap (`<base>embedded.js`) at
 * runtime by appending a module `<script>`. A static root-relative module
 * `src` would make Vite try to pre-transform `<base>embedded.js` through its
 * own module pipeline, which breaks the client's `import.meta.url`-relative
 * asset fetches, so the element is always created at runtime.
 */
function createBootstrapCode(src: string, base: 'document' | 'module'): string {
  const url = base === 'module'
    ? `new URL(${JSON.stringify(src)}, import.meta.url).href`
    : JSON.stringify(src)
  return `{ const s = document.createElement('script'); s.type = 'module'; s.src = ${url}; document.head.appendChild(s); }`
}

/**
 * Inject the dock into the host page.
 *
 * Dev: the bootstrap is appended to Vite's own HMR client (`/@vite/client`)
 * in environments whose `consumer` is `'client'`. Every page Vite serves in
 * dev loads that module exactly once, whoever renders the HTML: `index.html`
 * (Vite injects it), SSR frameworks (pulled in by import analysis or emitted
 * by the framework), RSC setups, backend integrations. No framework knowledge
 * and no HTML hook is needed, and the browser evaluates the module once per
 * document, so the dock is injected once.
 *
 * Build (`build.injection`) and bundled dev (`experimental.bundledDev`), where
 * the HMR client is not a separate module: fall back to `transformIndexHtml`.
 */
export function DevToolsInjection(build?: DevToolsUserOptions['build']): Plugin {
  let src = `${DEVTOOLS_MOUNT_PATH}embedded.js`
  let injectIntoHtml = false

  return {
    name: 'vite:devtools:injection',
    enforce: 'post',
    apply(_config, env) {
      return !env.isSsrBuild && (env.command === 'serve' || build?.injection === true)
    },
    configResolved(config) {
      if (config.command === 'build') {
        if (!build?.withApp)
          throw diagnostics.DTK0035({})
        src = `${config.base.replace(/\/+$/, '')}${DEVTOOLS_MOUNT_PATH}embedded.js`
      }
      injectIntoHtml = config.command === 'build' || !!config.experimental?.bundledDev
    },
    transform: {
      filter: { id: VITE_CLIENT_ID_FILTER },
      async handler(code, id) {
        if (injectIntoHtml || this.environment.config.consumer !== 'client')
          return
        const viteClient = await this.resolve('/@vite/client')
        if (!viteClient || viteClient.id !== id.split('?')[0])
          return
        return { code: `${code}\n${createBootstrapCode(src, 'module')}\n`, map: null }
      },
    },
    transformIndexHtml: {
      order: 'pre',
      handler() {
        if (!injectIntoHtml)
          return
        return [
          {
            tag: 'script',
            attrs: { type: 'module' },
            children: createBootstrapCode(src, 'document'),
            injectTo: 'body',
          },
        ]
      },
    },
  }
}
