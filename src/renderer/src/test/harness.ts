import { vi, type Mock } from 'vitest'
import type { SaveStateResult } from '@shared/types'

/**
 * The preload bridge, stubbed.
 *
 * Fifteen renderer modules do `const api = window.harness` at module scope, so
 * the bridge has to exist before the first `import` of any of them runs — a
 * `beforeEach` is already too late. This file is the renderer project's setup
 * file for exactly that reason, and installing on import is the point.
 *
 * The type comes from the `Window` augmentation in `src/preload/index.d.ts`,
 * so this stub cannot drift from the real bridge without failing typecheck.
 * That failure is the feature: a method added to the preload and forgotten here
 * would otherwise be `undefined` at the exact moment a test needed it.
 */

type HarnessApi = Window['harness']

/**
 * Subscriptions hand back their own unsubscribe, and callers return it straight
 * out of a `useEffect` — so a stub that returned nothing would leave React
 * without a cleanup on unmount.
 *
 * The handler is `unknown` because one shape has to stand for every channel;
 * `satisfies` below still holds each one to the payload its channel declares.
 * A test that wants to drive a subscription reaches for the recorded argument
 * and casts it to that channel's handler.
 */
type Subscribe = Mock<(handler: unknown) => () => void>

const subscribe = (): Subscribe => vi.fn((_handler: unknown) => vi.fn())

export const harness = {
  info: vi.fn(),

  loadState: vi.fn(),
  // Succeeds unless a test says otherwise: the store awaits the result of
  // every save, so a bare vi.fn()'s `undefined` would reject far from the
  // test that caused it. Failure tests use `mockResolvedValueOnce`.
  saveState: vi.fn(async (_state: unknown): Promise<SaveStateResult> => ({ ok: true })),
  stateLocation: vi.fn(),

  listProfiles: vi.fn(),

  profiles: {
    list: vi.fn(),
    saveCustom: vi.fn(),
    removeCustom: vi.fn()
  },

  git: {
    info: vi.fn(),
    addWorktree: vi.fn(),
    removeWorktree: vi.fn(),
    diffStat: vi.fn(),
    diffRange: vi.fn(),
    checkpoint: vi.fn(),
    checkpoints: vi.fn(),
    restoreCheckpoint: vi.fn(),
    dropCheckpoints: vi.fn(),
    deleteBranch: vi.fn(),
    forge: vi.fn()
  },

  attention: {
    setBadge: vi.fn()
  },

  fs: {
    missingDirs: vi.fn()
  },

  update: {
    state: vi.fn(),
    check: vi.fn(),
    setChannel: vi.fn(),
    install: vi.fn(),
    onChange: subscribe()
  },

  pty: {
    ensure: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    dispose: vi.fn(),
    status: vi.fn(),
    running: vi.fn(),
    onData: subscribe(),
    onExit: subscribe(),
    onQuiet: subscribe(),
    transcript: vi.fn(),
    tail: vi.fn()
  },

  pickDirectory: vi.fn(),
  confirm: vi.fn(),
  saveText: vi.fn(),

  clipboard: {
    read: vi.fn(),
    write: vi.fn()
  },

  voice: {
    keyState: vi.fn(),
    setKey: vi.fn(),
    transcribe: vi.fn(),
    requestMicAccess: vi.fn()
  },

  remote: {
    status: vi.fn(),
    setEnabled: vi.fn(),
    setLan: vi.fn(),
    setAllowTyping: vi.fn(),
    onStatus: subscribe()
  },

  window: {
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
    isMaximized: vi.fn(),
    onMaximizedChange: subscribe(),
    onFullscreenChange: subscribe(),
    onFocusChange: subscribe()
  },

  openExternal: vi.fn(),
  openPath: vi.fn(),
  capture: vi.fn()
} satisfies HarnessApi

window.harness = harness
