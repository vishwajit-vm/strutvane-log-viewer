/**
 * `@strutvane/log-viewer/provider`: the provider an app lists in `bootstrap/providers.ts` (the
 * installer adds it). It mounts the viewer at `/_strutvane/logs` on top of the framework's own
 * logging (ADR-0022): the files it shows are the ones `@strutvane/framework/log` writes.
 *
 * It connects to the app only through the framework's public seams (integration map: container
 * tokens and hooks), never through the framework's internals:
 * - **`LogManagerToken`** gives the log directory and the file channels writing into it (their
 *   names become the viewer's channel filter). Without a log manager the viewer reads `LOG_PATH`
 *   (default `storage/logs`).
 * - **`http.onRequest`** (handler `logViewer.serve`, after `auth.identity`): requests under the
 *   viewer path are answered by the viewer, with the actor `@strutvane/auth` resolved, so the app's
 *   gate can decide by user and role. Every other request passes through untouched.
 *
 * **Access is closed by default** (see `viewer/access.ts`): open on loopback while
 * `APP_ENV=local`, otherwise only with `LOG_VIEWER_TOKEN` or the gate the app grants, and a 404 for
 * everyone else, so the viewer's existence isn't revealed. The gate is bound in the app's own
 * service provider:
 *
 * ```ts
 * import { LogViewerGateToken } from '@strutvane/log-viewer/provider'
 * app.container.value(LogViewerGateToken, {
 *   authorize: (_request, { actor }) => actor?.roles.includes('admin') === true,
 * })
 * ```
 *
 * Settings come from `config/log-viewer.ts` (key `logViewer` in `config/index.ts`; the installer
 * writes both): `enabled`, `path`, `token` and `ipAllowList`. Code-only rules (`authorize`,
 * `scopeRecords`, `onAudit`) come from the gate token or {@link createLogViewerProvider}'s options,
 * because a config file may be cached as JSON (`config:cache`), which can't hold functions.
 *
 * Failure scenarios:
 * - **No `config/log-viewer.ts`:** the defaults (enabled, `/_strutvane/logs`, the token from
 *   `LOG_VIEWER_TOKEN`).
 * - **An invalid setting** (a `path` with odd characters, a short token, a bad IP range): the boot
 *   fails naming the setting, because a typo must never silently open (or close) the viewer.
 * - **A gate that throws:** the request gets a 404 (fail closed).
 *
 * @module
 */
import { HTTP_HOOKS, type HttpRequestHookPayload } from '@strutvane/framework/contracts'
import {
  type Application,
  defineProvider,
  HooksToken,
  type Provider,
  type Token,
  token,
} from '@strutvane/framework/core'
import { type Env, LogManagerToken } from '@strutvane/framework/log'
import { createViewerHandler, type ViewerOptions } from './viewer/handler.ts'

/** The viewer's access rules that only code can express (functions), plus the IP allow-list. */
export type ViewerAccessOptions = Pick<
  ViewerOptions,
  'authorize' | 'ipAllowList' | 'scopeRecords' | 'onAudit'
>

/**
 * The gate the app grants: bind it in your service provider to decide who may open the viewer.
 *
 * @example
 * app.container.value(LogViewerGateToken, {
 *   authorize: (_request, { actor }) => actor?.roles.includes('admin') === true,
 * })
 */
export const LogViewerGateToken: Token<ViewerAccessOptions> = token<ViewerAccessOptions>(
  'strutvane.log-viewer.gate',
)

/**
 * `config/log-viewer.ts`: the viewer's data-only settings.
 *
 * @example
 * export default defineConfig((env) => ({
 *   enabled: env.boolean('LOG_VIEWER_ENABLED', true),
 *   path: '/_strutvane/logs',
 *   token: env.optional('LOG_VIEWER_TOKEN'),
 * }))
 */
export interface LogViewerConfig {
  /** Serve the viewer at all. Default: `true` (still closed until access is granted). */
  readonly enabled?: boolean
  /** URL prefix. Default: `/_strutvane/logs`. */
  readonly path?: string
  /** Viewer token (at least 16 characters). Default: `LOG_VIEWER_TOKEN`. */
  readonly token?: string
  /** Client IPs or CIDR ranges allowed to reach the viewer. Default: no IP restriction. */
  readonly ipAllowList?: readonly string[]
}

/** Options for {@link createLogViewerProvider}. */
export interface LogViewerProviderOptions {
  /** Access rules; each one set here overrides the same rule bound with {@link LogViewerGateToken}. */
  readonly viewer?: ViewerAccessOptions
  /** Environment to read (`APP_ENV`, `LOG_PATH`, `LOG_VIEWER_TOKEN`). Default: `process.env`. */
  readonly env?: Env
}

/** The config key the installer registers `config/log-viewer.ts` under. */
export const CONFIG_KEY = 'logViewer'

/** Name of the `http.onRequest` handler, for other packages' ordering hints. */
export const HOOK_NAME = 'logViewer.serve'

/**
 * Create the log viewer provider (a factory, so every app and test gets fresh state).
 *
 * @example
 * // bootstrap/providers.ts
 * import { createLogViewerProvider } from '@strutvane/log-viewer/provider'
 * export default [AppServiceProvider, createLogViewerProvider({ viewer: { ipAllowList: ['10.0.0.0/8'] } })]
 */
