/**
 * The installer protocol (blueprint §3.3) through the framework's own devkit runtime on a real
 * temp project shaped like the skeleton: one transaction, idempotent, reversible, never guessing
 * at a file it doesn't recognise, never hard-coding another package.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkIdempotent, runInstaller } from '@strutvane/framework/devkit'
import fc from 'fast-check'
import { afterEach, describe, expect, test } from 'vitest'
import {
  addConfigKey,
  addProvider,
  CONFIG_LOCAL,
  PROVIDER_LOCAL,
  PROVIDER_SPECIFIER,
  removeConfigKey,
  removeProvider,
} from '../src/install/patch.ts'
import { CONFIG_TEMPLATE, ENV_KEYS, INSTALL_PATHS, installer } from '../src/installer.ts'
import { tempDir } from './helpers.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

const PROVIDERS = `// The service providers that run at boot, in order.
import type { AnyProvider } from '@strutvane/framework'
import { AppServiceProvider } from '../app/providers/app.provider.ts'

const providers: readonly AnyProvider[] = [AppServiceProvider]

export default providers
`

const CONFIG_INDEX = `// Every defineConfig file, keyed by file name.
import type { ConfigFiles } from '@strutvane/framework'
import app from './app.ts'
import logging from './logging.ts'

export default { app, logging } satisfies ConfigFiles
`

/** A temp project shaped like the skeleton. */
function project(files: Record<string, string> = {}): string {
  const t = tempDir('sv-log-viewer-app-')
  cleanups.push(t.cleanup)
  const all: Record<string, string> = {
    'bootstrap/providers.ts': PROVIDERS,
    'config/index.ts': CONFIG_INDEX,
    '.env': 'APP_ENV=local\n',
    '.env.example': 'APP_ENV=\n',
    'package.json': '{ "name": "blog", "private": true }\n',
    ...files,
  }
  for (const [path, content] of Object.entries(all)) {
    mkdirSync(join(t.dir, path, '..'), { recursive: true })
    writeFileSync(join(t.dir, path), content)
  }
  return t.dir
}

const read = (root: string, path: string): string => readFileSync(join(root, path), 'utf8')

describe('patches', () => {
  test('addProvider imports the provider and appends it, following the array layout', () => {
    const inline = addProvider(PROVIDERS) ?? ''
    expect(inline).toContain(`import ${PROVIDER_LOCAL} from '${PROVIDER_SPECIFIER}'`)
    expect(inline).toContain(`[AppServiceProvider, ${PROVIDER_LOCAL}]`)
    // The import goes after the last import, before the code.
    expect(inline.indexOf(PROVIDER_SPECIFIER)).toBeLessThan(inline.indexOf('const providers'))
    const multi = 'const providers = [\n  A,\n  B,\n]\n'
    expect(addProvider(multi)).toContain(`  B,\n  ${PROVIDER_LOCAL},\n]`)
    const noTrailing = 'const providers = [\n  A,\n  B\n]\n'
    expect(addProvider(noTrailing)).toContain(`  B,\n  ${PROVIDER_LOCAL}\n]`)
    expect(addProvider('const providers = []\n')).toContain(`[${PROVIDER_LOCAL}]`)
    expect(addProvider('const providers = [\n]\n')).toContain(`[\n  ${PROVIDER_LOCAL},\n]`)
  })

  test('multi-line imports are respected', () => {
    const source = `import {\n  A,\n  B,\n} from './a.ts'\nconst providers = [A, B]\n`
    const out = addProvider(source) ?? ''
    expect(out.startsWith(`import {\n  A,\n  B,\n} from './a.ts'\nimport ${PROVIDER_LOCAL}`)).toBe(
      true,
    )
  })

  test('idempotent and exactly reversible', () => {
    for (const source of [
      PROVIDERS,
      'const providers = [\n  A,\n  B,\n]\n',
      'const providers = [\n  A,\n  B\n]\n',
      'const providers = []\n',
      'const providers = [ A ]\n',
      'const providers = [A,]\n',
    ]) {
      const once = addProvider(source) ?? ''
      expect(addProvider(once)).toBe(once)
      expect(removeProvider(once)).toBe(source)
      expect(removeProvider(source)).toBe(source)
    }
    const once = addConfigKey(CONFIG_INDEX) ?? ''
    expect(once).toContain(`{ app, logging, ${CONFIG_LOCAL} }`)
    expect(addConfigKey(once)).toBe(once)
    expect(removeConfigKey(once)).toBe(CONFIG_INDEX)
  })

  test('property: any list of identifiers round-trips, in either layout', () => {
    const name = fc.stringMatching(/^[A-Z][A-Za-z0-9]{0,8}$/)
    fc.assert(
      fc.property(
        fc.array(name, { maxLength: 6 }),
        fc.boolean(),
        fc.boolean(),
        (items, multi, trailing) => {
          const body = multi
            ? items.length === 0
              ? '\n'
              : `\n${items.map((i, n) => `  ${i}${n < items.length - 1 || trailing ? ',' : ''}`).join('\n')}\n`
            : items.join(', ')
          const source = `import x from 'x'\nconst providers = [${body}]\nexport default providers\n`
          const added = addProvider(source)
          expect(added).toBeDefined()
          expect(removeProvider(added ?? '')).toBe(source)
        },
      ),
    )
  })

  test('unknown shapes are refused, never guessed at', () => {
    expect(addProvider('export default [A]\n')).toBeUndefined()
    expect(addProvider('const providers = [A]\nconst providers = [B]\n')).toBeUndefined()
    expect(addProvider('const providers = [a[0]]\n')).toBeUndefined()
    expect(addConfigKey('module.exports = {}\n')).toBeUndefined()
    expect(addConfigKey('export default { nested: { a } }\n')).toBeUndefined()
  })
})

