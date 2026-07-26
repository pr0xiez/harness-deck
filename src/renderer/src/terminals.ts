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
  /** Output is queued until the replay buffer has been painted. */
  attached: boolean
  queue: string[]
  write: (data: string) => void
  attach: () => void
  refit: () => void
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
