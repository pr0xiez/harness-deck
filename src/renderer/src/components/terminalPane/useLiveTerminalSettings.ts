import { useEffect, type RefObject } from 'react'
import { useDeck } from '../../store'
import type { TerminalHandle } from '../../terminals'
import { terminalTheme } from '../../theme'

/** Live settings updates without rebuilding the terminal. */
export function useLiveTerminalSettings(
  handleRef: RefObject<TerminalHandle | null>,
  accent: string,
  locked: boolean
): void {
  const settings = useDeck((s) => s.settings)

  useEffect(() => {
    const handle = handleRef.current
    if (!handle) return
    const { term } = handle
    term.options.fontSize = settings.fontSize
    term.options.fontFamily = settings.fontFamily
    term.options.cursorBlink = settings.cursorBlink && !locked
    term.options.cursorStyle = settings.cursorStyle
    term.options.scrollback = settings.scrollback
    // Belt to the data handler's braces: this stops xterm reading the keyboard
    // at all, which is also what makes an IME or a drop refuse to compose.
    term.options.disableStdin = locked
    term.options.theme = { ...terminalTheme, cursor: accent }
    handle.refit()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    settings.fontSize,
    settings.fontFamily,
    settings.cursorBlink,
    settings.cursorStyle,
    settings.scrollback,
    accent,
    locked
  ])
}
