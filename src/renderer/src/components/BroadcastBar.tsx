import { useEffect, useRef, useState } from 'react'
import { paneLabel } from '../paneLabel'
import { isLive, useDeck, type DeckWorkspace, type PaneView } from '../store'
import { registerVoiceSink } from '../voice'
import { Icon } from './Icon'
import { MicButton } from './MicButton'
import { Dropdown } from './ui'

const api = window.harness

interface Props {
  workspace: DeckWorkspace
}

/**
 * Which panes each workspace is currently talking to. Kept for the life of the
 * window and no further: the set of agents you want on this prompt belongs to
 * the task in front of you, and a choice restored a week later would quietly
 * skip a pane you had long forgotten deselecting. Panes missing from a
 * workspace's record fall back to the default for their kind.
 */
const chosenTargets = new Map<string, Record<string, boolean>>()

const NOTHING_CHOSEN: Record<string, boolean> = {}

/**
 * A fence the text inside cannot close: backticks normally, tildes once the
 * selection carries backtick fences of its own — terminal output of a README
 * is the ordinary case — and a longer run of backticks when it carries both.
 */
function fenceFor(selection: string): string {
  if (!selection.includes('```')) return '```'
  if (!selection.includes('~~~')) return '~~~'
  const longest = Math.max(...Array.from(selection.matchAll(/`+/g), (run) => run[0].length))
  return '`'.repeat(longest + 1)
}

/**
 * Wraps a pane's selection for the prompt box (HD-17). Newline-led because
 * `insert()` joins with a space and a fence that does not start its own line is
 * not a fence; the trailing newline leaves the caret below the block, which is
 * where the instruction goes.
 */
export function fencedBlock(selection: string): string {
  const body = selection.trimEnd()
  const fence = fenceFor(body)
  return `\n${fence}\n${body}\n${fence}\n`
}

/**
 * Types one prompt into every live pane of a workspace — the reason to have
 * several agents side by side in the first place.
 */
export function BroadcastBar({ workspace }: Props): React.JSX.Element {
  const setUi = useDeck((s) => s.setUi)
  const profiles = useDeck((s) => s.profiles)
  const history = useDeck((s) => s.settings.broadcastHistory)
  const snippets = useDeck((s) => s.settings.broadcastSnippets)
  const rememberBroadcast = useDeck((s) => s.rememberBroadcast)
  const updateSettings = useDeck((s) => s.updateSettings)
  const pendingInsert = useDeck((s) => s.ui.pendingInsert)

  const [text, setText] = useState('')
  const [sendEnter, setSendEnter] = useState(true)
  const [flash, setFlash] = useState<string | null>(null)
  const [snippetsOpen, setSnippetsOpen] = useState(false)
  /** Where ↑ has walked to in the history, or -1 while the box holds a draft. */
  const [recalled, setRecalled] = useState(-1)
  // Target choices live outside React so hiding the bar does not forget them.
  const [, redraw] = useState(0)

  const inputRef = useRef<HTMLTextAreaElement>(null)
  const snippetsButton = useRef<HTMLButtonElement>(null)
  /** What the box held before ↑ took it over, so Escape can hand it back. */
  const draftRef = useRef('')
  // Dictation arrives outside React's event flow, so the latest text and the
  // latest `send` are kept in refs the sink can reach.
  const textRef = useRef(text)
  const sendRef = useRef<(payload?: string) => void>(() => undefined)
  textRef.current = text

  /** Moves both copies of the box's contents together, for the sink's sake. */
  const write = (value: string): void => {
    textRef.current = value
    setText(value)
  }

  /** Appends dictation or a snippet to whatever is already in the box. */
  const insert = (fragment: string): void => {
    const current = textRef.current.replace(/\s+$/, '')
    write(current ? `${current} ${fragment}` : fragment)
    inputRef.current?.focus()
  }

  useEffect(() => inputRef.current?.focus(), [])

  // Keyed on the fragment rather than run once on mount: the bar stays mounted
  // for as long as it is open, so a second selection sent to an open bar would
  // otherwise arrive after the component's one chance to look had passed.
  useEffect(() => {
    if (pendingInsert === null) return
    // Nothing to separate a fragment from in an empty box — its leading newline
    // would only push the block off the first line.
    insert(textRef.current.trim() ? pendingInsert : pendingInsert.trimStart())
    setUi({ pendingInsert: null })
  }, [pendingInsert])

  useEffect(
    () =>
      registerVoiceSink({
        id: 'broadcast',
        label: 'broadcast',
        isFocused: () => document.activeElement === inputRef.current,
        insert: (dictated) => insert(dictated),
        submit: () => sendRef.current(textRef.current)
      }),
    []
  )

  // A recalled prompt is meant to be continued, so the caret goes to the end
  // rather than wherever it sat in the line it replaced.
  useEffect(() => {
    if (recalled < 0) return
    const box = inputRef.current
    box?.setSelectionRange(box.value.length, box.value.length)
  }, [recalled])

  const chosen = chosenTargets.get(workspace.id) ?? NOTHING_CHOSEN
  const choose = (next: Record<string, boolean>): void => {
    chosenTargets.set(workspace.id, next)
    redraw((n) => n + 1)
  }

  const isAgent = (pane: PaneView): boolean =>
    profiles.find((p) => p.id === pane.profileId)?.kind === 'agent'
  const isTarget = (pane: PaneView): boolean => chosen[pane.id] ?? isAgent(pane)

  const live = workspace.panes.filter(isLive)
  // A locked pane keeps its chip, so you can see it is being skipped rather
  // than wonder why the count is one short — but nothing here can select it.
  // One prompt going to every agent at once is exactly the accident the lock
  // exists for.
  const open = live.filter((pane) => !pane.readOnly)
  const targets = open.filter(isTarget)

  const allOn = open.length > 0 && open.every(isTarget)
  const agentsOn = open.length > 0 && open.every((pane) => isTarget(pane) === isAgent(pane))

  /** The one-click cases: everything alive, or just the agents. */
  const quickPick = (mode: 'all' | 'agents'): void => {
    const next = { ...chosen }
    for (const pane of open) next[pane.id] = mode === 'all' || isAgent(pane)
    choose(next)
  }

  const restoreDraft = (): void => {
    setRecalled(-1)
    write(draftRef.current)
  }

  // Shell rules: ↑ walks the history out of an untouched box, and is left alone
  // to move the caret through a draft somebody is actually writing.
  const canRecall = recalled >= 0 ? text === history[recalled] : text === ''

  /** `delta` of 1 walks towards older prompts, -1 back towards the draft. */
  const recall = (delta: number): void => {
    if (!history.length) return
    if (recalled < 0) {
      if (delta < 0) return
      draftRef.current = text
    }
    const next = Math.min(history.length - 1, recalled + delta)
    if (next < 0) return restoreDraft()
    setRecalled(next)
    write(history[next])
  }

  const send = (payload: string = text): void => {
    const prompt = payload.trim()
    if (!prompt || !targets.length) return
    for (const pane of targets) {
      api.pty.write(pane.id, payload)
      // The delay is not decoration: TUIs drop input pasted in the same tick as
      // the newline that submits it.
      if (sendEnter) window.setTimeout(() => api.pty.write(pane.id, '\r'), 60)
    }
    rememberBroadcast(prompt)
    setFlash(`sent to ${targets.length} pane${targets.length === 1 ? '' : 's'}`)
    window.setTimeout(() => setFlash(null), 1600)
    write('')
    setRecalled(-1)
    draftRef.current = ''
  }
  sendRef.current = send

  const saved = snippets.includes(text.trim())
  const saveSnippet = (): void => {
    const prompt = text.trim()
    if (!prompt || saved) return
    updateSettings({ broadcastSnippets: [...snippets, prompt] })
  }
  const forgetSnippet = (snippet: string): void =>
    updateSettings({ broadcastSnippets: snippets.filter((s) => s !== snippet) })

  return (
    <div className="broadcast" style={{ ['--ws-accent' as string]: workspace.accent }}>
      <div className="broadcast-head">
        <Icon name="broadcast" />
        <span className="broadcast-title">Broadcast</span>
        <span className="broadcast-targets">
          {live.length ? (
            live.map((pane) => {
              const profile = profiles.find((p) => p.id === pane.profileId)
              const on = !pane.readOnly && isTarget(pane)
              return (
                <button
                  key={pane.id}
                  className={`target-chip ${on ? 'on' : ''}`}
                  aria-pressed={on}
                  disabled={pane.readOnly}
                  style={{ ['--badge' as string]: profile?.accent }}
                  title={
                    pane.readOnly
                      ? 'Read-only — unlock the pane to broadcast to it'
                      : on
                        ? 'Included — click to skip this pane'
                        : 'Skipped — click to include it'
                  }
                  onClick={() => choose({ ...chosen, [pane.id]: !on })}
                >
                  {profile?.icon ?? '»'} {paneLabel(pane, profile)}
                </button>
              )
            })
          ) : (
            <span className="broadcast-empty">no live panes to send to</span>
          )}
        </span>
        {flash ? <span className="broadcast-flash">{flash}</span> : null}
        <div className="segmented mini" role="group" aria-label="Quick target choice">
          <button
            className={allOn ? 'on' : ''}
            title="Send to every live pane"
            onClick={() => quickPick('all')}
          >
            all
          </button>
          <button
            className={agentsOn ? 'on' : ''}
            title="Send to the agent panes only"
            onClick={() => quickPick('agents')}
          >
            agents
          </button>
        </div>
        <label className="mini-check">
          <input type="checkbox" checked={sendEnter} onChange={(e) => setSendEnter(e.target.checked)} />
          press enter
        </label>
        <MicButton variant="inline" />
        <button className="icon-btn" title="Hide broadcast (Ctrl+Shift+B)" onClick={() => setUi({ broadcast: false })}>
          <Icon name="close" />
        </button>
      </div>

      <div className="broadcast-input">
        <textarea
          ref={inputRef}
          value={text}
          rows={2}
          placeholder={`Prompt ${targets.length} pane${targets.length === 1 ? '' : 's'} at once — Enter to send, Shift+Enter for a new line, ↑ for a recent prompt`}
          onChange={(event) => write(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              return send()
            }
            if (canRecall && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
              event.preventDefault()
              return recall(event.key === 'ArrowUp' ? 1 : -1)
            }
            if (event.key === 'Escape') {
              // A recalled prompt is handed back first; a second Escape closes.
              if (recalled >= 0) return restoreDraft()
              setUi({ broadcast: false })
            }
          }}
        />
        <div className="snippet-anchor">
          <button
            ref={snippetsButton}
            className="btn subtle snippet-btn"
            title="Saved prompts"
            aria-expanded={snippetsOpen}
            onClick={() => setSnippetsOpen(!snippetsOpen)}
          >
            <Icon name="command" size={13} />
            <Icon name="chevronUp" size={12} />
          </button>
          {snippetsOpen ? (
            <Dropdown
              onClose={() => setSnippetsOpen(false)}
              align="right"
              anchor={snippetsButton}
              className="snippet-menu"
            >
              <div className="menu-label">Snippets</div>
              {snippets.length ? (
                snippets.map((snippet) => (
                  <div key={snippet} className="snippet-row">
                    <button
                      className="menu-item snippet"
                      title={snippet}
                      onClick={() => {
                        insert(snippet)
                        setSnippetsOpen(false)
                      }}
                    >
                      {snippet}
                    </button>
                    <button
                      className="icon-btn tiny danger"
                      title="Forget this snippet"
                      onClick={() => forgetSnippet(snippet)}
                    >
                      <Icon name="close" size={10} />
                    </button>
                  </div>
                ))
              ) : (
                <p className="menu-note">A prompt you keep sending belongs here.</p>
              )}
              <div className="menu-sep" />
              <button className="menu-item" disabled={!text.trim() || saved} onClick={saveSnippet}>
                <Icon name="plus" size={12} />
                <span>{saved ? 'Already saved' : 'Save what is in the box'}</span>
              </button>
            </Dropdown>
          ) : null}
        </div>
        <button className="btn primary" disabled={!text.trim() || !targets.length} onClick={() => send()}>
          Send to {targets.length}
        </button>
      </div>
    </div>
  )
}
