import type { Plugin } from 'vite'
import type { DevToolsUserOptions } from '../plugin-options'
import { DEVTOOLS_MOUNT_PATH } from '@vitejs/devtools-kit/constants'
import { diagnostics } from '../diagnostics'

function createBootstrapCode(src: string): string {
  return `const s = document.createElement('script'); s.type = 'module'; s.src = ${src}; document.body.appendChild(s);`
}

/**
 * Inject the `@devframes/hub-ui` embedded bootstrap into the host app's HTML.
 * The hub serves the prebuilt, self-contained module at `<base>embedded.js`
 * (the `ui.embedded` slot); the client bundles its own framework and styles
 * and reads its reveal policy and dock preferences from the connection meta
 * (`ConnectionMeta.configs.ui`, seeded by `createUi`), so the host app's build
 * never processes it.
 *
 * The bootstrap is loaded by an **inline** module that creates the `<script>`
 * element at runtime, rather than a static `<script type="module" src=…>`.
 * A static root-relative module `src` makes Vite try to pre-transform
 * `<base>embedded.js` through its own module pipeline — it isn't a project
 * file, so Vite logs a load error and (depending on version) can shadow the
 * hub-served module, which breaks the client's `import.meta.url`-relative
 * `branding.json` fetch (the dock then falls back to the default accent
 * instead of the Vite DevTools brand color). Injecting the element at runtime
 * keeps `<base>embedded.js` out of Vite's graph entirely, so the browser
 * fetches it straight from the hub with its real URL intact.
 */
export function DevToolsInjection(build?: DevToolsUserOptions['build']): Plugin[] {
  let src = `${DEVTOOLS_MOUNT_PATH}embedded.js`

  const htmlPlugin: Plugin = {
    name: 'vite:devtools:injection',
    enforce: 'post',
    apply(config, env) {
      return !env.isSsrBuild && (env.command === 'build' ? build?.injection === true : !!config.experimental?.bundledDev)
    },
    configResolved(config) {
      if (config.command === 'build') {
        if (!build?.withApp)
          throw diagnostics.DTK0035({})
        src = `${config.base.replace(/\/+$/, '')}${DEVTOOLS_MOUNT_PATH}embedded.js`
      }
    },
    transformIndexHtml: {
      order: 'pre',
      handler() {
        return [
          {
            tag: 'script',
            attrs: { type: 'module' },
            children: createBootstrapCode(JSON.stringify(src)),
            injectTo: 'body',
          },
        ]
      },
    },
  }

  // Dev without bundling: every page loads Vite's HMR client once, whoever
  // renders the HTML (SPA, SSR, RSC), so the bootstrap rides on that module.
  const viteClientPlugin: Plugin = {
    name: 'vite:devtools:injection-client',
    apply: 'serve',
    applyToEnvironment(environment) {
      return environment.config.consumer === 'client' && !environment.config.isBundled
    },
    transform: {
      filter: { id: /\/client\.mjs(?:\?|$)/ },
      async handler(code, id) {
        const viteClient = await this.resolve('/@vite/client')
        if (!viteClient || viteClient.id !== id.replace(/[?#].*$/, ''))
          return
        return `${code}\n{ ${createBootstrapCode(`new URL(${JSON.stringify(src)}, import.meta.url)`)} }\n`
      },
    },
  }

  return [htmlPlugin, viteClientPlugin]
}
