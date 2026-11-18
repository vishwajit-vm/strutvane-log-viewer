// The provider on the framework's real kernel pieces: the core app, the container, the hooks and
// the framework's own log manager (LogManagerToken), driven the way the HTTP kernel drives
// `http.onRequest` (an identity handler named `auth.identity` stands in for @strutvane/auth).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Actor, HttpRequestHookPayload } from '@strutvane/framework/contracts'
import { createApp, defineProvider, HooksToken, type Provider } from '@strutvane/framework/core'
import { createLogManager, LogManagerToken } from '@strutvane/framework/log'
import { afterEach, describe, expect, test } from 'vitest'
import provider, {
  createLogViewerProvider,
  fileChannels,
  HOOK_NAME,
  LogViewerGateToken,
  type LogViewerProviderOptions,
  readConfig,
  type ViewerAccessOptions,
} from '../src/provider.ts'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0))
    await rm(d, { recursive: true, force: true, maxRetries: 10 }).catch(() => undefined)
})

const ADMIN: Actor = { id: 'u1', type: 'user', roles: ['admin'], attrs: {} }
const MEMBER: Actor = { id: 'u2', type: 'user', roles: ['member'], attrs: {} }

interface BootOptions {
  readonly appEnv: string
  readonly logViewer?: unknown
  readonly gate?: ViewerAccessOptions
  readonly options?: LogViewerProviderOptions
  /** Bind the framework's log manager (as the Application does). Default: true. */
  readonly manager?: boolean
  /** The actor the stand-in identity provider resolves. */
  readonly actor?: Actor | null
}

async function boot(o: BootOptions) {
  const root = await mkdtemp(join(tmpdir(), 'sv-log-viewer-'))
  dirs.push(root)
  const logs = join(root, 'storage', 'logs')
  await mkdir(logs, { recursive: true })
  const env = { APP_ENV: o.appEnv, LOG_FORMAT: 'json' }
  // The app's own pieces, registered before the viewer like an app's providers would be.
  const appProvider: Provider = defineProvider({
    name: 'app',
    register(app) {
      if (o.manager !== false)
        app.container.value(
          LogManagerToken,
          createLogManager({
            root,
            env,
            config: { channels: { payments: { driver: 'daily', name: 'payments' } } },
          }),
        )
      if (o.gate) app.container.value(LogViewerGateToken, o.gate)
    },
  })
  const viewerProvider = createLogViewerProvider({ env, ...o.options })
  // Registered after the viewer, so only the `after` hint can put the identity first.
  const identity: Provider = defineProvider({
    name: 'identity',
    register() {},
    boot(app) {
      app
        .make(HooksToken)
        .on(
          'http.onRequest',
          (payload) => ({ ...(payload as HttpRequestHookPayload), actor: o.actor ?? null }),
          { name: 'auth.identity' },
        )
    },
  })
  const app = createApp({
    config: o.logViewer === undefined ? {} : { logViewer: o.logViewer },
    providers: [appProvider, viewerProvider, identity],
  })
  await app.boot()
  const hooks = app.make(HooksToken)
  const request = async (
    url: string,
    init: { clientAddress?: string; headers?: Record<string, string> } = {},
  ): Promise<Response | undefined> => {
    const payload: HttpRequestHookPayload = {
      request: new Request(url, init.headers ? { headers: init.headers } : {}),
      actor: null,
      tenant: undefined,
      ...(init.clientAddress === undefined ? {} : { clientAddress: init.clientAddress }),
    }
    const out = (await hooks.run('http.onRequest', payload)) as HttpRequestHookPayload
    return out.response
  }
  return { app, logs, request }
}

const LOCAL = 'http://localhost:3000/_strutvane/logs'
const PROD = 'https://app.example.test/_strutvane/logs'

