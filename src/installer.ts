/**
 * `@strutvane/log-viewer/installer`: what `node strut add log-viewer` runs (declared as
 * `strutvane.installer` in package.json, blueprint §3.3). It installs the viewer completely, in one
 * transaction the framework's devkit previews (`--dry-run --diff`) and commits or rolls back:
 *
 * 1. `config/log-viewer.ts`: the viewer's settings (kept if it already exists: it is the app's).
 * 2. `config/index.ts`: lists it under the `logViewer` key, so `config('logViewer')` loads it.
 * 3. `.env` / `.env.example`: `LOG_VIEWER_ENABLED` and an empty `LOG_VIEWER_TOKEN` (an empty
 *    token keeps token access off: the viewer stays closed outside local development).
 * 4. `bootstrap/providers.ts`: registers `@strutvane/log-viewer/provider` (an older app with a
 *    `strutvane.config.ts` gets it through the framework's config patcher instead).
 *
 * Nothing here hard-codes another package, install order never changes the result, and running it
 * twice changes nothing the second time. A file that doesn't look like the skeleton's is never
 * guessed at: the installer prints the one line to add by hand instead. `uninstall` reverses steps
 * 2–4 and keeps `config/log-viewer.ts` (it may hold the developer's edits).
 *
 * @module
 */
import {
  type DevkitInstallContext,
  type DevkitInstaller,
  defineInstaller,
} from '@strutvane/framework/devkit'
import {
  addConfigKey,
  addProvider,
  CONFIG_LOCAL,
  CONFIG_SPECIFIER,
  PROVIDER_LOCAL,
  PROVIDER_SPECIFIER,
  removeConfigKey,
  removeProvider,
} from './install/patch.ts'

/** Where the installer writes and edits files, relative to the project root. */
export const INSTALL_PATHS = {
  config: 'config/log-viewer.ts',
  configIndex: 'config/index.ts',
  providers: 'bootstrap/providers.ts',
  legacyConfig: 'strutvane.config.ts',
} as const

/** The `.env` keys the installer adds. */
export const ENV_KEYS: readonly string[] = ['LOG_VIEWER_ENABLED', 'LOG_VIEWER_TOKEN']

/** The `config/log-viewer.ts` the installer writes. */
export const CONFIG_TEMPLATE = `// The log viewer (@strutvane/log-viewer): browse, search, tail and export the app's logs.
// Open it at /_strutvane/logs while \`node strut dev\` runs.
//
// It is closed by default. It opens on localhost while APP_ENV=local; anywhere else only with
// LOG_VIEWER_TOKEN, or for the users your gate allows. Bind the gate in
// app/providers/app.provider.ts:
//
//   import { LogViewerGateToken } from '@strutvane/log-viewer/provider'
//   app.container.value(LogViewerGateToken, {
//     authorize: (_request, { actor }) => actor?.roles.includes('admin') === true,
//   })
import { defineConfig } from '@strutvane/framework'

export default defineConfig((env) => ({
  /** Serve the viewer at all (it still stays closed until access is granted). */
  enabled: env.boolean('LOG_VIEWER_ENABLED', true),
  /** Where it lives. Letters, digits, /, _ and - only. */
  path: '/_strutvane/logs',
  /** A secret of at least 16 characters that opens it from anywhere; empty keeps token access off. */
  token: env.optional('LOG_VIEWER_TOKEN'),
  /** Only these client IPs or CIDR ranges may reach it, e.g. ['10.0.0.0/8']. Empty: no restriction. */
  ipAllowList: [] as string[],
}))
`

/** Read a project file, or `undefined` when it doesn't exist. */
async function readIfExists(ctx: DevkitInstallContext, path: string): Promise<string | undefined> {
  return (await ctx.fs.exists(path)) ? ctx.fs.read(path) : undefined
}

