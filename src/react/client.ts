/**
 * A small, framework-free client for the viewer's read API (the routes of `createViewerHandler`).
 * The React screen uses it; any other front end can too.
 *
 * Safety:
 * - **The base path is validated** (letters, digits, `/`, `_`, `-`), so a link built from it can
 *   never become `javascript:` or point at another origin.
 * - **Every parameter is URL-encoded** through `URLSearchParams`.
 * - **Requests are same-origin with cookies** (`credentials: 'same-origin'`), so the viewer's
 *   session cookie and the app's own session work, and nothing is sent cross-site.
 * - **Errors are typed:** a non-2xx answer becomes a {@link LogViewerApiError} carrying the
 *   problem's `code` and `detail` (RFC 9457), never a raw body.
 *
 * @module
 */
import type { ViewerRecord } from '../viewer/filters.ts'

/** One log file as `/api/files` lists it (scoped viewers only see `day`). */
export interface LogFileEntry {
  readonly name?: string
  readonly day: string
  readonly size?: number
  readonly modified?: string
}

/** The answer of `/api/files`. */
export interface LogFilesResponse {
  readonly files: readonly LogFileEntry[]
  /** Channel names usable as the `channel` filter. */
  readonly channels: readonly string[]
  /** `true` when the viewer only shows the caller's own records (e.g. one tenant). */
  readonly scoped?: boolean
}

/** One page of `/api/records`, newest first. */
export interface LogRecordsPage {
  readonly records: readonly ViewerRecord[]
  /** Present when older records may follow. */
  readonly nextCursor?: string
  readonly scanned: number
}

/** The search filters. Every one is optional; none means "everything". */
export interface LogQuery {
  /** Levels to show (aliases `warn`, `fatal`, `trace` are accepted by the server). */
  readonly levels?: readonly string[]
  /** One channel of `config/logging.ts`. */
  readonly channel?: string
  /** Free text, matched case-insensitively against the whole record. */
  readonly q?: string
  /** ISO 8601 date or date-time. */
  readonly from?: string
  /** ISO 8601 date or date-time. */
  readonly to?: string
  readonly requestId?: string
  readonly route?: string
  /** A status code (`404`) or class (`5xx`). */
  readonly status?: string
}

/** A failed API call, with the problem the server answered. */
export class LogViewerApiError extends Error {
  override readonly name = 'LogViewerApiError'
  /** HTTP status (0 when the request never got an answer). */
  readonly status: number
  /** The problem's stable code, e.g. `invalid_query` (`network_error` without an answer). */
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** Options for {@link createLogViewerClient}. */
export interface LogViewerClientOptions {
  /** Where the viewer is mounted. Default: `/_strutvane/logs`. */
  readonly basePath?: string
  /** The fetch to use (tests, or a fetch with extra headers). Default: the global `fetch`. */
  readonly fetch?: typeof fetch
}

/** The client. */
export interface LogViewerClient {
  readonly basePath: string
  files(channel?: string): Promise<LogFilesResponse>
  records(
    query: LogQuery,
    options?: { readonly limit?: number; readonly cursor?: string },
  ): Promise<LogRecordsPage>
  /** A same-origin download link for one day (`ndjson` or `csv`). */
  downloadUrl(day: string, format: 'ndjson' | 'csv', channel?: string): string
  /** The live tail URL (Server-Sent Events) for a query. */
  tailUrl(query: LogQuery): string
}

const BASE_PATH = /^\/[A-Za-z0-9/_-]*$/

/** The largest page the server accepts. */
export const MAX_PAGE_SIZE = 500

/**
 * Turn a query into URL parameters, the way the server parses them.
 *
 * @example
 * queryParams({ levels: ['error'], q: 'timeout' }).toString() // 'level=error&q=timeout'
 */
export function queryParams(query: LogQuery): URLSearchParams {
  const params = new URLSearchParams()
  if (query.levels && query.levels.length > 0) params.set('level', query.levels.join(','))
  for (const key of ['channel', 'q', 'from', 'to', 'requestId', 'route', 'status'] as const) {
    const value = query[key]?.trim()
    if (value) params.set(key, value)
  }
  return params
}

/**
 * Create a client for the viewer's read API.
 *
 * @throws TypeError when `basePath` isn't a plain URL path
 *
 * @example
 * const client = createLogViewerClient()
 * const page = await client.records({ levels: ['error', 'critical'] })
 */
export function createLogViewerClient(options: LogViewerClientOptions = {}): LogViewerClient {
  const basePath = (options.basePath ?? '/_strutvane/logs').replace(/\/+$/, '')
  if (!BASE_PATH.test(basePath) || basePath.includes('//'))
    throw new TypeError(
      `log viewer basePath "${basePath}" is invalid: use a path like /_strutvane/logs`,
    )
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init))

  const get = async <T>(path: string, params: URLSearchParams): Promise<T> => {
    const query = params.toString()
    let response: Response
    try {
      response = await doFetch(`${basePath}/api/${path}${query ? `?${query}` : ''}`, {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      })
    } catch {
      throw new LogViewerApiError(0, 'network_error', 'The log viewer could not be reached.')
    }
    let body: unknown
    try {
      body = await response.json()
    } catch {
      body = undefined
    }
    if (!response.ok) {
      const problem = typeof body === 'object' && body !== null ? body : {}
      const code = Reflect.get(problem, 'code')
      const detail = Reflect.get(problem, 'detail')
      const title = Reflect.get(problem, 'title')
      throw new LogViewerApiError(
        response.status,
        typeof code === 'string' ? code : `http_${response.status}`,
        typeof detail === 'string'
          ? detail
          : typeof title === 'string'
            ? title
            : `The log viewer answered ${response.status}.`,
      )
    }
    return body as T
  }

  return {
    basePath,
    async files(channel) {
      const params = new URLSearchParams()
      if (channel) params.set('channel', channel)
      const body = await get<Partial<LogFilesResponse>>('files', params)
      return {
        files: Array.isArray(body.files) ? body.files : [],
        channels: Array.isArray(body.channels) ? body.channels : [],
        ...(body.scoped === true ? { scoped: true } : {}),
      }
    },
    async records(query, page = {}) {
      const params = queryParams(query)
      const limit = Math.min(Math.max(Math.trunc(page.limit ?? 100), 1), MAX_PAGE_SIZE)
      params.set('limit', String(limit))
      if (page.cursor) params.set('cursor', page.cursor)
      const body = await get<Partial<LogRecordsPage>>('records', params)
      return {
        records: Array.isArray(body.records) ? body.records : [],
        scanned: typeof body.scanned === 'number' ? body.scanned : 0,
        ...(typeof body.nextCursor === 'string' ? { nextCursor: body.nextCursor } : {}),
      }
    },
    downloadUrl(day, format, channel) {
      const params = new URLSearchParams({ day, format })
      if (channel) params.set('channel', channel)
      return `${basePath}/api/download?${params.toString()}`
    },
    tailUrl(query) {
      const params = queryParams(query).toString()
      return `${basePath}/api/tail${params ? `?${params}` : ''}`
    },
  }
}
