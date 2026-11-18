// @vitest-environment jsdom
/**
 * The React screen and its client: search, pagination with caps, live tail, downloads, error
 * states, and XSS safety (log text is attacker-controlled and must only ever render as text).
 */
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createLogViewerClient, LogViewerApiError, queryParams } from '../src/react/client.ts'
import { LogViewer, type TailSource, toQuery, VIEWER_LEVELS } from '../src/react/LogViewer.tsx'

afterEach(() => {
  cleanup()
})

interface Call {
  readonly path: string
  readonly params: URLSearchParams
  readonly init: RequestInit | undefined
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  })

/** A fake viewer API: records pages by cursor, a files list, and a record of every call. */
function api(
  pages: Record<string, { records: unknown[]; nextCursor?: string }>,
  files: unknown = {
    files: [
      { name: 'strutvane-2026-11-15.log', day: '2026-11-15', size: 10 },
      { name: 'payments-2026-11-15.log', day: '2026-11-15', size: 5 },
    ],
    channels: ['daily', 'payments'],
  },
) {
  const calls: Call[] = []
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), 'http://localhost')
    calls.push({ path: url.pathname, params: url.searchParams, init })
    if (url.pathname.endsWith('/api/files')) return json(files)
    const page = pages[url.searchParams.get('cursor') ?? '']
    return page ? json({ ...page, scanned: page.records.length }) : json({ title: 'x' }, 400)
  })
  return { calls, client: createLogViewerClient({ fetch }) }
}

const rec = (msg: string, extra: Record<string, unknown> = {}) => ({
  time: '2026-11-15T10:00:00.000Z',
  level: 'info',
  msg,
  ...extra,
})

