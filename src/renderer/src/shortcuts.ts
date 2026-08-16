/**
 * The global shortcut table — the single source of truth shared by the window
 * handler in App.tsx (which walks it to dispatch), TerminalPane.tsx (whose
 * key-event handler asks isReservedShortcut() which combos xterm must forward
 * untouched), and every place that *prints* a chord — the help dialog, the
 * palette hints and the tooltips all go through shortcutLabel(). A shortcut
 * added here is dispatched, reserved and displayed at once; the sides can no
 * longer drift.
 *
 * Pure key matching and strings only — no store, no DOM — so it runs under
 * plain-Node vitest. What each shortcut *does* stays in App.tsx, bound by `id`.
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

export interface Shortcut {
  /**
   * A plain string here, not ShortcutId — ShortcutId is derived *from* this
   * table below (`(typeof SHORTCUTS)[number]['id']`), so a row can't exist
   * without contributing its id to the union, and a ShortcutId can't exist
   * without a row backing it.
   */
  id: string
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
  /**
   * What the UI prints for the chord, in the Windows/Linux spelling
   * ('Ctrl+Shift+T') — HelpDialog rewrites it for macOS. Digit shortcuts carry
   * a '#' where the digit goes; shortcutLabel() fills it in.
   */
  keys: string
  when: (event: ShortcutKeys) => boolean
}

const ctrl = (e: ShortcutKeys): boolean => e.ctrlKey || e.metaKey

// Shift rewrites punctuation ("," becomes "<"), and on macOS Option rewrites
// digits (Option+1 is "¡") and letters (Option+F is "ƒ"), so those combos
// match on the physical key — and keep matching plain letters on the
// character.
export const digitOf = (e: ShortcutKeys): string | null =>
  /^(?:Digit|Numpad)([1-9])$/.exec(e.code)?.[1] ?? null

// One argument drives both the matcher and the display, so the chord a user
// reads is the chord the matcher answers. `shown` covers the keys whose
// display is not their uppercased event name ('arrowleft' prints as '←').
const ctrlShift = (key: string, shown = key.toUpperCase()): Pick<Shortcut, 'keys' | 'when'> => ({
  keys: `Ctrl+Shift+${shown}`,
  when: (e) => ctrl(e) && e.shiftKey && e.key.toLowerCase() === key
})

/**
 * First match wins, so order resolves the overlaps: Ctrl+Shift+Alt+F must be
 * seen before Ctrl+Shift+F, and Ctrl+(Alt+)digit before Alt+digit.
 *
 * `as const satisfies` rather than a `: readonly Shortcut[]` annotation: the
 * annotation would widen every `id` to `Shortcut['id']` (plain `string`)
 * before ShortcutId gets a chance to read it below, so a row deleted here
 * would silently vanish from the union instead of breaking whoever still
 * dispatches on it.
 */
