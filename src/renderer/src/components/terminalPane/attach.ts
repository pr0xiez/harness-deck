import type { EnsureResult, PaneStatus } from '@shared/types'

/**
 * Drawn above scrollback that came off disk. Without it a pane restored after a
 * quit reads as though the process below it produced that output — which is the
 * one thing a transcript must never be wrong about.
 */
export const PREVIOUS_SESSION_RULE = '\x1b[2m— previous session —\x1b[0m\r\n'

/**
 * What a finished pty:ensure round trip does to the terminal and the store,
 * decided with neither in the room. The rules live here rather than in the
 * attach hook for the same reason decideRestart lives in restart.ts: they are
 * the part worth being sure about, and this is the pane's most safety-sensitive
 * path — see the exit-race note on `adoptStatus`.
 */
export interface AttachPlan {
  /** Painted into the terminal, in order, before queued live output. */
  writes: string[]
  /** False when a newer exit event has already outranked the spawn reply. */
  adoptStatus: boolean
}

export function planAttach(
  result: Pick<EnsureResult, 'status' | 'replay' | 'previousSession'>,
  currentStatus: PaneStatus | undefined
): AttachPlan {
  const writes: string[] = []
  if (result.previousSession) writes.push(PREVIOUS_SESSION_RULE)
  if (result.replay) writes.push(result.replay)
  // A process can die before the spawn reply gets back here, and that exit
  // event is the newer truth — never report it as running again.
  const adoptStatus = !(currentStatus === 'exited' && result.status === 'running')
  return { writes, adoptStatus }
}
