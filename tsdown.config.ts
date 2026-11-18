import { defineConfig } from 'tsdown'

// Entry points: the root (the viewer's read API and Web handler), `./react` (the screen and its
// browser-safe client), `./provider` and `./installer` (the Strutvane app integration), and the
// deprecated request-logging adapters. The framework, React, Hono and Express are peer
// dependencies and stay external.
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'react/index': 'src/react/index.ts',
    provider: 'src/provider.ts',
    installer: 'src/installer.ts',
    http: 'src/http/index.ts',
    node: 'src/adapters/node.ts',
    hono: 'src/adapters/hono.ts',
    express: 'src/adapters/express.ts',
  },
  format: 'esm',
  platform: 'node',
  target: 'node24',
  dts: true,
  sourcemap: true,
  clean: true,
  deps: { neverBundle: ['hono', 'express', 'react', 'react-dom', /^@strutvane\/framework/] },
})