export const SHORTCUTS = [
  // macOS: the Edit menu owns Cmd+V, which xterm receives as a real paste
  // event. Cmd+C has to be ours — a pane's selection belongs to xterm and
  // never lands in the DOM where webContents.copy() would find it.
  {
    id: 'copy-selection-mac',
    whileTyping: true,
    macOnly: true,
    reserved: true,
    keys: 'Cmd+C',
    when: (e) =>
      e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'c'
  },
  {
    id: 'open-settings',
    whileTyping: true,
    reserved: true,
    keys: 'Ctrl+Shift+,',
    when: (e) => ctrl(e) && e.shiftKey && (e.code === 'Comma' || e.key === ',' || e.key === '<')
  },
  {
    id: 'open-help',
    whileTyping: true,
    reserved: true,
    keys: 'Ctrl+Shift+/',
    when: (e) => ctrl(e) && e.shiftKey && (e.code === 'Slash' || e.key === '/' || e.key === '?')
  },
  { id: 'toggle-palette', whileTyping: true, reserved: true, ...ctrlShift('p') },
  { id: 'toggle-broadcast', whileTyping: true, reserved: true, ...ctrlShift('b') },
  { id: 'send-selection', whileTyping: false, reserved: true, ...ctrlShift('e') },
  // Not typing-guarded, so dictation also works from a text box.
  { id: 'toggle-dictation', whileTyping: true, reserved: true, ...ctrlShift('m') },
  { id: 'new-workspace', whileTyping: true, reserved: true, ...ctrlShift('n') },
  // Alt widens the same find from one pane to the whole workspace. Matched on
  // the physical key, because Option rewrites letters on macOS the way it
  // rewrites digits.
  {
    id: 'find-all',
    whileTyping: false,
    reserved: true,
    keys: 'Ctrl+Shift+Alt+F',
    when: (e) => ctrl(e) && e.shiftKey && e.altKey && e.code === 'KeyF'
  },
  { id: 'new-pane', whileTyping: false, reserved: true, ...ctrlShift('t') },
  { id: 'close-pane', whileTyping: false, reserved: true, ...ctrlShift('w') },
  { id: 'restart-pane', whileTyping: false, reserved: true, ...ctrlShift('r') },
  { id: 'zoom-pane', whileTyping: false, reserved: true, ...ctrlShift('z') },
  { id: 'find-pane', whileTyping: false, reserved: true, ...ctrlShift('f') },
  { id: 'clear-pane', whileTyping: false, reserved: true, ...ctrlShift('k') },
  { id: 'focus-waiting', whileTyping: false, reserved: true, ...ctrlShift('j') },
  // Typing-guarded like its neighbour, and the same chord closes the overlay:
  // the queue itself is not a text box, so it still gets the key back.
  { id: 'toggle-waiting-queue', whileTyping: false, reserved: true, ...ctrlShift('u') },
  { id: 'copy-selection', whileTyping: false, reserved: true, ...ctrlShift('c') },
  { id: 'paste', whileTyping: false, reserved: true, ...ctrlShift('v') },
  { id: 'move-pane-left', whileTyping: false, reserved: true, ...ctrlShift('arrowleft', '←') },
  { id: 'move-pane-right', whileTyping: false, reserved: true, ...ctrlShift('arrowright', '→') },
  { id: 'prev-pane', whileTyping: false, reserved: true, ...ctrlShift('tab', 'Tab') },
  {
    id: 'next-pane',
    whileTyping: false,
    reserved: true,
    keys: 'Ctrl+Tab',
    when: (e) => ctrl(e) && !e.shiftKey && e.key.toLowerCase() === 'tab'
  },
  // The two workspace-cycling chords were never in the reserved set: the
  // window's capture-phase handler consumes them before xterm can look, so
  // nothing depends on the flag. Kept false to keep the set exactly as it was.
  {
    id: 'next-workspace',
    whileTyping: false,
    reserved: false,
    keys: 'Ctrl+Page Down',
    when: (e) => ctrl(e) && !e.shiftKey && e.key.toLowerCase() === 'pagedown'
  },
  {
    id: 'prev-workspace',
    whileTyping: false,
    reserved: false,
    keys: 'Ctrl+Page Up',
    when: (e) => ctrl(e) && !e.shiftKey && e.key.toLowerCase() === 'pageup'
  },
  {
    id: 'workspace-by-digit',
    whileTyping: false,
    reserved: true,
    keys: 'Ctrl+#',
    when: (e) => ctrl(e) && !e.shiftKey && digitOf(e) !== null
  },
  {
    id: 'font-bigger',
    whileTyping: false,
    reserved: true,
    keys: 'Ctrl+=',
    when: (e) =>
      ctrl(e) &&
      !e.shiftKey &&
      (['=', '+'].includes(e.key) || e.code === 'Equal' || e.code === 'NumpadAdd')
  },
  {
    id: 'font-smaller',
    whileTyping: false,
    reserved: true,
    keys: 'Ctrl+-',
    when: (e) =>
      ctrl(e) &&
      !e.shiftKey &&
      (['-', '_'].includes(e.key) || e.code === 'Minus' || e.code === 'NumpadSubtract')
  },
  {
    id: 'font-reset',
    whileTyping: false,
    reserved: true,
    keys: 'Ctrl+0',
    when: (e) => ctrl(e) && !e.shiftKey && e.key === '0'
  },
  // Before the pane digits, and the reason they now exclude Shift: Alt+Shift
  // used to fall into them, so Alt+Shift+1 focused pane 1. Reserved by flag
  // rather than by family — the blanket rule below covers Ctrl+Shift only, and
  // without it xterm would eat the chord.
  {
    id: 'run-action-by-digit',
    whileTyping: false,
    reserved: true,
    keys: 'Alt+Shift+#',
    when: (e) => e.altKey && e.shiftKey && digitOf(e) !== null
  },
  {
    id: 'focus-pane-by-digit',
    whileTyping: false,
    reserved: true,
    keys: 'Alt+#',
    when: (e) => e.altKey && !e.shiftKey && digitOf(e) !== null
  }
] as const satisfies readonly Shortcut[]

