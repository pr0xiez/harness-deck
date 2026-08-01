import { describe, expect, it } from 'vitest'
import { heardSomething } from './voice'

/**
 * The silence gate, at its edges.
 *
 * This is the last thing between a recording and a paid transcription, and the
 * expensive failure is not a false negative — it is a chat model handed silence,
 * inventing a plausible prompt, and that text being typed into a running agent.
 * So every case below sits on a boundary rather than comfortably inside one.
 *
 * The four constants the gate is built from are module-private in `voice.ts`,
 * and exporting them only to be read back here would prove nothing — a test
 * that recomputes the threshold from the same numbers cannot disagree with it.
 * These are copied instead, deliberately, so retuning the gate has to come past
 * this file and say which of the cases below it meant to change.
 */
const AUDIBLE_LEVEL_MIN = 0.03
const AUDIBLE_LEVEL_MAX = 0.08
const MIN_VOICED_MS = 150

describe('heardSomething', () => {
  it('lets a word spoken in a quiet room through', () => {
    expect(heardSomething({ peak: 0.21, noiseFloor: 0.002, voicedMs: 900 })).toBe(true)
  })

  /** A fan or a busy café: loud all the way through, and never louder for a word. */
  it('holds back a room whose peak barely clears its own noise', () => {
    expect(heardSomething({ peak: 0.052, noiseFloor: 0.05, voicedMs: 2500 })).toBe(false)
  })

  /**
   * A chair creak or the click of the stream opening reads as loud as a word,
   * so loudness alone can never be enough.
   */
  it('holds back a sound too short to be a word, however loud it was', () => {
    expect(
      heardSomething({ peak: 0.6, noiseFloor: 0.002, voicedMs: MIN_VOICED_MS - 1 })
    ).toBe(false)
  })

  /** One syllable is a real prompt — the minimum is included, not excluded. */
  it('accepts speech that lasted exactly the minimum', () => {
    expect(heardSomething({ peak: 0.6, noiseFloor: 0.002, voicedMs: MIN_VOICED_MS })).toBe(true)
  })

  /**
   * The level comparison is strict the other way: sitting exactly on the
   * threshold is the room, not a voice, and only rising above it counts.
   */
  it('holds back a peak that only reaches the threshold, and passes one just over', () => {
    const room = { noiseFloor: 0.001, voicedMs: 900 }

    expect(heardSomething({ ...room, peak: AUDIBLE_LEVEL_MIN })).toBe(false)
    expect(heardSomething({ ...room, peak: AUDIBLE_LEVEL_MIN + 0.001 })).toBe(true)
  })

  /**
   * Five times a loud room would put the bar at 0.5 and nobody could shout over
   * it, so the threshold stops climbing — dictating next to an air conditioner
   * still works.
   */
  it('lets a raised voice through a loud room, because the threshold stops climbing', () => {
    expect(heardSomething({ peak: 0.3, noiseFloor: 0.1, voicedMs: 900 })).toBe(true)
    expect(heardSomething({ peak: AUDIBLE_LEVEL_MAX, noiseFloor: 0.1, voicedMs: 900 })).toBe(false)
  })

  /**
   * The mirror of that: five times near-silence is a bar anything clears, so a
   * rustle in a silent room would otherwise be transcribed as speech.
   */
  it('holds back a faint noise in a silent room, because the threshold has a floor', () => {
    expect(heardSomething({ peak: 0.02, noiseFloor: 0.0001, voicedMs: 3000 })).toBe(false)
  })

  /** A muted or wrong input device reads as flat zero for the whole recording. */
  it('holds back a microphone that recorded nothing at all', () => {
    expect(heardSomething({ peak: 0, noiseFloor: 0, voicedMs: 0 })).toBe(false)
  })
})
