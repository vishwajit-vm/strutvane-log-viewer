/**
 * `@strutvane/logs/provider`: the provider `strutvane.config.ts` registers in a Strutvane app.
 *
 * It connects logs to the app only through core (integration map: container tokens + hooks):
 * - binds `LoggerToken`, so every package logs through this logger;
 * - on `http.onRequest`, answers log-viewer requests (`/_strutvane/logs`) and notes the start
 *   time of every other request;
 * - on `http.onResponse`, writes one request-log line (method, path, status, duration). The path
 *   is the payload's `route` (the matched route template, e.g. `/api/v1/invoices/:id`) when the
 *   router knows it: a template carries no ids or tokens and groups requests per endpoint.
 *   Otherwise (no route matched, or an older framework) the raw path is logged through `safePath`
 *   (secrets redacted, token-like segments masked, length capped).
 *
 * Channels come from `config/logging.ts` (`default`, `channels`, `deprecations`, `path`; ADR-0022),
 * filled in from the `LOG_*` environment, plus `requests` and `viewer`. The provider also points
 * the `Log` facade at this app's channels. The
 * viewer follows the RFC-0004 access rules: open when `APP_ENV=local` (for loopback hosts only,
 * and, when the payload carries `clientAddress`, for a loopback peer only),
 * otherwise only with `LOGS_VIEWER_TOKEN`, and a 404 (not a 403) for everyone else, so its
 * existence isn't revealed. `viewer.authorize`, `viewer.ipAllowList`, `viewer.scopeRecords` and
 * `viewer.onAudit` are passed through, from `config/logging.ts` or from
 * {@link createLogsProvider}'s options (which win). The IP allow-list is checked against the
 * hook payload's `clientAddress` (the socket peer, never a forwarded header); without it, an
 * allow-list denies access.
 *
 * @module
 */
import {
  HTTP_HOOKS,
  type HttpRequestHookPayload,
  type HttpResponseHookPayload,
} from '@strutvane/contracts'
import {
  type Application,
  defineProvider,
  HooksToken,
  LoggerToken,
  type Provider,
} from '@strutvane/core'
import type { LoggingConfig } from './config.ts'
import { setLogManager } from './default.ts'
import { logCompletedRequest, pathOf, resolveRequestLogging, safePath } from './http/core.ts'
import { createLogManager, type LogManager } from './manager.ts'
import { createViewerHandler, type ViewerHandler, type ViewerOptions } from './viewer/handler.ts'

/** Viewer access settings that can't come from the environment (functions and lists). */
export type ViewerAccessOptions = Pick<
  ViewerOptions,
  'authorize' | 'ipAllowList' | 'scopeRecords' | 'onAudit'
>

/** `config/logging.ts`: the channels (see `LoggingConfig`) plus request logging and the viewer. */
export interface AppLoggingConfig extends LoggingConfig {
  readonly requests?: { readonly ignore?: readonly string[]; readonly slowThresholdMs?: number }
  readonly viewer?: {
    readonly enabled?: boolean
    readonly path?: string
    readonly token?: string
  } & ViewerAccessOptions
}

/** Options for {@link createLogsProvider}. */
export interface LogsProviderOptions {
  /** Viewer access rules; each one set here overrides the same key in `config/logging.ts`. */
  readonly viewer?: ViewerAccessOptions
}

const section = <T>(app: Application, name: string): T | undefined =>
  (app.settings as Readonly<Record<string, unknown>>)[name] as T | undefined

/**
 * Create the logs provider (a factory so every app and test gets fresh state).
 *
 * @example
 * createLogsProvider({ viewer: { authorize: (req) => isAdmin(req), ipAllowList: ['10.0.0.0/8'] } })
 */