/**
 * Every id a row in SHORTCUTS carries — derived *from* the table above, not
 * hand-maintained beside it. A row can't be deleted or renamed without every
 * caller of that id (App.tsx's dispatch Record, shortcutLabel callers, this
 * type's other readers) failing to typecheck: there is no way for a
 * ShortcutId to exist without a row backing it.
 */
export type ShortcutId = (typeof SHORTCUTS)[number]['id']

/** The three ids whose `keys` carries a '#' digit placeholder. */
export type DigitShortcutId = 'workspace-by-digit' | 'run-action-by-digit' | 'focus-pane-by-digit'

/**
 * The display text for a shortcut, straight off the table the matcher reads —
 * the help dialog, the palette hints and the tooltips all print this, so a
 * chord on screen can no longer drift from the chord that fires. Digit
 * shortcuts hold a '#': pass the digit to name one binding ('Alt+3'), or leave
 * it out to keep the placeholder for a range display ('Alt+1 … Alt+9'). The
 * overloads make both a stray digit on an ordinary shortcut and a missing
 * digit on a range display a compile error rather than a silent no-op.
 */
export function shortcutLabel(id: DigitShortcutId, digit?: number): string
export function shortcutLabel(id: Exclude<ShortcutId, DigitShortcutId>, digit?: undefined): string
export function shortcutLabel(id: ShortcutId, digit?: number): string {
  // Every ShortcutId has exactly one row — guaranteed by construction, since
  // ShortcutId is derived from SHORTCUTS itself, not maintained beside it.
  const keys = SHORTCUTS.find((shortcut) => shortcut.id === id)!.keys
  return digit === undefined ? keys : keys.replace('#', String(digit))
}

/**
 * Whether a row is macOS-only. Routed through the wider `Shortcut` interface
 * rather than read straight off the union `SHORTCUTS` produces: most rows
 * never set `macOnly` at all, so the inferred literal type of each row omits
 * the property entirely rather than typing it `undefined`, and a union where
 * only one member has a given key can't have that key read off it directly.
 */
const isMacOnly = (shortcut: Shortcut): boolean => Boolean(shortcut.macOnly)

/**
 * First matching entry, or null. Order in SHORTCUTS is the tie-breaker.
 * Returns `(typeof SHORTCUTS)[number]` rather than the wider `Shortcut` so
 * `.id` on the result stays a ShortcutId literal for callers like App.tsx's
 * `Record<ShortcutId, …>` dispatch, instead of widening to `string`.
 */
export function matchShortcut(
  event: ShortcutKeys,
  isMac: boolean
): (typeof SHORTCUTS)[number] | null {
  for (const shortcut of SHORTCUTS) {
    if (isMacOnly(shortcut) && !isMac) continue
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
