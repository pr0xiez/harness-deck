import { describe, expect, it } from 'vitest'
import {
  digitOf,
  isReservedShortcut,
  matchShortcut,
  SHORTCUTS,
  shortcutLabel,
  type ShortcutKeys
} from './shortcuts'

/** A bare key press; chords are spelled out per test. */
const press = (over: Partial<ShortcutKeys>): ShortcutKeys => ({
  key: '',
  code: '',
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...over
})

/**
 * Key tokens that display text spells differently from the `key`/`code` a
 * real KeyboardEvent would carry for them. A single letter or digit is
 * handled generically below; everything else that appears in a `keys`
 * string across SHORTCUTS needs an entry here.
 */
const KEY_TOKENS: Record<string, Pick<ShortcutKeys, 'key' | 'code'>> = {
  ',': { key: ',', code: 'Comma' },
  '/': { key: '/', code: 'Slash' },
  '=': { key: '=', code: 'Equal' },
  '-': { key: '-', code: 'Minus' },
  '←': { key: 'ArrowLeft', code: 'ArrowLeft' },
  '→': { key: 'ArrowRight', code: 'ArrowRight' },
  Tab: { key: 'Tab', code: 'Tab' },
  'Page Down': { key: 'PageDown', code: 'PageDown' },
  'Page Up': { key: 'PageUp', code: 'PageUp' }
}

/**
 * The inverse of the table's `keys` strings: turns a display chord like
 * 'Ctrl+Shift+T' back into the KeyboardEvent-shaped object its own `when`
 * predicate reads. Used by the round-trip test below so a row's predicate
 * can drift from its own display string and fail loudly, instead of just
 * pinning both to a third, independent, hardcoded copy.
 */
const parseChord = (display: string): ShortcutKeys => {
  const parts = display.split('+')
  const keyToken = parts.pop()
  if (keyToken === undefined) throw new Error(`parseChord: empty chord`)
  let ctrlKey = false
  let shiftKey = false
  let altKey = false
  let metaKey = false
  for (const modifier of parts) {
    if (modifier === 'Ctrl') ctrlKey = true
    else if (modifier === 'Shift') shiftKey = true
    else if (modifier === 'Alt') altKey = true
    else if (modifier === 'Cmd') metaKey = true
    else throw new Error(`parseChord: unknown modifier "${modifier}" in "${display}"`)
  }
  const modifiers = { ctrlKey, shiftKey, altKey, metaKey }
  if (/^[A-Za-z]$/.test(keyToken)) {
    return press({ ...modifiers, key: keyToken.toLowerCase(), code: `Key${keyToken.toUpperCase()}` })
  }
  if (/^[0-9]$/.test(keyToken)) {
    return press({ ...modifiers, key: keyToken, code: `Digit${keyToken}` })
  }
  const known = KEY_TOKENS[keyToken]
  if (!known) throw new Error(`parseChord: unknown key "${keyToken}" in "${display}"`)
  return press({ ...modifiers, ...known })
}

const ctrlShift = (key: string, over: Partial<ShortcutKeys> = {}): ShortcutKeys =>
  press({ key, ctrlKey: true, shiftKey: true, ...over })

