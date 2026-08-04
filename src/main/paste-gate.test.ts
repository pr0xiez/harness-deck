import { describe, expect, it } from 'vitest'
import { isPasteChord, PASTE_WINDOW_MS, PasteGate, type PasteInput } from './paste-gate'

/**
 * The gate exists so that `clipboard:read` is worthless to anything that is
 * not servicing an actual paste (issue #28), so the behaviour that matters is
 * the refusals: before any chord, after the window has lapsed, and for every
 * key that is not the chord. The clock is injected — real time has no place in
 * a freshness test.
 */

/** A bare key event; chords are spelled out per test. */
const press = (over: Partial<PasteInput>): PasteInput => ({
  type: 'keyDown',
  key: '',
  control: false,
  meta: false,
  shift: false,
  ...over
})

const chord = (over: Partial<PasteInput> = {}): PasteInput =>
  press({ key: 'v', control: true, shift: true, ...over })

/** A gate on a hand-cranked clock. */
function gated(): { gate: PasteGate; tick: (ms: number) => void } {
  let now = 1_000_000
  return {
    gate: new PasteGate(() => now),
    tick: (ms) => {
      now += ms
    }
  }
}

describe('the chord', () => {
  it('matches Ctrl+Shift+V on keyDown', () => {
    expect(isPasteChord(chord())).toBe(true)
  })

  it('treats Cmd as Ctrl, so the same chord works on a Mac', () => {
    expect(isPasteChord(chord({ control: false, meta: true }))).toBe(true)
  })

  it('matches whatever case the key reports', () => {
    expect(isPasteChord(chord({ key: 'V' }))).toBe(true)
  })

  it('matches nothing short of the full chord', () => {
    expect(isPasteChord(press({ key: 'v' }))).toBe(false)
    expect(isPasteChord(chord({ shift: false }))).toBe(false)
    expect(isPasteChord(chord({ control: false }))).toBe(false)
    expect(isPasteChord(chord({ key: 'c' }))).toBe(false)
  })

  it('ignores the keyUp half of the chord', () => {
    expect(isPasteChord(chord({ type: 'keyUp' }))).toBe(false)
  })
})

describe('the gate', () => {
  it('refuses before any chord has ever been seen', () => {
    expect(gated().gate.allows()).toBe(false)
  })

  it('allows a read that follows the chord', () => {
    const { gate, tick } = gated()
    gate.observe(chord())
    tick(50)
    expect(gate.allows()).toBe(true)
  })

  it('refuses once the window has lapsed', () => {
    const { gate, tick } = gated()
    gate.observe(chord())
    tick(PASTE_WINDOW_MS + 1)
    expect(gate.allows()).toBe(false)
  })

  it('is not opened by other keys', () => {
    const { gate } = gated()
    gate.observe(press({ key: 'a' }))
    gate.observe(chord({ key: 'c' }))
    expect(gate.allows()).toBe(false)
  })

  it('re-arms on every chord', () => {
    const { gate, tick } = gated()
    gate.observe(chord())
    tick(PASTE_WINDOW_MS + 1)
    expect(gate.allows()).toBe(false)
    gate.observe(chord())
    expect(gate.allows()).toBe(true)
  })
})
