/**
 * When a pane that has opted in comes back by itself, and when it stops trying.
 * The rules live here rather than in the pane component because they are the
 * part worth being sure about, and a terminal is a poor place to be sure in.
 * See HD-11.
 */

/** Restarts one crash loop is allowed before the pane is left where it died. */
export const RESTART_CAP = 3

/**
 * The wait before each attempt. A process that died on a port it does not have
 * yet wants a moment; one that dies the instant it starts must not be respawned
 * in a tight loop. By the third wait the pane has had twenty seconds to settle.
 */
export const RESTART_BACKOFF_MS = [1_000, 5_000, 15_000]

/**
 * A run that lasted this long was not part of the loop before it, so the budget
 * starts again. Without the rule a pane that dies once a day spends its three
 * attempts over three days and then stops coming back, with nothing on screen
 * to say why.
 */
export const HEALTHY_RUN_MS = 60_000

export interface CrashedRun {
  /** What the process reported on the way out. */
  exitCode: number | null
  /** How long the run that just ended lasted. */
  ranMs: number
  /** Restarts already spent on the loop this exit belongs to. */
  attempts: number
}

export type RestartDecision =
  /** Nothing to answer: the pane stays exactly where it is. */
  | { action: 'leave' }
  | { action: 'restart'; attempt: number; delayMs: number }
  /** The budget is spent. Only a person starts this pane now. */
  | { action: 'halt' }

export function decideRestart({ exitCode, ranMs, attempts }: CrashedRun): RestartDecision {
  // Zero is someone typing `exit`. It is also what node-pty reports for a
  // process a signal took down — Ctrl+C, or the SIGHUP behind "stop process" —
  // because the code and the signal are separate fields and only one of them
  // is set. Every one of those is a person stopping the pane on purpose, and
  // a pane that argues back is worse than no auto-restart at all.
  if (exitCode == null || exitCode === 0) return { action: 'leave' }
  const spent = ranMs >= HEALTHY_RUN_MS ? 0 : Math.max(0, attempts)
  if (spent >= RESTART_CAP) return { action: 'halt' }
  return { action: 'restart', attempt: spent + 1, delayMs: RESTART_BACKOFF_MS[spent] }
}
