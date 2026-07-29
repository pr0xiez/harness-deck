import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const shared = resolve(__dirname, 'src/shared')

/**
 * Unit tests, split in two because the two halves of the app disagree about
 * what a global is: the main process has no DOM and the renderer has nothing
 * else. Neither half gets an Electron runtime — anything that needs one belongs
 * in the smoke test (`npm run smoke`), which boots the built app instead.
 */
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // Without this, coverage only counts files a test happened to import, so
      // deleting a test would *raise* the number.
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        // The stub bridge and its wiring — test scaffolding, not app code.
        'src/renderer/src/test/**',
        // Types and declarations compile to nothing; a denominator of 0 skews
        // every total they land in.
        'src/shared/types.ts',
        'src/preload/index.d.ts',
        // Covered by `npm run smoke` against the built app, which coverage of a
        // unit run can only misreport.
        'src/main/smoke.ts',
        'src/renderer/src/main.tsx'
      ]
    },
    projects: [
      {
        resolve: { alias: { '@shared': shared } },
        test: {
          name: 'node',
          // The main process and the code it shares run in plain Node, so
          // nothing either of them reaches may import `electron` — there is no
          // Electron runtime here to satisfy it.
          environment: 'node',
          include: ['src/{main,preload,shared}/**/*.test.ts']
        }
      },
      {
        resolve: { alias: { '@shared': shared, '@': resolve(__dirname, 'src/renderer/src') } },
        // esbuild reads the `jsx` setting from the nearest tsconfig, and the one
        // beside this file only holds project references — so say it outright.
        esbuild: { jsx: 'automatic' },
        test: {
          name: 'renderer',
          environment: 'jsdom',
          // Fifteen renderer modules read `window.harness` at import time. The
          // setup file runs before any of them is imported, which is the whole
          // reason the bridge can be stubbed without touching those files.
          setupFiles: [
            resolve(__dirname, 'src/renderer/src/test/harness.ts'),
            resolve(__dirname, 'src/renderer/src/test/dom.ts')
          ],
          // One stubbed bridge is shared by every test file, so call counts
          // must not survive the test that made them.
          clearMocks: true,
          include: ['src/renderer/**/*.test.{ts,tsx}']
        }
      }
    ]
  }
})
