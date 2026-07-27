import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * Unit tests only — they run in plain Node, so nothing here may import
 * `electron`. Anything that needs a real window belongs in the smoke test
 * (`npm run smoke`), which boots the built app instead.
 */
export default defineConfig({
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
})
