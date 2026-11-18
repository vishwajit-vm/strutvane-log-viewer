import { defineConfig, mergeConfig } from 'vitest/config'
import { sharedConfig } from './vitest.shared.ts'

// Repo-specific overrides. Shared defaults come from strutvane-tooling.
// - Server-side tests run in the default `node` environment on real temp files; React screen
//   tests opt into jsdom with a `// @vitest-environment jsdom` file comment.
// - Real files and live tails are timing-sensitive: run files one at a time so they don't compete
//   for the disk and CPU, and give slow CI machines room.
export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      include: ['test/**/*.test.{ts,tsx}'],
      fileParallelism: false,
      testTimeout: 30_000,
      hookTimeout: 30_000,
      coverage: {
        include: ['src/**/*.{ts,tsx}'],
        exclude: ['src/**/index.ts'],
      },
    },
  }),
)
