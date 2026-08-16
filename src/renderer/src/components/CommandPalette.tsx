import { useEffect, useMemo, useRef, useState } from 'react'
import { useDeck } from '../store'
import { buildCommands, type Command } from './commands'
import { Icon } from './Icon'

export function CommandPalette(): React.JSX.Element {
  const state = useDeck()
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const close = (): void => state.setUi({ palette: false })

  const commands = useMemo<Command[]>(() => buildCommands(state), [state])

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return commands
    const words = needle.split(/\s+/)
    return commands
      .map((command) => {
        const haystack = `${command.group} ${command.label}`.toLowerCase()
        let score = 0
        for (const word of words) {
          const at = haystack.indexOf(word)
          if (at === -1) return null
          score += at === 0 ? 3 : haystack.includes(` ${word}`) ? 2 : 1
        }
        return { command, score }
      })
      .filter((entry): entry is { command: Command; score: number } => entry !== null)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.command)
  }, [commands, query])

  useEffect(() => setCursor(0), [query])

  useEffect(() => {
    listRef.current?.querySelector('.palette-item.on')?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const runAt = (index: number): void => {
    const command = results[index]
    if (!command) return
    close()
    command.run()
  }

  return (
    <div className="scrim palette-scrim" onMouseDown={close}>
      <div className="palette" onMouseDown={(event) => event.stopPropagation()}>
        <div className="palette-input">
          <Icon name="command" />
          <input
            autoFocus
            value={query}
            placeholder="Run a command — switch workspace, open a harness, change layout…"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setCursor((c) => Math.min(c + 1, results.length - 1))
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setCursor((c) => Math.max(c - 1, 0))
              } else if (event.key === 'Enter') {
                event.preventDefault()
                runAt(cursor)
              } else if (event.key === 'Escape') {
                event.preventDefault()
                close()
              }
            }}
          />
          <span className="palette-count">{results.length}</span>
        </div>
        <div className="palette-list" ref={listRef}>
          {results.map((command, index) => (
            <button
              key={command.id}
              className={`palette-item ${index === cursor ? 'on' : ''}`}
              onMouseEnter={() => setCursor(index)}
              onClick={() => runAt(index)}
            >
              <span className="palette-group">{command.group}</span>
              <span className="palette-label">{command.label}</span>
              {command.hint ? <span className="palette-hint">{command.hint}</span> : null}
            </button>
          ))}
          {!results.length ? <div className="palette-none">Nothing matches “{query}”</div> : null}
        </div>
      </div>
    </div>
  )
}
