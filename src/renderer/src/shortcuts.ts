/**
 * The global shortcut table — the single source of truth shared by the window
 * handler in App.tsx (which walks it to dispatch) and TerminalPane.tsx (whose
 * key-event handler asks isReservedShortcut() which combos xterm must forward
 * untouched). A shortcut added here is both dispatched and reserved at once;
 * the two sides can no longer drift.
 *
 * Pure key matching only — no store, no DOM — so it runs under plain-Node
 * vitest. What each shortcut *does* stays in App.tsx, bound by `id`.
 */

/** The slice of KeyboardEvent the matchers read. Tests pass plain objects. */
export interface ShortcutKeys {
  readonly key: string
  readonly code: string
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly shiftKey: boolean
  readonly altKey: boolean
}

export type ShortcutId =
  | 'copy-selection-mac'
  | 'open-settings'
  | 'open-help'
  | 'toggle-palette'
  | 'toggle-broadcast'
  | 'toggle-dictation'
  | 'new-workspace'
  | 'find-all'
  | 'new-pane'
  | 'close-pane'
  | 'restart-pane'
  | 'zoom-pane'
  | 'find-pane'
  | 'clear-pane'
  | 'focus-waiting'
  | 'copy-selection'
  | 'paste'
  | 'move-pane-left'
  | 'move-pane-right'
  | 'prev-pane'
  | 'next-pane'
  | 'next-workspace'
  | 'prev-workspace'
  | 'workspace-by-digit'
  | 'font-bigger'
  | 'font-smaller'
  | 'font-reset'
  | 'focus-pane-by-digit'
  | 'send-selection'

export interface Shortcut {
  id: ShortcutId
  /** Fires even while an input, textarea or contenteditable has focus. */
  whileTyping: boolean
  /** Only matched when the app reports darwin. isReservedShortcut ignores
   *  this, deliberately: the reserved set never consulted the platform. */
  macOnly?: boolean
  /**
   * xterm must forward this combo even when the app declines to act on it
   * (see isReservedShortcut). Ctrl+Shift chords are reserved wholesale, so
   * the flag only decides for entries outside that family.
   */
  reserved: boolean
  when: (event: ShortcutKeys) => boolean
}

const ctrl = (e: ShortcutKeys): boolean => e.ctrlKey || e.metaKey

// Shift rewrites punctuation ("," becomes "<"), and on macOS Option rewrites
// digits (Option+1 is "¡") and letters (Option+F is "ƒ"), so those combos
// match on the physical key — and keep matching plain letters on the
// character.
export const digitOf = (e: ShortcutKeys): string | null =>
  /^(?:Digit|Numpad)([1-9])$/.exec(e.code)?.[1] ?? null

const ctrlShift =
  (key: string) =>
  (e: ShortcutKeys): boolean =>
    ctrl(e) && e.shiftKey && e.key.toLowerCase() === key

/**
 * First match wins, so order resolves the overlaps: Ctrl+Shift+Alt+F must be
 * seen before Ctrl+Shift+F, and Ctrl+(Alt+)digit before Alt+digit.
 */
