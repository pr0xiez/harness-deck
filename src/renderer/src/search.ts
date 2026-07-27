import type { Terminal } from '@xterm/xterm'
import { getTerminal } from './terminals'

/**
 * Counting a pane's matches by reading its buffer, rather than by driving its
 * SearchAddon, is the reason this file exists. `findNext` selects its hit and
 * scrolls the viewport onto it, and a selection is exactly what `copyOnSelect`
 * listens for — so counting the addon's way would scroll six panes the user is
 * looking at and leave the last match on their clipboard. The addon still owns
 * the jump, where being scrolled to and selected is the entire point.
 */

/**
 * A pane's scrollback as text, one line per *logical* line: xterm splits a long
 * line across several rows, and a match that straddles the wrap is still one
 * match — which is what the addon finds when it looks for the same string.
 */
export function paneText(term: Terminal): string {
  const buffer = term.buffer.active
  const lines: string[] = []
  let line = ''
  for (let y = 0; y < buffer.length; y += 1) {
    const row = buffer.getLine(y)
    if (!row) continue
    const continues = buffer.getLine(y + 1)?.isWrapped ?? false
    // Trailing blanks are padding on the last row of a line, and content on
    // every row before it — the wrap point falls wherever the columns ran out.
    line += row.translateToString(!continues)
    if (continues) continue
    lines.push(line)
    line = ''
  }
  return lines.join('\n')
}

/** Non-overlapping and case-insensitive, the way the addon searches by default. */
export function countMatches(text: string, needle: string): number {
  if (!needle) return 0
  const haystack = text.toLowerCase()
  const term = needle.toLowerCase()
  let count = 0
  for (let at = haystack.indexOf(term); at !== -1; at = haystack.indexOf(term, at + term.length)) {
    count += 1
  }
  return count
}

/**
 * Matches per pane, for the panes that still have a terminal behind them — a
 * pane in a workspace nobody has opened yet has no buffer to search.
 */
export function scanPanes(paneIds: string[], needle: string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const id of paneIds) {
    const handle = getTerminal(id)
    if (handle) counts[id] = countMatches(paneText(handle.term), needle)
  }
  return counts
}
