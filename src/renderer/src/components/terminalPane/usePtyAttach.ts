import { useEffect, type RefObject } from 'react'
import { useDeck, type PaneView } from '../../store'
import type { TerminalHandle } from '../../terminals'
import { planAttach } from './attach'

const api = window.harness

/**
 * Starts (or re-attaches to) the pane's process, once per terminal instance.
 * What the round trip is allowed to paint and report is decided by planAttach;
 * this hook owns only the lifecycle around it — the once-per-epoch guard and
 * the in-flight cancellation for a restart that tears the terminal down while
 * the spawn is still on the wire.
 */
export function usePtyAttach(
  pane: PaneView,
  active: boolean,
  handleRef: RefObject<TerminalHandle | null>,
  spawnedRef: RefObject<boolean>
): void {
  const setPaneStatus = useDeck((s) => s.setPaneStatus)
  const paneId = pane.id

  useEffect(() => {
    const handle = handleRef.current
    if (!handle || spawnedRef.current) return
    if (!pane.autostart) return
    spawnedRef.current = true

    let cancelled = false
    const { term } = handle
    void (async () => {
      const result = await api.pty.ensure(
        {
          id: paneId,
          command: pane.command,
          args: pane.args,
          cwd: pane.cwd,
          viaShell: pane.viaShell,
          env: pane.env,
          setup: pane.setup
        },
        Math.max(term.cols, 20),
        Math.max(term.rows, 5)
      )
      // A restart may have torn this terminal down while the spawn was in flight.
      if (cancelled) return
      const current = useDeck
        .getState()
        .workspaces.flatMap((w) => w.panes)
        .find((p) => p.id === paneId)
      const plan = planAttach(result, current?.status)
      for (const chunk of plan.writes) term.write(chunk)
      handle.attach()
      if (plan.adoptStatus) setPaneStatus(paneId, result.status, result.exitCode ?? null)
      handle.refit()
      if (active) term.focus()
    })()

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, pane.epoch, pane.autostart])
}
