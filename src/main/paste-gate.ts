/**
 * The user-gesture gate in front of `clipboard:read` (issue #28). The app's
 * permission handler already refuses the web `clipboard-read` permission, so an
 * IPC channel that answered unconditionally was a side door around it: any code
 * in the renderer main world could poll the OS clipboard at leisure. The main
 * process is the only side that sees real keyboard input (`before-input-event`,
 * which renderer code cannot forge), so the paste chord is recorded here and
 * the handler only answers within a short window of it.
 *
 * Pure key matching and a clock — no Electron — so it runs under plain-Node
 * vitest. The wiring lives in index.ts.
 */

/** The slice of Electron.Input the gate reads. Tests pass plain objects. */
export interface PasteInput {
  readonly type: string
  readonly key: string
  readonly control: boolean
  readonly meta: boolean
  readonly shift: boolean
}

/**
 * How long after the chord a read still counts as servicing it. Generous
 * enough for a busy renderer to get around to asking; far too short to be
 * worth anything to a poller, which would need the user mid-paste.
 */
export const PASTE_WINDOW_MS = 1500

/**
 * The renderer's paste chord — Ctrl/Cmd+Shift+V, mirroring the `paste` entry
 * in shortcuts.ts. macOS Cmd+V goes through the Edit menu's paste role, which
 * pastes natively and never touches the IPC channel this gate guards.
 */
export function isPasteChord(input: PasteInput): boolean {
  return (
    input.type === 'keyDown' &&
    input.shift &&
    (input.control || input.meta) &&
    input.key.toLowerCase() === 'v'
  )
}

export class PasteGate {
  /** When the chord was last seen. -Infinity, not 0: never seen must never
   *  pass the freshness check, whatever the clock counts from. */
  private lastChordAt = -Infinity

  constructor(private readonly now: () => number = Date.now) {}

  /** Feed every `before-input-event`; only the paste chord is kept. */
  observe(input: PasteInput): void {
    if (isPasteChord(input)) this.lastChordAt = this.now()
  }

  /** True while a recorded chord is fresh enough to honor a clipboard read. */
  allows(): boolean {
    return this.now() - this.lastChordAt <= PASTE_WINDOW_MS
  }
}
