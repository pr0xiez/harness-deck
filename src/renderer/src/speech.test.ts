import { describe, expect, it } from 'vitest'
import {
  createSpeechGate,
  FLOOR_SETTLE_MS,
  NOISE_MULTIPLE,
  SPEECH_LEVEL_MAX,
  SPEECH_LEVEL_MIN
} from './speech'

/** A reading comfortably after the microphone has spun up. */
const SETTLED = FLOOR_SETTLE_MS + 100

describe('the settling window', () => {
  it('ignores readings while the microphone spins up', () => {
    const gate = createSpeechGate()
    expect(gate.sample(0.5, FLOOR_SETTLE_MS, 16)).toBe(false)
    expect(gate.peak).toBe(0)
    expect(gate.noiseFloor).toBe(0)
    expect(gate.voicedMs).toBe(0)
  })

  it('ignores a dead meter, which would otherwise read as a silent room', () => {
    const gate = createSpeechGate()
    expect(gate.sample(0, SETTLED, 16)).toBe(false)
    expect(gate.noiseFloor).toBe(0)
  })
})

describe('peak and noise floor', () => {
  it('keeps the loudest and quietest levels seen', () => {
    const gate = createSpeechGate()
    gate.sample(0.03, SETTLED, 16)
    gate.sample(0.09, SETTLED + 16, 16)
    gate.sample(0.05, SETTLED + 32, 16)
    expect(gate.peak).toBe(0.09)
    expect(gate.noiseFloor).toBe(0.03)
  })

  it('takes the first settled reading as the floor, not zero', () => {
    const gate = createSpeechGate()
    gate.sample(0.04, SETTLED, 16)
    expect(gate.noiseFloor).toBe(0.04)
  })

  it('recalibrates when a quieter moment comes along', () => {
    const gate = createSpeechGate()
    // A first reading of 0.015 puts the bar at 0.045; 0.05 clears it.
    gate.sample(0.015, SETTLED, 16)
    expect(gate.sample(0.05, SETTLED + 16, 16)).toBe(true)
    // A truly quiet moment drops the floor to 0.005, clamping the bar down to
    // SPEECH_LEVEL_MIN — now 0.03 counts where it would not have before.
    gate.sample(0.005, SETTLED + 32, 16)
    expect(gate.sample(0.03, SETTLED + 48, 16)).toBe(true)
  })
})

describe('the speech threshold', () => {
  it('is a multiple of the room noise', () => {
    const gate = createSpeechGate()
    gate.sample(0.01, SETTLED, 16)
    const bar = 0.01 * NOISE_MULTIPLE
    expect(gate.sample(bar, SETTLED + 16, 16)).toBe(false)
    expect(gate.sample(bar + 0.001, SETTLED + 32, 16)).toBe(true)
  })

  it('never drops below SPEECH_LEVEL_MIN in a silent room', () => {
    const gate = createSpeechGate()
    // Floor 0.001 would put the bar at 0.003 — quiet breathing would pass.
    gate.sample(0.001, SETTLED, 16)
    expect(gate.sample(SPEECH_LEVEL_MIN, SETTLED + 16, 16)).toBe(false)
    expect(gate.sample(SPEECH_LEVEL_MIN + 0.001, SETTLED + 32, 16)).toBe(true)
  })

  it('never rises above SPEECH_LEVEL_MAX in a loud room', () => {
    const gate = createSpeechGate()
    // Floor 0.05 would put the bar at 0.15 — a normal voice could never clear it.
    gate.sample(0.05, SETTLED, 16)
    expect(gate.sample(SPEECH_LEVEL_MAX, SETTLED + 16, 16)).toBe(false)
    expect(gate.sample(SPEECH_LEVEL_MAX + 0.001, SETTLED + 32, 16)).toBe(true)
  })
})

describe('voiced time', () => {
  it('accumulates the elapsed time of speech and nothing else', () => {
    const gate = createSpeechGate()
    gate.sample(0.01, SETTLED, 16)
    gate.sample(0.1, SETTLED + 16, 16)
    gate.sample(0.01, SETTLED + 32, 16)
    gate.sample(0.1, SETTLED + 82, 50)
    expect(gate.voicedMs).toBe(66)
  })

  it('stays at zero when nothing clears the bar', () => {
    const gate = createSpeechGate()
    gate.sample(0.01, SETTLED, 16)
    gate.sample(0.02, SETTLED + 16, 16)
    expect(gate.voicedMs).toBe(0)
  })
})
