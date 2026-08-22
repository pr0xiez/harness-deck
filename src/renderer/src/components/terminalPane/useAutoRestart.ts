import { useEffect, useRef, useState } from 'react'
import { useDeck, type PaneView } from '../../store'
import { decideRestart, type RestartDecision } from '../../restart'

/**
 * Auto-restart, for the panes that asked for it. The timer belongs to the
 * effect below, so an epoch bump — a manual restart, an edit, the pane closing
 * — takes it down with the component that armed it. Same rule dispose() follows
 * in pty.ts: whatever the replaced session had pending is no longer news.
 *
 * Returns the current plan so the exit bar reads this rather than deciding for
 * itself — what it says is what is about to happen.
 */
export function useAutoRestart(pane: PaneView): RestartDecision | null {
  const restartPane = useDeck((s) => s.restartPane)
  const updatePane = useDeck((s) => s.updatePane)
  const [crashPlan, setCrashPlan] = useState<RestartDecision | null>(null)
  const paneId = pane.id
  const autoRestart = Boolean(pane.autoRestart)
  // What the reset rule measures against. The mount rather than the spawn: the
  // two happen together for a pane that is starting, and a pane the window is
  // only now re-attaching to has been up longer than this says — which costs it
  // nothing but a slower return of its restart budget.
  const runStartedAt = useRef(Date.now())

  useEffect(() => {
    if (!autoRestart || pane.status !== 'exited') {
      setCrashPlan(null)
      return
    }
    const plan = decideRestart({
      exitCode: pane.exitCode ?? null,
      ranMs: Date.now() - runStartedAt.current,
      attempts: pane.crashRestarts ?? 0
    })
    setCrashPlan(plan)
    if (plan.action !== 'restart') return
    const timer = window.setTimeout(() => {
      // restartPane clears the count, because by hand is how a crash loop is
      // meant to be broken — so the attempt this one spent goes back after it.
      restartPane(paneId)
      updatePane(paneId, { crashRestarts: plan.attempt })
    }, plan.delayMs)
    return () => window.clearTimeout(timer)
  }, [paneId, autoRestart, pane.status, pane.exitCode, pane.crashRestarts, restartPane, updatePane])

  return crashPlan
}
