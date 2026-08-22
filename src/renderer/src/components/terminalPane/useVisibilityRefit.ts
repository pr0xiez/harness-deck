import { useEffect, type RefObject } from 'react'
import type { TerminalHandle } from '../../terminals'

/** Re-measure when the pane becomes visible again (hidden panes have no size). */
export function useVisibilityRefit(
  handleRef: RefObject<TerminalHandle | null>,
  visible: boolean,
  active: boolean
): void {
  useEffect(() => {
    if (!visible) return
    const handle = handleRef.current
    if (!handle) return
    const id = requestAnimationFrame(() => {
      handle.refit()
      if (active) handle.term.focus()
    })
    return () => cancelAnimationFrame(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, active])
}