describe('<LogViewer>', () => {
  test('loads the newest records with every level but debug, and lists channels and files', async () => {
    const { calls, client } = api({ '': { records: [rec('hello', { requestId: 'r-1' })] } })
    render(<LogViewer client={client} />)
    expect(await screen.findByText('hello')).toBeTruthy()
    expect(screen.getByText('r-1')).toBeTruthy()
    const first = calls.find((c) => c.path.endsWith('/api/records'))
    expect(first?.params.get('level')).toBe(VIEWER_LEVELS.filter((l) => l !== 'debug').join(','))
    expect(first?.params.get('limit')).toBe('100')
    expect(first?.init?.credentials).toBe('same-origin')
    await screen.findByRole('option', { name: 'payments' })
    const files = screen.getByRole('region', { name: 'Log files' })
    const links = within(files).getAllByRole('link')
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/_strutvane/logs/api/download?day=2026-11-15&format=ndjson',
      '/_strutvane/logs/api/download?day=2026-11-15&format=csv',
    ])
  })

  test('XSS: markup in log text renders as text, never as elements', async () => {
    const hostile = '<img src=x onerror="globalThis.pwned=1"><script>globalThis.pwned=1</script>'
    const { client } = api({
      '': {
        records: [rec(hostile, { level: '<b>bad</b>', requestId: '"><svg onload=alert(1)>' })],
      },
    })
    const { container } = render(<LogViewer client={client} />)
    expect(await screen.findByText(hostile)).toBeTruthy()
    expect(container.querySelector('img, script, svg, b')).toBeNull()
    expect(Reflect.get(globalThis, 'pwned')).toBeUndefined()
    // An unknown level never becomes a class name or data attribute.
    expect(container.innerHTML).not.toContain('lv-level-<b>')
    expect(container.querySelector('[data-level]')).toBeNull()
  })

  test('filters go to the server as one query; all levels selected means no level filter', async () => {
    const { calls, client } = api({ '': { records: [] } })
    const user = userEvent.setup()
    render(<LogViewer client={client} />)
    await screen.findByText('No records match.')
    await user.click(screen.getByRole('checkbox', { name: 'debug' }))
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Channel' }), 'payments')
    await user.type(screen.getByRole('searchbox', { name: 'Search' }), ' timeout ')
    await user.type(screen.getByRole('textbox', { name: 'Request id' }), 'r-9')
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() =>
      expect(calls.filter((c) => c.path.endsWith('/api/records'))).toHaveLength(2),
    )
    const last = calls.filter((c) => c.path.endsWith('/api/records')).at(-1)
    expect(last?.params.has('level')).toBe(false)
    expect(last?.params.get('channel')).toBe('payments')
    expect(last?.params.get('q')).toBe('timeout')
    expect(last?.params.get('requestId')).toBe('r-9')
    // Downloads follow the applied channel, encoded.
    const csv = screen.getByRole('link', { name: 'Download CSV' })
    expect(csv.getAttribute('href')).toContain('&channel=payments')
  })

  test('"Load older records" follows the cursor and appends; the row cap is respected', async () => {
    const { calls, client } = api({
      '': { records: [rec('a'), rec('b')], nextCursor: 'c1' },
      c1: { records: [rec('c'), rec('d')], nextCursor: 'c2' },
    })
    const user = userEvent.setup()
    render(<LogViewer client={client} pageSize={2} maxRows={3} />)
    await screen.findByText('b')
    await user.click(screen.getByRole('button', { name: 'Load older records' }))
    await screen.findByText('c')
    expect(
      calls
        .filter((c) => c.path.endsWith('/api/records'))
        .at(-1)
        ?.params.get('cursor'),
    ).toBe('c1')
    expect(screen.queryByText('d')).toBeNull() // capped at 3 rows
    expect(screen.queryByRole('button', { name: 'Load older records' })).toBeNull()
  })

  test('page sizes are clamped to what the server accepts', async () => {
    const { calls, client } = api({ '': { records: [] } })
    render(<LogViewer client={client} pageSize={10_000} />)
    await screen.findByText('No records match.')
    expect(calls.find((c) => c.path.endsWith('/api/records'))?.params.get('limit')).toBe('500')
  })

  test('a 404 (no access) and a 400 problem are shown as messages, not crashes', async () => {
    const denied = createLogViewerClient({
      fetch: async () => new Response('Not Found', { status: 404 }),
    })
    render(<LogViewer client={denied} />)
    expect((await screen.findByRole('alert')).textContent).toMatch(/do not have access/)
    cleanup()
    const invalid = createLogViewerClient({
      fetch: async () =>
        json(
          { title: 'Invalid query', status: 400, code: 'invalid_query', detail: 'unknown level' },
          400,
        ),
    })
    render(<LogViewer client={invalid} />)
    expect((await screen.findByRole('alert')).textContent).toBe('unknown level')
  })

  test('live tail: new records arrive on top; malformed events are ignored; closed on stop', async () => {
    const { client } = api({ '': { records: [rec('older')] } })
    const sources: Array<TailSource & { url: string; closed: boolean }> = []
    const openTail = (url: string) => {
      const source = {
        url,
        closed: false,
        onmessage: null,
        onerror: null,
        onopen: null,
        close() {
          source.closed = true
        },
      } as TailSource & { url: string; closed: boolean }
      sources.push(source)
      return source
    }
    const user = userEvent.setup()
    const { container } = render(<LogViewer client={client} openTail={openTail} />)
    await screen.findByText('older')
    await user.click(screen.getByRole('checkbox', { name: 'Live tail' }))
    const source = sources[0]
    expect(source?.url).toMatch(/^\/_strutvane\/logs\/api\/tail\?level=/)
    act(() => {
      source?.onopen?.()
      source?.onmessage?.({ data: JSON.stringify(rec('newest')) })
      source?.onmessage?.({ data: 'not json' })
      source?.onmessage?.({ data: '[1,2]' })
      source?.onmessage?.({ data: 42 })
    })
    const messages = [...container.querySelectorAll('.lv-msg')].map((m) => m.textContent)
    expect(messages).toEqual(['newest', 'older'])
    act(() => source?.onerror?.())
    expect(screen.getByRole('status').textContent).toMatch(/disconnected/)
    await user.click(screen.getByRole('checkbox', { name: 'Live tail' }))
    expect(source?.closed).toBe(true)
    expect(screen.getByRole('status').textContent).toBe('Live tail stopped.')
  })

  test('without EventSource the live tail explains itself', async () => {
    vi.stubGlobal('EventSource', undefined)
    const { client } = api({ '': { records: [] } })
    const user = userEvent.setup()
    render(<LogViewer client={client} />)
    await screen.findByText('No records match.')
    await user.click(screen.getByRole('checkbox', { name: 'Live tail' }))
    expect(screen.getByRole('status').textContent).toMatch(/not supported/)
  })

  test('an answer to an older search is dropped when filters changed meanwhile', async () => {
    let release: (() => void) | undefined
    let call = 0
    const client = createLogViewerClient({
      fetch: async (input) => {
        const url = new URL(String(input), 'http://localhost')
        if (url.pathname.endsWith('/api/files')) return json({ files: [], channels: [] })
        call++
        if (call === 1) {
          await new Promise<void>((r) => {
            release = r
          })
          return json({ records: [rec('stale')], scanned: 1 })
        }
        return json({ records: [rec('fresh')], scanned: 1 })
      },
    })
    const user = userEvent.setup()
    render(<LogViewer client={client} />)
    await waitFor(() => expect(release).toBeDefined())
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    await screen.findByText('fresh')
    act(() => release?.())
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByText('stale')).toBeNull()
    expect(screen.getByText('No log files yet.')).toBeTruthy()
  })
})

