import type { HarnessApi } from './index'

declare global {
  interface Window {
    harness: HarnessApi
  }
}

export {}