export const SHORTCUTS: readonly Shortcut[] = [
  // macOS: the Edit menu owns Cmd+V, which xterm receives as a real paste
  // event. Cmd+C has to be ours — a pane's selection belongs to xterm and
  // never lands in the DOM where webContents.copy() would find it.
  {
    id: 'copy-selection-mac',
    whileTyping: true,
    macOnly: true,
    reserved: true,
    when: (e) =>
      e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'c'
  },
  {
    id: 'open-settings',
    whileTyping: true,
    reserved: true,
    when: (e) => ctrl(e) && e.shiftKey && (e.code === 'Comma' || e.key === ',' || e.key === '<')
  },
  {
    id: 'open-help',
    whileTyping: true,
    reserved: true,
    when: (e) => ctrl(e) && e.shiftKey && (e.code === 'Slash' || e.key === '/' || e.key === '?')
  },
  { id: 'toggle-palette', whileTyping: true, reserved: true, when: ctrlShift('p') },
  { id: 'toggle-broadcast', whileTyping: true, reserved: true, when: ctrlShift('b') },
  { id: 'send-selection', whileTyping: false, reserved: true, when: ctrlShift('e') },
  // Not typing-guarded, so dictation also works from a text box.
  { id: 'toggle-dictation', whileTyping: true, reserved: true, when: ctrlShift('m') },
  { id: 'new-workspace', whileTyping: true, reserved: true, when: ctrlShift('n') },
  // Alt widens the same find from one pane to the whole workspace. Matched on
  // the physical key, because Option rewrites letters on macOS the way it
  // rewrites digits.
  {
    id: 'find-all',
    whileTyping: false,
    reserved: true,
    when: (e) => ctrl(e) && e.shiftKey && e.altKey && e.code === 'KeyF'
  },
  { id: 'new-pane', whileTyping: false, reserved: true, when: ctrlShift('t') },
  { id: 'close-pane', whileTyping: false, reserved: true, when: ctrlShift('w') },
  { id: 'restart-pane', whileTyping: false, reserved: true, when: ctrlShift('r') },
  { id: 'zoom-pane', whileTyping: false, reserved: true, when: ctrlShift('z') },
  { id: 'find-pane', whileTyping: false, reserved: true, when: ctrlShift('f') },
  { id: 'clear-pane', whileTyping: false, reserved: true, when: ctrlShift('k') },
  { id: 'focus-waiting', whileTyping: false, reserved: true, when: ctrlShift('j') },
  { id: 'copy-selection', whileTyping: false, reserved: true, when: ctrlShift('c') },
  { id: 'paste', whileTyping: false, reserved: true, when: ctrlShift('v') },
  { id: 'move-pane-left', whileTyping: false, reserved: true, when: ctrlShift('arrowleft') },
  { id: 'move-pane-right', whileTyping: false, reserved: true, when: ctrlShift('arrowright') },
  { id: 'prev-pane', whileTyping: false, reserved: true, when: ctrlShift('tab') },
  {
    id: 'next-pane',
    whileTyping: false,
    reserved: true,
    when: (e) => ctrl(e) && !e.shiftKey && e.key.toLowerCase() === 'tab'
  },
  // The two workspace-cycling chords were never in the reserved set: the
  // window's capture-phase handler consumes them before xterm can look, so
  // nothing depends on the flag. Kept false to keep the set exactly as it was.
  {
    id: 'next-workspace',
    whileTyping: false,
    reserved: false,
    when: (e) => ctrl(e) && !e.shiftKey && e.key.toLowerCase() === 'pagedown'
  },
  {
    id: 'prev-workspace',
    whileTyping: false,
    reserved: false,
    when: (e) => ctrl(e) && !e.shiftKey && e.key.toLowerCase() === 'pageup'
  },
  {
    id: 'workspace-by-digit',
    whileTyping: false,
    reserved: true,
    when: (e) => ctrl(e) && !e.shiftKey && digitOf(e) !== null
  },
  {
    id: 'font-bigger',
    whileTyping: false,
    reserved: true,
    when: (e) =>
      ctrl(e) &&
      !e.shiftKey &&
      (['=', '+'].includes(e.key) || e.code === 'Equal' || e.code === 'NumpadAdd')
  },
  {
    id: 'font-smaller',
    whileTyping: false,
    reserved: true,
    when: (e) =>
      ctrl(e) &&
      !e.shiftKey &&
      (['-', '_'].includes(e.key) || e.code === 'Minus' || e.code === 'NumpadSubtract')
  },
  {
    id: 'font-reset',
    whileTyping: false,
    reserved: true,
    when: (e) => ctrl(e) && !e.shiftKey && e.key === '0'
  },
  {
    id: 'focus-pane-by-digit',
    whileTyping: false,
    reserved: true,
    when: (e) => e.altKey && digitOf(e) !== null
  }
]

/** First matching entry, or null. Order in SHORTCUTS is the tie-breaker. */
export function matchShortcut(event: ShortcutKeys, isMac: boolean): Shortcut | null {
  for (const shortcut of SHORTCUTS) {
    if (shortcut.macOnly && !isMac) continue
    if (shortcut.when(event)) return shortcut
  }
  return null
}

/** Reserved for the app: xterm must not swallow these (see TerminalPane). */
export function isReservedShortcut(event: ShortcutKeys): boolean {
  // Every Ctrl+Shift chord is reserved wholesale — the help dialog promises
  // terminals every *plain* key combination, and the blanket rule means a new
  // Ctrl+Shift binding can never be swallowed for want of a flag.
  if (ctrl(event) && event.shiftKey) return true
  return SHORTCUTS.some((shortcut) => shortcut.reserved && shortcut.when(event))
}