export function createLogViewerProvider(options: LogViewerProviderOptions = {}): Provider {
  return defineProvider({
    name: '@strutvane/log-viewer',
    register() {
      // Nothing to bind: the gate token is the app's to bind, and an unbound one means "no gate".
    },
    boot(app) {
      const cfg = readConfig(app)
      if (cfg.enabled === false) return
      const env = options.env ?? process.env
      const manager = app.container.has(LogManagerToken) ? app.make(LogManagerToken) : undefined
      const gate = app.container.has(LogViewerGateToken) ? app.make(LogViewerGateToken) : {}
      const access: ViewerAccessOptions = {
        ...pickAccess(cfg.ipAllowList ? { ipAllowList: cfg.ipAllowList } : {}),
        ...pickAccess(gate),
        ...pickAccess(options.viewer ?? {}),
      }
      const appEnv = manager?.config.env ?? env['APP_ENV']
      const files = manager === undefined ? undefined : fileChannels(manager.config)
      const viewer = createViewerHandler({
        ...(files === undefined
          ? {}
          : { dir: files.dir, bases: files.bases, channels: files.channels }),
        ...(cfg.path === undefined ? {} : { basePath: cfg.path }),
        ...(cfg.token === undefined || cfg.token === '' ? {} : { token: cfg.token }),
        env: appEnv === undefined ? env : { ...env, APP_ENV: appEnv },
        ...access,
      })
      app.make(HooksToken).on(
        HTTP_HOOKS.request,
        async (payload, control) => {
          const p = payload as HttpRequestHookPayload
          if (!viewer.matches(p.request)) return undefined
          control.stop()
          const answered: HttpRequestHookPayload = {
            ...p,
            response: await viewer.fetch(p.request, {
              actor: p.actor,
              ...(p.clientAddress === undefined ? {} : { ip: p.clientAddress }),
            }),
          }
          return answered
        },
        { name: HOOK_NAME, after: ['auth.identity'] },
      )
    },
  })
}

/** What the provider needs from the resolved `config/logging`. */
interface LoggingFacts {
  readonly path: string
  readonly channels: Readonly<
    Record<string, { readonly driver: string; readonly dir?: string; readonly base?: string }>
  >
}

/** The file channels writing into the default log directory, as the viewer's bases and channels. */
export function fileChannels(config: LoggingFacts): {
  readonly dir: string
  readonly bases: readonly string[]
  readonly channels: Readonly<Record<string, string>>
} {
  const channels: Record<string, string> = {}
  for (const [name, channel] of Object.entries(config.channels)) {
    if (
      (channel.driver === 'single' || channel.driver === 'daily') &&
      channel.dir === config.path &&
      channel.base !== undefined
    )
      channels[name] = channel.base
  }
  const bases = [...new Set(Object.values(channels))]
  return bases.length > 0
    ? { dir: config.path, bases, channels }
    : { dir: config.path, bases: ['strutvane'], channels: {} }
}

/**
 * Read and check `config('logViewer')`. Absent is fine (the defaults); a value of the wrong type is
 * a boot error naming the setting.
 *
 * @example
 * readConfig({ settings: { logViewer: { enabled: false } } }) // { enabled: false }
 */
export function readConfig(app: Pick<Application, 'settings'>): LogViewerConfig {
  const value: unknown = Reflect.get(app.settings, CONFIG_KEY)
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value))
    throw new TypeError(
      'config/log-viewer.ts must export an object of settings (enabled, path, token, ipAllowList)',
    )
  const read = (key: string): unknown => Reflect.get(value, key)
  const enabled = read('enabled')
  const path = read('path')
  const tokenValue = read('token')
  const ipAllowList = read('ipAllowList')
  if (enabled !== undefined && typeof enabled !== 'boolean')
    throw new TypeError('config/log-viewer.ts: enabled must be true or false')
  if (path !== undefined && typeof path !== 'string')
    throw new TypeError('config/log-viewer.ts: path must be a URL path like /_strutvane/logs')
  if (tokenValue !== undefined && tokenValue !== null && typeof tokenValue !== 'string')
    throw new TypeError('config/log-viewer.ts: token must be a string (LOG_VIEWER_TOKEN)')
  if (
    ipAllowList !== undefined &&
    (!Array.isArray(ipAllowList) || ipAllowList.some((entry) => typeof entry !== 'string'))
  )
    throw new TypeError('config/log-viewer.ts: ipAllowList must be a list of IPs or CIDR ranges')
  return {
    ...(enabled === undefined ? {} : { enabled }),
    ...(path === undefined ? {} : { path }),
    ...(typeof tokenValue === 'string' ? { token: tokenValue } : {}),
    ...(ipAllowList === undefined ? {} : { ipAllowList: ipAllowList as readonly string[] }),
  }
}

/** Keep only the access keys that are actually set. */
function pickAccess(source: ViewerAccessOptions): ViewerAccessOptions {
  return {
    ...(source.authorize ? { authorize: source.authorize } : {}),
    ...(source.ipAllowList ? { ipAllowList: source.ipAllowList } : {}),
    ...(source.scopeRecords ? { scopeRecords: source.scopeRecords } : {}),
    ...(source.onAudit ? { onAudit: source.onAudit } : {}),
  }
}

/** The log viewer provider for `bootstrap/providers.ts`. */
const provider: Provider = createLogViewerProvider()
export default provider