describe('@strutvane/log-viewer/provider', () => {
  test('exports a ready provider', () => {
    expect(provider.name).toBe('@strutvane/log-viewer')
    expect(HOOK_NAME).toBe('logViewer.serve')
  })

  test('local: the page opens on loopback; production: a 404; other paths pass through', async () => {
    const local = await boot({ appEnv: 'local' })
    expect((await local.request(LOCAL))?.status).toBe(200)
    expect(await local.request('http://localhost:3000/api/v1/posts')).toBeUndefined()
    await local.app.shutdown()
    const prod = await boot({ appEnv: 'production' })
    expect((await prod.request(PROD))?.status).toBe(404)
    expect((await prod.request(`${PROD}/api/records`))?.status).toBe(404)
    await prod.app.shutdown()
  })

  test('APP_ENV comes from the log manager, not only from process.env', async () => {
    // The manager was built with APP_ENV=production, the provider env says local: production wins.
    const { app, request } = await boot({
      appEnv: 'production',
      options: { env: { APP_ENV: 'local' } },
    })
    expect((await request(LOCAL))?.status).toBe(404)
    await app.shutdown()
  })

  test('the gate the app binds decides by actor; a throwing gate fails closed', async () => {
    const authorize: ViewerAccessOptions['authorize'] = (_request, { actor }) =>
      actor?.roles.includes('admin') === true
    const admin = await boot({ appEnv: 'production', gate: { authorize }, actor: ADMIN })
    expect((await admin.request(`${PROD}/api/files`))?.status).toBe(200)
    await admin.app.shutdown()
    const member = await boot({ appEnv: 'production', gate: { authorize }, actor: MEMBER })
    expect((await member.request(`${PROD}/api/files`))?.status).toBe(404)
    await member.app.shutdown()
    const nobody = await boot({ appEnv: 'production', gate: { authorize } })
    expect((await nobody.request(`${PROD}/api/files`))?.status).toBe(404)
    await nobody.app.shutdown()
    const broken = await boot({
      appEnv: 'production',
      gate: {
        authorize: () => {
          throw new Error('gate bug')
        },
      },
      actor: ADMIN,
    })
    expect((await broken.request(`${PROD}/api/files`))?.status).toBe(404)
    await broken.app.shutdown()
  })

  test('provider options override the bound gate', async () => {
    const { app, request } = await boot({
      appEnv: 'production',
      gate: { authorize: () => true },
      options: { viewer: { authorize: () => false } },
    })
    expect((await request(`${PROD}/api/files`))?.status).toBe(404)
    await app.shutdown()
  })

  test('ipAllowList from config uses the hook clientAddress and fails closed without it', async () => {
    const { app, request } = await boot({
      appEnv: 'production',
      logViewer: { ipAllowList: ['10.0.0.0/8'] },
      gate: { authorize: () => true },
    })
    expect((await request(`${PROD}/api/files`, { clientAddress: '10.1.2.3' }))?.status).toBe(200)
    expect((await request(`${PROD}/api/files`, { clientAddress: '192.168.1.5' }))?.status).toBe(404)
    expect((await request(`${PROD}/api/files`))?.status).toBe(404)
    await app.shutdown()
  })

  test('local mode checks the peer address and the Host header', async () => {
    const { app, request } = await boot({ appEnv: 'local' })
    const url = `${LOCAL}/api/files`
    expect((await request(url, { clientAddress: '127.0.0.1' }))?.status).toBe(200)
    expect((await request(url, { clientAddress: '192.168.1.20' }))?.status).toBe(404)
    expect((await request(url, { headers: { host: 'evil.test' } }))?.status).toBe(404)
    await app.shutdown()
  })

  test('the token from config/log-viewer.ts opens the viewer in production', async () => {
    const token = 'a-long-enough-viewer-token'
    const { app, request } = await boot({ appEnv: 'production', logViewer: { token } })
    const bearer = (value: string) => ({ headers: { authorization: `Bearer ${value}` } })
    expect((await request(`${PROD}/api/files`, bearer(token)))?.status).toBe(200)
    expect((await request(`${PROD}/api/files`, bearer('wrong-token-123456')))?.status).toBe(401)
    await app.shutdown()
  })

  test('enabled: false turns the viewer off; a custom path moves it', async () => {
    const off = await boot({ appEnv: 'local', logViewer: { enabled: false } })
    expect(await off.request(LOCAL)).toBeUndefined()
    await off.app.shutdown()
    const moved = await boot({ appEnv: 'local', logViewer: { path: '/admin/logs' } })
    expect(await moved.request(LOCAL)).toBeUndefined()
    expect((await moved.request('http://localhost:3000/admin/logs'))?.status).toBe(200)
    await moved.app.shutdown()
  })

  test('an invalid config/log-viewer.ts fails the boot, naming the setting', async () => {
    await expect(boot({ appEnv: 'local', logViewer: { enabled: 'yes' } })).rejects.toThrow(
      /enabled must be true or false/,
    )
    await expect(boot({ appEnv: 'local', logViewer: { path: '//evil' } })).rejects.toThrow(
      /basePath/,
    )
    await expect(boot({ appEnv: 'local', logViewer: { token: 'short' } })).rejects.toThrow(
      /at least 16/,
    )
    await expect(boot({ appEnv: 'local', logViewer: { ipAllowList: ['nope'] } })).rejects.toThrow(
      /ipAllowList/,
    )
  })

  test('channels come from the framework log manager; the channel filter narrows files', async () => {
    const { app, logs, request } = await boot({ appEnv: 'local' })
    const line = (msg: string, time: string) => `${JSON.stringify({ time, level: 'info', msg })}\n`
    await writeFile(
      join(logs, 'strutvane-2026-11-15.log'),
      line('main', '2026-11-15T10:00:00.000Z'),
    )
    await writeFile(join(logs, 'payments-2026-11-15.log'), line('paid', '2026-11-15T10:00:01.000Z'))
    const files = (await (await request(`${LOCAL}/api/files`))?.json()) as {
      channels: string[]
      files: { name: string }[]
    }
    expect(files.channels).toEqual(expect.arrayContaining(['payments', 'daily']))
    expect(files.files.map((f) => f.name).sort()).toEqual([
      'payments-2026-11-15.log',
      'strutvane-2026-11-15.log',
    ])
    const paid = (await (await request(`${LOCAL}/api/records?channel=payments`))?.json()) as {
      records: { msg: string }[]
    }
    expect(paid.records.map((r) => r.msg)).toEqual(['paid'])
    const unknown = await request(`${LOCAL}/api/records?channel=nope`)
    expect(unknown?.status).toBe(400)
    expect(await unknown?.json()).toMatchObject({ code: 'invalid_query' })
    await app.shutdown()
  })

  test('without a log manager the viewer still works from LOG_PATH', async () => {
    const { app, request } = await boot({ appEnv: 'local', manager: false })
    expect((await request(LOCAL))?.status).toBe(200)
    await app.shutdown()
  })
})