describe('one table, no duplicates', () => {
  it('gives every shortcut its own id', () => {
    const ids = SHORTCUTS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('gives every shortcut display keys', () => {
    for (const shortcut of SHORTCUTS) expect(shortcut.keys).toBeTruthy()
  })
})

describe('display text', () => {
  it('derives the label from the same table the matcher reads', () => {
    expect(shortcutLabel('new-pane')).toBe('Ctrl+Shift+T')
    expect(shortcutLabel('open-settings')).toBe('Ctrl+Shift+,')
    expect(shortcutLabel('find-all')).toBe('Ctrl+Shift+Alt+F')
    expect(shortcutLabel('move-pane-left')).toBe('Ctrl+Shift+←')
    expect(shortcutLabel('next-workspace')).toBe('Ctrl+Page Down')
  })

  it('fills a digit into a digit chord, or keeps the placeholder for a range', () => {
    expect(shortcutLabel('focus-pane-by-digit', 3)).toBe('Alt+3')
    expect(shortcutLabel('run-action-by-digit', 1)).toBe('Alt+Shift+1')
    expect(shortcutLabel('workspace-by-digit')).toBe('Ctrl+#')
  })
})

/**
 * The `ctrlShift()` family ties its own `keys` string to its own `when`
 * predicate by construction (one argument drives both), so those rows can't
 * drift from each other. The rest — 'Ctrl+Shift+,' beside a Comma/','/'<'
 * check, 'Ctrl+0' beside a bespoke digit-and-flag check, and so on — spell
 * the same chord out twice in two languages in the same object literal, and
 * nothing before this test related the two spellings. This parses every
 * row's own `keys` back into the event its own `when` reads, so an edited
 * predicate (or an edited `keys` string) that stops agreeing with its
 * sibling fails here, for every row, not just the hand-written ones.
 */
describe('every row answers the event its own keys spell out', () => {
  it('round-trips keys through parseChord and back through matchShortcut', () => {
    for (const shortcut of SHORTCUTS) {
      // Digit rows carry a '#' placeholder; press digit 5 for all of them.
      const display = shortcut.keys.includes('#') ? shortcut.keys.replace('#', '5') : shortcut.keys
      const event = parseChord(display)
      expect(matchShortcut(event, true)?.id, `keys: "${shortcut.keys}"`).toBe(shortcut.id)
    }
  })
})

describe('matching', () => {
  it('matches a plain Ctrl+Shift chord', () => {
    expect(matchShortcut(ctrlShift('p'), false)?.id).toBe('toggle-palette')
  })

  it('treats Cmd as Ctrl, so the same chord works on a Mac', () => {
    expect(matchShortcut(press({ key: 'p', metaKey: true, shiftKey: true }), true)?.id).toBe(
      'toggle-palette'
    )
  })

  it('matches nothing for a plain letter', () => {
    expect(matchShortcut(press({ key: 'a', code: 'KeyA' }), false)).toBeNull()
  })

  /**
   * Shift rewrites punctuation, so settings must open whether the event
   * reports the physical Comma key or the "<" it produced.
   */
  it('matches settings on the physical key and on the rewritten character', () => {
    expect(matchShortcut(ctrlShift('<', { code: 'Comma' }), false)?.id).toBe('open-settings')
    expect(matchShortcut(ctrlShift('<'), false)?.id).toBe('open-settings')
  })

  /**
   * Ordering is load-bearing: with Alt held, find must widen to the whole
   * workspace instead of falling into the single-pane find on the same letter
   * — and it must do so from the physical key, because Option rewrites "f".
   */
  it('sees Ctrl+Shift+Alt+F before Ctrl+Shift+F', () => {
    expect(matchShortcut(ctrlShift('ƒ', { code: 'KeyF', altKey: true }), true)?.id).toBe('find-all')
    expect(matchShortcut(ctrlShift('f', { code: 'KeyF' }), true)?.id).toBe('find-pane')
  })

  /** The two halves of attention routing, one chord apart. */
  it('separates jumping to the next waiting pane from the queue of all of them', () => {
    expect(matchShortcut(ctrlShift('j'), false)?.id).toBe('focus-waiting')
    expect(matchShortcut(ctrlShift('u'), false)?.id).toBe('toggle-waiting-queue')
  })
})

describe('the typing guard', () => {
  it('lets dictation fire from a text box, but not pane management', () => {
    expect(matchShortcut(ctrlShift('m'), false)?.whileTyping).toBe(true)
    expect(matchShortcut(ctrlShift('w'), false)?.whileTyping).toBe(false)
  })
})

describe('digits', () => {
  /**
   * On macOS Option rewrites digits (Option+1 is "¡"), so the digit chords go
   * by the physical key — top row or numpad — never the character.
   */
  it('reads the digit off the physical key', () => {
    expect(digitOf(press({ key: '¡', code: 'Digit1' }))).toBe('1')
    expect(digitOf(press({ key: '3', code: 'Numpad3' }))).toBe('3')
    expect(digitOf(press({ key: '0', code: 'Digit0' }))).toBeNull()
  })

  it('sends Ctrl+digit to a workspace and Alt+digit to a pane', () => {
    expect(matchShortcut(press({ key: '2', code: 'Digit2', ctrlKey: true }), false)?.id).toBe(
      'workspace-by-digit'
    )
    expect(matchShortcut(press({ key: '¡', code: 'Digit1', altKey: true }), true)?.id).toBe(
      'focus-pane-by-digit'
    )
  })

  /**
   * Alt+Shift used to fall into the pane digits, so Alt+Shift+1 focused pane 1.
   * It fires the workspace's first action now, and the pane digits had to learn
   * to exclude Shift for that to be reachable at all.
   */
  it('sends Alt+Shift+digit to an action and leaves Alt+digit on the pane', () => {
    expect(
      matchShortcut(press({ key: '2', code: 'Digit2', altKey: true, shiftKey: true }), false)?.id
    ).toBe('run-action-by-digit')
    expect(matchShortcut(press({ key: '2', code: 'Digit2', altKey: true }), false)?.id).toBe(
      'focus-pane-by-digit'
    )
  })

  it('reserves Alt+Shift+digit, which no Ctrl+Shift rule covers', () => {
    expect(isReservedShortcut(press({ key: '2', code: 'Digit2', altKey: true, shiftKey: true }))).toBe(
      true
    )
  })

  it('keeps Ctrl+Alt+digit on the workspace, as the old handler ordered it', () => {
    expect(
      matchShortcut(press({ key: '1', code: 'Digit1', ctrlKey: true, altKey: true }), false)?.id
    ).toBe('workspace-by-digit')
  })
})

describe('the Mac-only copy', () => {
  const cmdC = press({ key: 'c', code: 'KeyC', metaKey: true })

  it('answers plain Cmd+C only on a Mac', () => {
    expect(matchShortcut(cmdC, true)?.id).toBe('copy-selection-mac')
    expect(matchShortcut(cmdC, false)).toBeNull()
  })

  it('leaves Cmd+Shift+C to the ordinary copy', () => {
    expect(matchShortcut(press({ key: 'C', code: 'KeyC', metaKey: true, shiftKey: true }), true)?.id).toBe(
      'copy-selection'
    )
  })
})

describe('what xterm must not swallow', () => {
  it('reserves every Ctrl+Shift chord, bound or not', () => {
    expect(isReservedShortcut(ctrlShift('w'))).toBe(true)
    expect(isReservedShortcut(ctrlShift('q'))).toBe(true)
  })

  it('reserves the font, tab-cycle, digit and Cmd+C chords', () => {
    expect(isReservedShortcut(press({ key: '=', ctrlKey: true }))).toBe(true)
    expect(isReservedShortcut(press({ key: '0', ctrlKey: true }))).toBe(true)
    expect(isReservedShortcut(press({ key: 'Tab', ctrlKey: true }))).toBe(true)
    expect(isReservedShortcut(press({ key: '5', code: 'Digit5', ctrlKey: true }))).toBe(true)
    expect(isReservedShortcut(press({ key: '¡', code: 'Digit1', altKey: true }))).toBe(true)
    // Reserved without asking the platform, exactly as isAppShortcut was.
    expect(isReservedShortcut(press({ key: 'c', metaKey: true }))).toBe(true)
  })

  /**
   * The workspace-cycling chords are bound but were never reserved — the
   * window's capture-phase handler wins before xterm looks. The set must stay
   * exactly what isAppShortcut answered.
   */
  it('does not reserve Ctrl+PageDown / Ctrl+PageUp', () => {
    expect(matchShortcut(press({ key: 'PageDown', ctrlKey: true }), false)?.id).toBe('next-workspace')
    expect(isReservedShortcut(press({ key: 'PageDown', ctrlKey: true }))).toBe(false)
    expect(isReservedShortcut(press({ key: 'PageUp', ctrlKey: true }))).toBe(false)
  })

  it('leaves plain keys to the terminal', () => {
    expect(isReservedShortcut(press({ key: 'a', code: 'KeyA' }))).toBe(false)
    expect(isReservedShortcut(press({ key: 'c', ctrlKey: true, code: 'KeyC' }))).toBe(false)
  })
})
