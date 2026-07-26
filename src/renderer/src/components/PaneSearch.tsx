import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'

interface Props {
  onSearch: (query: string, forward: boolean) => boolean
  onClose: () => void
}

export function PaneSearch({ onSearch, onClose }: Props): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [missing, setMissing] = useState(false)

  useEffect(() => inputRef.current?.focus(), [])

  const run = (forward: boolean): void => {
    if (!query) return
    setMissing(!onSearch(query, forward))
  }

  return (
    <div className="pane-search">
      <Icon name="search" />
      <input
        ref={inputRef}
        value={query}
        placeholder="Find in pane"
        className={missing ? 'not-found' : ''}
        onChange={(event) => {
          setQuery(event.target.value)
          setMissing(false)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            run(!event.shiftKey)
          } else if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
          }
        }}
      />
      <button className="icon-btn" title="Previous (Shift+Enter)" onClick={() => run(false)}>
        <Icon name="chevronUp" />
      </button>
      <button className="icon-btn" title="Next (Enter)" onClick={() => run(true)}>
        <Icon name="chevronDown" />
      </button>
      <button className="icon-btn" title="Close (Esc)" onClick={onClose}>
        <Icon name="close" />
      </button>
    </div>
  )
}