describe('readConfig and fileChannels', () => {
  test('readConfig accepts absent and well-formed settings and refuses the rest', () => {
    expect(readConfig({ settings: {} })).toEqual({})
    expect(readConfig({ settings: { logViewer: null } })).toEqual({})
    expect(
      readConfig({ settings: { logViewer: { enabled: true, path: '/x', token: undefined } } }),
    ).toEqual({ enabled: true, path: '/x' })
    expect(() => readConfig({ settings: { logViewer: [] } })).toThrow(/object of settings/)
    expect(() => readConfig({ settings: { logViewer: { path: 1 } } })).toThrow(/path/)
    expect(() => readConfig({ settings: { logViewer: { token: 1 } } })).toThrow(/token/)
    expect(() => readConfig({ settings: { logViewer: { ipAllowList: 'x' } } })).toThrow(
      /ipAllowList/,
    )
  })

  test('fileChannels keeps file channels in the default directory only', () => {
    expect(
      fileChannels({
        path: '/l',
        channels: {
          daily: { driver: 'daily', dir: '/l', base: 'strutvane' },
          payments: { driver: 'single', dir: '/l', base: 'payments' },
          elsewhere: { driver: 'single', dir: '/other', base: 'audit' },
          stderr: { driver: 'stderr' },
        },
      }),
    ).toEqual({
      dir: '/l',
      bases: ['strutvane', 'payments'],
      channels: { daily: 'strutvane', payments: 'payments' },
    })
    expect(fileChannels({ path: '/l', channels: { stderr: { driver: 'stderr' } } })).toEqual({
      dir: '/l',
      bases: ['strutvane'],
      channels: {},
    })
  })
})