describe('client', () => {
  test('base paths are validated, so links can never leave the origin', () => {
    for (const bad of [
      'javascript:alert(1)',
      '//evil.test',
      'https://evil.test',
      '/a b',
      '/a?x',
      '/a//b',
    ])
      expect(() => createLogViewerClient({ basePath: bad })).toThrow(TypeError)
    const client = createLogViewerClient({ basePath: '/admin/logs/' })
    expect(client.basePath).toBe('/admin/logs')
    expect(client.downloadUrl('2026-11-15', 'csv', 'a&b=c')).toBe(
      '/admin/logs/api/download?day=2026-11-15&format=csv&channel=a%26b%3Dc',
    )
    expect(client.tailUrl({})).toBe('/admin/logs/api/tail')
  })

  test('query parameters are trimmed and encoded; empty values are left out', () => {
    expect(queryParams({ levels: [], q: '  ', channel: 'x y', status: '5xx' }).toString()).toBe(
      'channel=x+y&status=5xx',
    )
    expect(
      toQuery({
        levels: ['error'],
        channel: '',
        q: ' a ',
        from: 'not a date',
        to: '2026-11-15T10:00',
        requestId: '',
      }),
    ).toEqual({ levels: ['error'], q: 'a', to: new Date('2026-11-15T10:00').toISOString() })
  })

  test('errors carry the problem code; network failures and odd bodies are handled', async () => {
    const failing = createLogViewerClient({
      fetch: async () => {
        throw new TypeError('offline')
      },
    })
    await expect(failing.files()).rejects.toMatchObject({ status: 0, code: 'network_error' })
    const html = createLogViewerClient({
      fetch: async () => new Response('<html>', { status: 502 }),
    })
    const error = await html.records({}).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LogViewerApiError)
    expect(error).toMatchObject({ status: 502, code: 'http_502' })
    const titled = createLogViewerClient({ fetch: async () => json({ title: 'Too many' }, 429) })
    await expect(titled.records({})).rejects.toMatchObject({ message: 'Too many' })
    const odd = createLogViewerClient({
      fetch: async () => json({ files: 'x', channels: null, scoped: true }),
    })
    expect(await odd.files('payments')).toEqual({ files: [], channels: [], scoped: true })
    const oddPage = createLogViewerClient({
      fetch: async () => json({ records: 1, nextCursor: 5 }),
    })
    expect(await oddPage.records({}, { limit: 0 })).toEqual({ records: [], scanned: 0 })
  })
})