export function createLogsProvider(options: LogsProviderOptions = {}): Provider {
  let logger: LogManager | undefined
  return defineProvider({
    name: '@strutvane/logs',
    register(app) {
      const cfg = section<AppLoggingConfig>(app, 'logging') ?? {}
      const root = section<{ root?: string }>(app, 'app')?.root ?? process.cwd()
      logger = createLogManager({ config: channelsOf(cfg), root })
      setLogManager(logger)
      app.container.value(LoggerToken, logger)
    },
    boot(app) {
      const cfg = section<AppLoggingConfig>(app, 'logging') ?? {}
      const active = logger
      if (!active) return
      const requests = resolveRequestLogging({
        logger: active,
        ...(cfg.requests?.ignore ? { ignore: cfg.requests.ignore } : {}),
        ...(cfg.requests?.slowThresholdMs !== undefined
          ? { slowThresholdMs: cfg.requests.slowThresholdMs }
          : {}),
      })
      let viewer: ViewerHandler | undefined
      if (cfg.viewer?.enabled !== false) {
        const dir = active.config.path
        // Every file channel writing into the viewer's directory.
        const bases = Object.values(active.config.channels).flatMap((c) =>
          (c.driver === 'single' || c.driver === 'daily') && c.dir === dir ? [c.base] : [],
        )
        const access: ViewerAccessOptions = {
          ...pickAccess(cfg.viewer ?? {}),
          ...pickAccess(options.viewer ?? {}),
        }
        viewer = createViewerHandler({
          dir,
          bases: bases.length > 0 ? [...new Set(bases)] : ['strutvane'],
          ...(cfg.viewer?.path ? { basePath: cfg.viewer.path } : {}),
          ...(cfg.viewer?.token ? { token: cfg.viewer.token } : {}),
          ...access,
        })
      }
      const started = new WeakMap<Request, number>()
      const hooks = app.make(HooksToken)
      hooks.on(
        HTTP_HOOKS.request,
        async (payload, control) => {
          const p = payload as HttpRequestHookPayload
          started.set(p.request, performance.now())
          if (!viewer?.matches(p.request)) return undefined
          control.stop()
          const info = p.clientAddress === undefined ? {} : { ip: p.clientAddress }
          const answered: HttpRequestHookPayload = {
            ...p,
            response: await viewer.fetch(p.request, info),
          }
          return answered
        },
        { name: 'logs.requests', before: ['auth.identity'] },
      )
      hooks.on(
        HTTP_HOOKS.response,
        (payload) => {
          const p = payload as HttpResponseHookPayload
          const begin = started.get(p.request)
          if (begin === undefined || viewer?.matches(p.request)) return undefined
          const path = pathOf(p.request.url)
          if (requests.ignore.has(path)) return undefined
          // A route template is safe as is (the router defines it, not the client); an empty
          // string is treated as unknown.
          const route = p.route ? p.route : safePath(path)
          logCompletedRequest(
            { ...requests, logger: active.child({ requestId: p.requestId }) },
            {
              method: p.request.method,
              route,
              status: p.status,
              durationMs: performance.now() - begin,
            },
          )
          return undefined
        },
        { name: 'logs.requests', failSoft: true },
      )
    },
    async shutdown() {
      await logger?.flush()
    },
  })
}

/** The channel part of `config/logging.ts` (request and viewer settings are the provider's). */
function channelsOf(cfg: AppLoggingConfig): LoggingConfig {
  return {
    ...(cfg.default === undefined ? {} : { default: cfg.default }),
    ...(cfg.channels === undefined ? {} : { channels: cfg.channels }),
    ...(cfg.deprecations === undefined ? {} : { deprecations: cfg.deprecations }),
    ...(cfg.path === undefined ? {} : { path: cfg.path }),
  }
}

/** Keep only the viewer access keys that are actually set. */
function pickAccess(source: ViewerAccessOptions): ViewerAccessOptions {
  return {
    ...(source.authorize ? { authorize: source.authorize } : {}),
    ...(source.ipAllowList ? { ipAllowList: source.ipAllowList } : {}),
    ...(source.scopeRecords ? { scopeRecords: source.scopeRecords } : {}),
    ...(source.onAudit ? { onAudit: source.onAudit } : {}),
  }
}

/** The logs provider for `strutvane.config.ts`. */
const provider: Provider = createLogsProvider()
export default provider
