/**
 * The "does this count as speech?" math shared by dictation and
 * `--voice-check`: a sample is speech when it clears a threshold derived from
 * this room's measured noise, because mics differ by an order of magnitude and
 * a fixed number suits none of them.
 */

/** Speech threshold floor, and the multiple of measured room noise to clear. */
export const SPEECH_LEVEL_MIN = 0.02
export const SPEECH_LEVEL_MAX = 0.12
export const NOISE_MULTIPLE = 3
/**
 * Room tone is taken as the quietest moment of the recording, not the loudest
 * part of its opening: people start talking before the meter has settled, and
 * treating a first word as "the room" miscalibrates everything after it. Only
 * the first readings, while the microphone spins up, are ignored.
 */
export const FLOOR_SETTLE_MS = 150

export interface SpeechGate {
  /**
   * Feed one meter reading, taken `sinceStartMs` into the recording and
   * `elapsedMs` after the previous one. True when it counted as speech.
   */
  sample: (rms: number, sinceStartMs: number, elapsedMs: number) => boolean
  /** Loudest and quietest levels seen, and how long speech held. */
  readonly peak: number
  readonly noiseFloor: number
  readonly voicedMs: number
}

/** Measures a recording's room noise as it goes and meters speech against it. */
export function createSpeechGate(): SpeechGate {
  let peak = 0
  let noiseFloor = 0
  let voicedMs = 0
  return {
    sample: (rms, sinceStartMs, elapsedMs) => {
      if (rms <= 0 || sinceStartMs <= FLOOR_SETTLE_MS) return false
      peak = Math.max(peak, rms)
      noiseFloor = noiseFloor ? Math.min(noiseFloor, rms) : rms
      const threshold = Math.min(
        SPEECH_LEVEL_MAX,
        Math.max(SPEECH_LEVEL_MIN, noiseFloor * NOISE_MULTIPLE)
      )
      if (rms <= threshold) return false
      voicedMs += elapsedMs
      return true
    },
    get peak() {
      return peak
    },
    get noiseFloor() {
      return noiseFloor
    },
    get voicedMs() {
      return voicedMs
    }
  }
}