/** Step 2: list the config file in `config/index.ts`. */
async function registerConfig(ctx: DevkitInstallContext): Promise<void> {
  const source = await readIfExists(ctx, INSTALL_PATHS.configIndex)
  if (source === undefined) {
    ctx.log.warn(
      `${INSTALL_PATHS.configIndex} was not found, so the viewer uses its defaults. To use ${INSTALL_PATHS.config}, import it as ${CONFIG_LOCAL} from '${CONFIG_SPECIFIER}' and add ${CONFIG_LOCAL} to your config files.`,
    )
    return
  }
  const edited = addConfigKey(source)
  if (edited === undefined) {
    ctx.log.warn(
      `${INSTALL_PATHS.configIndex} has an unexpected shape, so it was not changed. Add these two lines yourself: import ${CONFIG_LOCAL} from '${CONFIG_SPECIFIER}', and ${CONFIG_LOCAL} in the exported object.`,
    )
    return
  }
  if (edited !== source) await ctx.fs.write(INSTALL_PATHS.configIndex, edited, { overwrite: true })
}

/** Step 4: register the provider. */
async function registerProvider(ctx: DevkitInstallContext): Promise<void> {
  const source = await readIfExists(ctx, INSTALL_PATHS.providers)
  if (source !== undefined) {
    const edited = addProvider(source)
    if (edited === undefined) {
      ctx.log.warn(
        `${INSTALL_PATHS.providers} has an unexpected shape, so it was not changed. Add the provider yourself: import ${PROVIDER_LOCAL} from '${PROVIDER_SPECIFIER}', and ${PROVIDER_LOCAL} in the providers array.`,
      )
      return
    }
    if (edited !== source) await ctx.fs.write(INSTALL_PATHS.providers, edited, { overwrite: true })
    return
  }
  if (await ctx.fs.exists(INSTALL_PATHS.legacyConfig)) {
    await ctx.config.registerProvider(PROVIDER_SPECIFIER)
    return
  }
  ctx.log.warn(
    `Neither ${INSTALL_PATHS.providers} nor ${INSTALL_PATHS.legacyConfig} was found. Register the provider yourself: import ${PROVIDER_LOCAL} from '${PROVIDER_SPECIFIER}' and add it to your providers.`,
  )
}

/** Undo step 4. */
async function unregisterProvider(ctx: DevkitInstallContext): Promise<void> {
  const source = await readIfExists(ctx, INSTALL_PATHS.providers)
  if (source !== undefined) {
    const edited = removeProvider(source)
    if (edited !== source) await ctx.fs.write(INSTALL_PATHS.providers, edited, { overwrite: true })
    return
  }
  if (await ctx.fs.exists(INSTALL_PATHS.legacyConfig))
    await ctx.config.unregisterProvider(PROVIDER_SPECIFIER)
}

/**
 * The installer, loaded by `node strut add log-viewer` / `node strut remove log-viewer`.
 *
 * @example
 * await runInstaller(installer, { projectRoot: '/srv/blog', dryRun: true })
 */
export const installer: DevkitInstaller = defineInstaller({
  name: 'log-viewer',
  description: 'The log viewer at /_strutvane/logs: browse, search, tail and export the app logs.',
  async install(ctx: DevkitInstallContext): Promise<void> {
    if (!(await ctx.fs.exists(INSTALL_PATHS.config)))
      await ctx.fs.write(INSTALL_PATHS.config, CONFIG_TEMPLATE)
    await registerConfig(ctx)
    await ctx.env.add('Log viewer (@strutvane/log-viewer)', [
      {
        key: 'LOG_VIEWER_ENABLED',
        value: 'true',
        comment:
          'Serve the log viewer at /_strutvane/logs (it stays closed until access is granted).',
      },
      {
        key: 'LOG_VIEWER_TOKEN',
        value: '',
        comment:
          'A secret of at least 16 characters that opens the viewer from anywhere. Empty: token access off.',
      },
    ])
    await registerProvider(ctx)
    ctx.log.info(
      'The log viewer is at /_strutvane/logs. It opens on localhost while APP_ENV=local; bind LogViewerGateToken to choose who else may open it.',
    )
  },
  async uninstall(ctx: DevkitInstallContext): Promise<void> {
    await unregisterProvider(ctx)
    const index = await readIfExists(ctx, INSTALL_PATHS.configIndex)
    if (index !== undefined) {
      const edited = removeConfigKey(index)
      if (edited !== index)
        await ctx.fs.write(INSTALL_PATHS.configIndex, edited, { overwrite: true })
    }
    await ctx.env.remove(ENV_KEYS)
    ctx.log.info(`${INSTALL_PATHS.config} was kept: delete it if you no longer need it.`)
  },
})

export default installer
