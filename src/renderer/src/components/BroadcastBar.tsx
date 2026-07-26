import { useEffect, useRef, useState } from 'react'
import { useDeck, type DeckWorkspace } from '../store'
import { Icon } from './Icon'

const api = window.harness

interface Props {
  workspace: DeckWorkspace
}

/**
 * Types one prompt into every live pane of a workspace — the reason to have
 * several agents side by side in the first place.
 */
export function BroadcastBar({ workspace }: Props): React.JSX.Element {
  const setUi = useDeck((s) => s.setUi)
  const profiles = useDeck((s) => s.profiles)
  const [text, setText] = useState('')
  const [agentsOnly, setAgentsOnly] = useState(true)
  const [sendEnter, setSendEnter] = useState(true)
  const [flash, setFlash] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => inputRef.current?.focus(), [])

  const targets = workspace.panes.filter((pane) => {
    if (pane.status !== 'running') return false
    if (!agentsOnly) return true
    return profiles.find((p) => p.id === pane.profileId)?.kind === 'agent'
  })

  const send = (): void => {
    const payload = text
    if (!payload.trim() || !targets.length) return
    for (const pane of targets) {
      api.pty.write(pane.id, payload)
      if (sendEnter) window.setTimeout(() => api.pty.write(pane.id, '\r'), 60)
    }
    setFlash(`sent to ${targets.length} pane${targets.length === 1 ? '' : 's'}`)
    window.setTimeout(() => setFlash(null), 1600)
    setText('')
  }

  return (
    <div className="broadcast" style={{ ['--ws-accent' as string]: workspace.accent }}>
      <div className="broadcast-head">
        <Icon name="broadcast" />
        <span className="broadcast-title">Broadcast</span>
        <span className="broadcast-targets">
          {targets.length ? (
            targets.map((pane) => {
              const profile = profiles.find((p) => p.id === pane.profileId)
              return (
                <span key={pane.id} className="target-chip" style={{ ['--badge' as string]: profile?.accent }}>
                  {profile?.icon ?? '»'} {pane.name || pane.processTitle || profile?.name}
                </span>
              )
            })
          ) : (
            <span className="broadcast-empty">no live panes to send to</span>
          )}
        </span>
        {flash ? <span className="broadcast-flash">{flash}</span> : null}
        <label className="mini-check">
          <input type="checkbox" checked={agentsOnly} onChange={(e) => setAgentsOnly(e.target.checked)} />
          agents only
        </label>
        <label className="mini-check">
          <input type="checkbox" checked={sendEnter} onChange={(e) => setSendEnter(e.target.checked)} />
          press enter
        </label>
        <button className="icon-btn" title="Hide broadcast (Ctrl+Shift+B)" onClick={() => setUi({ broadcast: false })}>
          <Icon name="close" />
        </button>
      </div>

      <div className="broadcast-input">
        <textarea
          ref={inputRef}
          value={text}
          rows={2}
          placeholder={`Prompt every ${agentsOnly ? 'agent' : 'pane'} at once — Enter to send, Shift+Enter for a new line`}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              send()
            }
            if (event.key === 'Escape') setUi({ broadcast: false })
          }}
        />
        <button className="btn primary" disabled={!text.trim() || !targets.length} onClick={send}>
          Send to {targets.length}
        </button>
      </div>
    </div>
  )
}
