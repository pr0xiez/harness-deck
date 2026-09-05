import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import type { SearchAddon } from '@xterm/addon-search'

/**
 * Live xterm instances, keyed by pane id. Kept outside the store because they
 * are neither serialisable nor comparable.
 */
export interface TerminalHandle {
  id: string
  term: Terminal
  fit: FitAddon
  search: SearchAddon
  /** Acknowledges only after xterm has parsed the output. */
  write: (data: string, onParsed?: () => void) => void
  attach: () => void
  refit: () => void
}

/** Hold live output behind the replay, preserving its parse acknowledgements. */
export function createTerminalOutput(
  term: Pick<Terminal, 'write'>
): Pick<TerminalHandle, 'write' | 'attach'> {
  let attached = false
  let queue: Array<{ data: string; onParsed?: () => void }> = []
  return {
    write(data, onParsed) {
      if (attached) term.write(data, onParsed)
      else queue.push({ data, onParsed })
    },
    attach() {
      attached = true
      for (const { data, onParsed } of queue) term.write(data, onParsed)
      queue = []
    }
  }
}

const handles = new Map<string, TerminalHandle>()

export function registerTerminal(handle: TerminalHandle): void {
  handles.set(handle.id, handle)
}

export function unregisterTerminal(id: string): void {
  handles.delete(id)
}

export function getTerminal(id: string): TerminalHandle | undefined {
  return handles.get(id)
}

export function allTerminals(): TerminalHandle[] {
  return [...handles.values()]
}

export function refitAll(): void {
  for (const handle of handles.values()) handle.refit()
}

/** Applies a settings change to every live terminal. */
export function applyToAll(mutate: (handle: TerminalHandle) => void): void {
  for (const handle of handles.values()) mutate(handle)
}