describe('the installer (through the framework devkit)', () => {
  test('installs completely: config, config index, env keys and the provider', async () => {
    const root = project()
    const result = await runInstaller(installer, { projectRoot: root })
    expect(result.committed).toBe(true)
    expect(read(root, INSTALL_PATHS.config)).toBe(CONFIG_TEMPLATE)
    expect(read(root, INSTALL_PATHS.configIndex)).toContain(
      `import ${CONFIG_LOCAL} from './log-viewer.ts'`,
    )
    expect(read(root, INSTALL_PATHS.providers)).toContain(`[AppServiceProvider, ${PROVIDER_LOCAL}]`)
    for (const file of ['.env', '.env.example'])
      for (const key of ENV_KEYS) expect(read(root, file)).toContain(`${key}=`)
    // The token stays empty: token access is off until the developer sets one.
    expect(read(root, '.env')).toMatch(/^LOG_VIEWER_TOKEN=$/m)
  })

  test('is idempotent (the installer protocol)', async () => {
    expect(await checkIdempotent(installer, { projectRoot: project() })).toEqual([])
  })

  test('a dry run writes nothing and shows the diff', async () => {
    const root = project()
    const result = await runInstaller(installer, { projectRoot: root, dryRun: true })
    expect(result.committed).toBe(false)
    expect(result.diff).toContain(PROVIDER_SPECIFIER)
    expect(existsSync(join(root, INSTALL_PATHS.config))).toBe(false)
    expect(read(root, INSTALL_PATHS.providers)).toBe(PROVIDERS)
  })

  test('keeps an existing config/log-viewer.ts (it is the app’s)', async () => {
    const mine = '// mine\nexport default {}\n'
    const root = project({ [INSTALL_PATHS.config]: mine })
    await runInstaller(installer, { projectRoot: root })
    expect(read(root, INSTALL_PATHS.config)).toBe(mine)
  })

  test('uninstall reverses the edits and keeps the config file', async () => {
    const root = project()
    await runInstaller(installer, { projectRoot: root })
    const result = await runInstaller(installer, { projectRoot: root, mode: 'uninstall' })
    expect(result.committed).toBe(true)
    expect(read(root, INSTALL_PATHS.providers)).toBe(PROVIDERS)
    expect(read(root, INSTALL_PATHS.configIndex)).toBe(CONFIG_INDEX)
    for (const key of ENV_KEYS) expect(read(root, '.env')).not.toContain(key)
    expect(existsSync(join(root, INSTALL_PATHS.config))).toBe(true)
  })

  test('an unrecognised file is left alone with the manual step printed', async () => {
    const odd = 'export default [AppServiceProvider]\n'
    const root = project({
      [INSTALL_PATHS.providers]: odd,
      [INSTALL_PATHS.configIndex]: 'module.exports = {}\n',
    })
    const result = await runInstaller(installer, { projectRoot: root })
    expect(read(root, INSTALL_PATHS.providers)).toBe(odd)
    const warnings = result.messages.filter((m) => m.level === 'warn').map((m) => m.message)
    expect(warnings.join('\n')).toContain(`import ${PROVIDER_LOCAL} from '${PROVIDER_SPECIFIER}'`)
    expect(warnings.join('\n')).toContain('config/index.ts has an unexpected shape')
  })

  test('an app without bootstrap/providers.ts or config/index.ts gets the manual steps', async () => {
    const t = tempDir('sv-log-viewer-bare-')
    cleanups.push(t.cleanup)
    writeFileSync(join(t.dir, 'package.json'), '{ "name": "bare" }\n')
    const result = await runInstaller(installer, { projectRoot: t.dir })
    const warnings = result.messages.filter((m) => m.level === 'warn').map((m) => m.message)
    expect(warnings).toHaveLength(2)
    expect(existsSync(join(t.dir, INSTALL_PATHS.config))).toBe(true)
    const removed = await runInstaller(installer, { projectRoot: t.dir, mode: 'uninstall' })
    expect(removed.committed).toBe(true)
  })

  test('an older app with strutvane.config.ts registers through the framework config patcher', async () => {
    const t = tempDir('sv-log-viewer-legacy-')
    cleanups.push(t.cleanup)
    writeFileSync(join(t.dir, 'package.json'), '{ "name": "legacy" }\n')
    writeFileSync(
      join(t.dir, INSTALL_PATHS.legacyConfig),
      "import backend from '@strutvane/framework/provider'\n\nexport default { providers: [backend] }\n",
    )
    await runInstaller(installer, { projectRoot: t.dir })
    expect(read(t.dir, INSTALL_PATHS.legacyConfig)).toContain(PROVIDER_SPECIFIER)
    await runInstaller(installer, { projectRoot: t.dir, mode: 'uninstall' })
    expect(read(t.dir, INSTALL_PATHS.legacyConfig)).not.toContain(PROVIDER_SPECIFIER)
  })

  test('the package.json strutvane block declares this installer', () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
    ) as {
      name: string
      exports: Record<string, unknown>
      strutvane: { id: string; installer: string; compat: string }
    }
    expect(manifest.name).toBe('@strutvane/log-viewer')
    expect(manifest.strutvane.id).toBe(installer.name)
    expect(manifest.strutvane.installer).toBe('./dist/installer.mjs')
    expect(manifest.strutvane.compat).toMatch(/^\^0\.2\./)
    expect(manifest.exports['./provider']).toBeDefined()
  })
})
