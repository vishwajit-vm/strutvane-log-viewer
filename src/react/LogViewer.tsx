/**
 * `<LogViewer>`: the log viewer as a React 19 screen, for an app's own admin (for example a custom
 * page inside the `@strutvane/ui` shell). It talks to the same read API as the built-in page at
 * `/_strutvane/logs`, so the same access rules apply: the screen shows only what the server lets
 * the signed-in user see.
 *
 * - **Search:** levels, channel, free text, a time range and a request id; newest first.
 * - **Pagination with caps:** pages of `pageSize` records (at most 500, the server's cap), "Load
 *   older records" follows the server's cursor, and at most `maxRows` records stay on screen.
 * - **Live tail** (optional): new records stream in at the top through Server-Sent Events.
 * - **Files:** one row per day with NDJSON and CSV download links (the CSV is formula-safe).
 *
 * **XSS:** log text is attacker-controlled (paths, headers, messages), so it is rendered only as
 * React text children, never as HTML; links are built from a validated base path and encoded
 * parameters, so a log line can't become markup or a `javascript:` link.
 *
 * The screen has no look of its own beyond a few layout rules (`data-log-viewer` attributes and
 * `lv-*` class names a design can style), like the rest of `@strutvane/ui`.
 *
 * @example
 * import { LogViewer } from '@strutvane/log-viewer/react'
 * export default function LogsPage() { return <LogViewer /> }
 *
 * @module
 */
import { type FormEvent, type ReactElement, useCallback, useEffect, useRef, useState } from 'react'
import {
  createLogViewerClient,
  type LogFilesResponse,
  type LogQuery,
  LogViewerApiError,
  type LogViewerClient,
  MAX_PAGE_SIZE,
} from './client.ts'

/** The eight RFC 5424 levels (ADR-0022), least severe first. */
export const VIEWER_LEVELS: readonly string[] = Object.freeze([
  'debug',
  'info',
  'notice',
  'warning',
  'error',
  'critical',
  'alert',
  'emergency',
])

/** A record as the screen receives it (unknown keys kept). */
type ViewerRecordData = Readonly<Record<string, unknown>>

/** A record on screen, with a client-side key (records carry no id of their own). */
interface ViewerRow {
  readonly key: number
  readonly record: ViewerRecordData
}

/** The minimal `EventSource` the live tail needs (injectable for tests). */
export interface TailSource {
  onmessage: ((event: { readonly data: unknown }) => void) | null
  onerror: (() => void) | null
  onopen: (() => void) | null
  close(): void
}

/**
 * Open a live tail with the browser's `EventSource` (same-origin, so cookies are sent).
 *
 * @example
 * const source = eventSourceTail('/_strutvane/logs/api/tail')
 */
export function eventSourceTail(url: string): TailSource {
  const events = new EventSource(url)
  const source: TailSource = {
    onmessage: null,
    onerror: null,
    onopen: null,
    close: () => events.close(),
  }
  events.onmessage = (event) => source.onmessage?.({ data: event.data })
  events.onerror = () => source.onerror?.()
  events.onopen = () => source.onopen?.()
  return source
}

/** Props of {@link LogViewer}. */
export interface LogViewerProps {
  /** Where the viewer is mounted. Default: `/_strutvane/logs`. */
  readonly basePath?: string
  /** Records per page (1–500). Default: 100. */
  readonly pageSize?: number
  /** Records kept on screen; older ones are dropped. Default: 2,000. */
  readonly maxRows?: number
  /** A ready client (tests, or a fetch with extra headers). Default: one for `basePath`. */
  readonly client?: LogViewerClient
  /** Open a live-tail stream. Default: `new EventSource(url)` when the browser has one. */
  readonly openTail?: (url: string) => TailSource
  /** Heading text. Default: `Logs`. */
  readonly title?: string
}

interface Filters {
  readonly levels: readonly string[]
  readonly channel: string
  readonly q: string
  readonly from: string
  readonly to: string
  readonly requestId: string
}

const INITIAL_FILTERS: Filters = {
  levels: VIEWER_LEVELS.filter((level) => level !== 'debug'),
  channel: '',
  q: '',
  from: '',
  to: '',
  requestId: '',
}

/** A text field of a record, or `''`. */
const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** Only known level names become class names. */
const levelClass = (level: string): string =>
  VIEWER_LEVELS.includes(level) ? `lv-level lv-level-${level}` : 'lv-level'

/** A `datetime-local` value as an ISO instant, or `undefined` when empty or invalid. */
function isoFromLocal(value: string): string | undefined {
  if (value === '') return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
}

