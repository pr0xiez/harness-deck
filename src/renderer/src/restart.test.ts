import { describe, expect, it } from 'vitest'
import {
  decideRestart,
  HEALTHY_RUN_MS,
  RESTART_BACKOFF_MS,
  RESTART_CAP,
  type CrashedRun
} from './restart'

/** A crash: died badly, died quickly, and nothing has been spent on it yet. */
const crash = (over: Partial<CrashedRun> = {}): CrashedRun => ({
  exitCode: 1,
  ranMs: 200,
  attempts: 0,
  ...over
})

describe('exits worth answering', () => {
  it('brings a pane back when its process died with a code', () => {
    expect(decideRestart(crash())).toEqual({
      action: 'restart',
      attempt: 1,
      delayMs: RESTART_BACKOFF_MS[0]
    })
  })

  /**
   * The one that makes this a disaster if it is wrong: a shell you typed
   * `exit` into must stay closed, and so must an agent you stopped with
   * Ctrl+C — which node-pty reports as code 0 with the signal alongside.
   */
  it('leaves a clean exit alone', () => {
    expect(decideRestart(crash({ exitCode: 0 }))).toEqual({ action: 'leave' })
  })

  it('leaves an exit it was told nothing about alone', () => {
    expect(decideRestart(crash({ exitCode: null }))).toEqual({ action: 'leave' })
  })

  it('answers a long run that ended badly as readily as a short one', () => {
    expect(decideRestart(crash({ ranMs: HEALTHY_RUN_MS * 10 }))).toMatchObject({
      action: 'restart',
      attempt: 1
    })
  })
})

describe('backoff', () => {
  it('waits longer before each attempt', () => {
    const waits = [0, 1, 2].map(
      (attempts) => (decideRestart(crash({ attempts })) as { delayMs: number }).delayMs
    )

    expect(waits).toEqual(RESTART_BACKOFF_MS)
    expect(waits).toEqual([...waits].sort((a, b) => a - b))
  })

  it('counts the attempts up as it goes', () => {
    expect(decideRestart(crash({ attempts: 1 }))).toMatchObject({ action: 'restart', attempt: 2 })
    expect(decideRestart(crash({ attempts: 2 }))).toMatchObject({ action: 'restart', attempt: 3 })
  })
})

describe('the cap', () => {
  it('stops once the budget is spent', () => {
    expect(decideRestart(crash({ attempts: RESTART_CAP }))).toEqual({ action: 'halt' })
  })

  it('stays stopped however often it is asked again', () => {
    expect(decideRestart(crash({ attempts: RESTART_CAP + 5 }))).toEqual({ action: 'halt' })
  })

  it('never schedules a fourth attempt', () => {
    const attempts = [0, 1, 2, 3, 4, 5].map((n) => decideRestart(crash({ attempts: n })))

    expect(attempts.filter((d) => d.action === 'restart')).toHaveLength(RESTART_CAP)
  })
})

/**
 * A pane that dies once a day is not in a crash loop, and must not spend its
 * three attempts over three days and then quietly stop coming back.
 */
describe('the reset', () => {
  it('hands the budget back after a run that stayed up', () => {
    expect(decideRestart(crash({ attempts: RESTART_CAP, ranMs: HEALTHY_RUN_MS }))).toEqual({
      action: 'restart',
      attempt: 1,
      delayMs: RESTART_BACKOFF_MS[0]
    })
  })

  it('holds the budget through a run that did not', () => {
    expect(decideRestart(crash({ attempts: RESTART_CAP, ranMs: HEALTHY_RUN_MS - 1 }))).toEqual({
      action: 'halt'
    })
  })

  it('does not reset a clean exit into a restart', () => {
    expect(decideRestart(crash({ exitCode: 0, ranMs: HEALTHY_RUN_MS * 100 }))).toEqual({
      action: 'leave'
    })
  })

  it('survives a count that came back from somewhere impossible', () => {
    expect(decideRestart(crash({ attempts: -3 }))).toMatchObject({ action: 'restart', attempt: 1 })
  })
})
