import { describe, expect, it } from 'vitest'
import {
  digitOf,
  isReservedShortcut,
  matchShortcut,
  SHORTCUTS,
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

const ctrlShift = (key: string, over: Partial<ShortcutKeys> = {}): ShortcutKeys =>
  press({ key, ctrlKey: true, shiftKey: true, ...over })

describe('one table, no duplicates', () => {
  it('gives every shortcut its own id', () => {
    const ids = SHORTCUTS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
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