/** The filters as the API query. All levels selected means "no level filter". */
export function toQuery(filters: Filters): LogQuery {
  const from = isoFromLocal(filters.from)
  const to = isoFromLocal(filters.to)
  return {
    ...(filters.levels.length > 0 && filters.levels.length < VIEWER_LEVELS.length
      ? { levels: filters.levels }
      : {}),
    ...(filters.channel ? { channel: filters.channel } : {}),
    ...(filters.q.trim() ? { q: filters.q.trim() } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(filters.requestId.trim() ? { requestId: filters.requestId.trim() } : {}),
  }
}

/** A friendly message for a failed call. */
function describe(error: unknown): string {
  if (error instanceof LogViewerApiError) {
    if (error.status === 404 || error.status === 401)
      return 'You do not have access to the logs, or the log viewer is turned off.'
    return error.message
  }
  return 'Something went wrong while reading the logs.'
}

/** One record: time, level, message, request id, and the whole record on demand. */
function RecordRow({ record }: { readonly record: ViewerRecordData }): ReactElement {
  const level = text(record['level']) || 'info'
  const time = text(record['time'])
  const requestId = text(record['requestId'])
  return (
    <li className="lv-row" data-level={VIEWER_LEVELS.includes(level) ? level : undefined}>
      <div className="lv-line">
        <time className="lv-time" dateTime={time} title={time}>
          {time.replace('T', ' ').replace('Z', '')}
        </time>
        <span className={levelClass(level)}>{level}</span>
        <span className="lv-msg">{text(record['msg'])}</span>
        {requestId ? <span className="lv-rid">{requestId}</span> : null}
      </div>
      <details>
        <summary>Details</summary>
        <pre>{JSON.stringify(record, null, 2)}</pre>
      </details>
    </li>
  )
}

/**
 * The log viewer screen.
 *
 * @example
 * <LogViewer basePath="/_strutvane/logs" pageSize={50} />
 */
export function LogViewer(props: LogViewerProps): ReactElement {
  const pageSize = Math.min(Math.max(Math.trunc(props.pageSize ?? 100), 1), MAX_PAGE_SIZE)
  const maxRows = Math.max(Math.trunc(props.maxRows ?? 2_000), pageSize)
  const clientRef = useRef<LogViewerClient | undefined>(props.client)
  clientRef.current ??= createLogViewerClient(
    props.basePath === undefined ? {} : { basePath: props.basePath },
  )
  const client = clientRef.current

  const [draft, setDraft] = useState<Filters>(INITIAL_FILTERS)
  const [applied, setApplied] = useState<Filters>(INITIAL_FILTERS)
  const [rows, setRows] = useState<readonly ViewerRow[]>([])
  const [cursor, setCursor] = useState<string | undefined>(undefined)
  const [status, setStatus] = useState('Loading…')
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [files, setFiles] = useState<LogFilesResponse | undefined>(undefined)
  const [live, setLive] = useState(false)
  // Each load gets a number; an answer to an older load (filters changed meanwhile) is dropped.
  const generation = useRef(0)
  // Keys for rows: increasing numbers, so a live record added on top never re-keys older rows.
  const nextKey = useRef(0)
  const keyed = useCallback(
    (records: readonly ViewerRecordData[]): ViewerRow[] =>
      records.map((record) => ({ key: nextKey.current++, record })),
    [],
  )

  const load = useCallback(
    async (filters: Filters, from: string | undefined): Promise<void> => {
      const mine = ++generation.current
      setBusy(true)
      setError(undefined)
      try {
        const page = await client.records(toQuery(filters), {
          limit: pageSize,
          ...(from === undefined ? {} : { cursor: from }),
        })
        if (mine !== generation.current) return
        setRows((previous) => {
          const added = keyed(page.records)
          const next = from === undefined ? added : [...previous, ...added]
          return next.slice(0, maxRows)
        })
        setCursor(page.nextCursor)
        setStatus(
          page.records.length === 0 && from === undefined ? 'No records match.' : 'Records loaded.',
        )
      } catch (caught) {
        if (mine !== generation.current) return
        setError(describe(caught))
        setStatus('')
      } finally {
        if (mine === generation.current) setBusy(false)
      }
    },
    [client, pageSize, maxRows, keyed],
  )

  useEffect(() => {
    void load(applied, undefined)
  }, [applied, load])

  useEffect(() => {
    let active = true
    client.files().then(
      (answer) => {
        if (active) setFiles(answer)
      },
      () => {
        if (active) setFiles({ files: [], channels: [] })
      },
    )
    return () => {
      active = false
    }
  }, [client])

  const { openTail } = props
  useEffect(() => {
    if (!live) return undefined
    const open = openTail ?? (typeof EventSource === 'function' ? eventSourceTail : undefined)
    if (open === undefined) {
      setStatus('Live tail is not supported in this browser.')
      return undefined
    }
    const source = open(client.tailUrl(toQuery(applied)))
    source.onopen = () => setStatus('Live tail: waiting for new records…')
    source.onerror = () => setStatus('Live tail disconnected; retrying…')
    source.onmessage = (event) => {
      if (typeof event.data !== 'string') return
      let record: unknown
      try {
        record = JSON.parse(event.data)
      } catch {
        return
      }
      if (typeof record !== 'object' || record === null || Array.isArray(record)) return
      setRows((previous) => [...keyed([record as ViewerRecordData]), ...previous].slice(0, maxRows))
    }
    return () => {
      source.close()
    }
  }, [live, applied, client, openTail, maxRows, keyed])

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    // A new object even when nothing changed: Apply also means "search again" (fresh records).
    setApplied({ ...draft })
  }

  const toggleLevel = (level: string, on: boolean): void => {
    setDraft((current) => ({
      ...current,
      levels: on
        ? VIEWER_LEVELS.filter((l) => l === level || current.levels.includes(l))
        : current.levels.filter((l) => l !== level),
    }))
  }

  const days = files ? [...new Set(files.files.map((f) => f.day))] : []

  return (
    <section className="lv" data-log-viewer="">
      <h1 className="lv-title">{props.title ?? 'Logs'}</h1>
      <form className="lv-filters" aria-label="Filter logs" onSubmit={submit}>
        <fieldset className="lv-levels">
          <legend>Levels</legend>
          {VIEWER_LEVELS.map((level) => (
            <label key={level} className={levelClass(level)}>
              <input
                type="checkbox"
                name="level"
                value={level}
                checked={draft.levels.includes(level)}
                onChange={(e) => toggleLevel(level, e.currentTarget.checked)}
              />
              {level}
            </label>
          ))}
        </fieldset>
        <label>
          Channel
          <select
            value={draft.channel}
            onChange={(e) => {
              const channel = e.currentTarget.value
              setDraft((current) => ({ ...current, channel }))
            }}
          >
            <option value="">All channels</option>
            {(files?.channels ?? []).map((channel) => (
              <option key={channel} value={channel}>
                {channel}
              </option>
            ))}
          </select>
        </label>
        <label>
          Search
          <input
            type="search"
            maxLength={200}
            value={draft.q}
            onChange={(e) => {
              const q = e.currentTarget.value
              setDraft((current) => ({ ...current, q }))
            }}
          />
        </label>
        <label>
          From
          <input
            type="datetime-local"
            value={draft.from}
            onChange={(e) => {
              const from = e.currentTarget.value
              setDraft((current) => ({ ...current, from }))
            }}
          />
        </label>
        <label>
          To
          <input
            type="datetime-local"
            value={draft.to}
            onChange={(e) => {
              const to = e.currentTarget.value
              setDraft((current) => ({ ...current, to }))
            }}
          />
        </label>
        <label>
          Request id
          <input
            maxLength={128}
            value={draft.requestId}
            onChange={(e) => {
              const requestId = e.currentTarget.value
              setDraft((current) => ({ ...current, requestId }))
            }}
          />
        </label>
        <button type="submit">Apply</button>
        <label className="lv-live">
          <input
            type="checkbox"
            checked={live}
            onChange={(e) => {
              const on = e.currentTarget.checked
              setLive(on)
              if (!on) setStatus('Live tail stopped.')
            }}
          />
          Live tail
        </label>
      </form>

      <p className="lv-status" role="status" aria-live="polite">
        {status}
      </p>
      {error ? (
        <p className="lv-error" role="alert">
          {error}
        </p>
      ) : null}

      <ul className="lv-rows" aria-label="Log records, newest first" aria-busy={busy}>
        {rows.map((row) => (
          <RecordRow key={row.key} record={row.record} />
        ))}
      </ul>
      {cursor !== undefined && rows.length < maxRows ? (
        <button type="button" disabled={busy} onClick={() => void load(applied, cursor)}>
          Load older records
        </button>
      ) : null}

      <section className="lv-files" aria-label="Log files">
        <h2>Files</h2>
        {files === undefined ? null : days.length === 0 ? (
          <p>No log files yet.</p>
        ) : (
          <ul>
            {days.map((day) => (
              <li key={day}>
                <strong>{day}</strong>{' '}
                <a href={client.downloadUrl(day, 'ndjson', applied.channel || undefined)} download>
                  Download NDJSON
                </a>{' '}
                <a href={client.downloadUrl(day, 'csv', applied.channel || undefined)} download>
                  Download CSV
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  )
}
