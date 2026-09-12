import type { ILinkHandler, Terminal } from '@xterm/xterm'
import { isReservedShortcut } from './shortcuts'

export function terminalLinkHandler(openExternal: (uri: string) => void) {
  return {
    activate(event, uri) {
      event.preventDefault()
      openExternal(uri)
    }
  } satisfies ILinkHandler
}

export function handleTerminalKey(
  event: KeyboardEvent,
  term: Pick<Terminal, 'getSelection'>,
  locked: boolean,
  copy: (text: string) => Promise<boolean>
): boolean {
  if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'c') {
    const selection = term.getSelection()
    if (selection) {
      event.preventDefault()
      if (event.type === 'keydown') void copy(selection)
      return false
    }
  }
  return !locked && !isReservedShortcut(event)
}
