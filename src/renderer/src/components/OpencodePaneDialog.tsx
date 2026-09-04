import { useEffect, useMemo, useState } from 'react'
import {
  isOpencodeProfile,
  opencodeArgs,
  opencodePaneSuffix,
  opencodeWslScript,
  type OpencodeLaunch
} from '@shared/opencode'
import type { OpencodeInfo } from '@shared/types'
import { useDeck } from '../store'
import { Field, Modal, Toggle } from './ui'

const api = window.harness

interface Props {
  workspaceId: string
  profileId: string
  onClose: () => void
}

type ResumeMode = 'new' | 'continue' | 'session'

const RESUME: Array<[ResumeMode, string]> = [
  ['new', 'New'],
  ['continue', 'Last session'],
  ['session', 'Pick one…']
]

const STORE_KEY = 'hd.opencode.launch'

/** The options last launched through this profile, so tomorrow's pane starts there. */
function remembered(profileId: string): OpencodeLaunch {
  try {
    const raw = localStorage.getItem(`${STORE_KEY}:${profileId}`)
    return raw ? (JSON.parse(raw) as OpencodeLaunch) : {}
  } catch {
    return {}
  }
}

function remember(profileId: string, launch: OpencodeLaunch): void {
  try {
    localStorage.setItem(`${STORE_KEY}:${profileId}`, JSON.stringify(launch))
  } catch {
    /* nowhere to keep it — the dialog simply opens blank next time */
  }
}

/** How long ago a session was last touched, roughly — it is a picker, not a clock. */
function ago(ms?: number): string {
  if (!ms) return ''
  const minutes = Math.round((Date.now() - ms) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/** The tail of a session's folder, to tell two "Untitled" rows apart. */
function folderOf(directory?: string): string {
  return directory?.split(/[\\/]/).filter(Boolean).pop() ?? ''
}

/**
 * OpenCode with its options showing. Every harness pane is a command line, so
 * the dialog's whole product is one: a model, an agent, whether to resume, a
 * prompt — composed into opencode's own flags and handed to `addPane` like any
 * custom launcher. What opencode can name for itself (models, agents, recent
 * sessions) is offered as suggestions; none of it is load-bearing, and an
 * unreachable CLI leaves the fields exactly as typeable as they ever were.
 */
export function OpencodePaneDialog({ workspaceId, profileId, onClose }: Props): React.JSX.Element {
  const profile = useDeck((s) => s.profiles.find((p) => p.id === profileId))
  const workspace = useDeck((s) => s.workspaces.find((w) => w.id === workspaceId))
  const addPane = useDeck((s) => s.addPane)

  const saved = useMemo(() => remembered(profileId), [profileId])
  const [model, setModel] = useState(saved.model ?? '')
  const [agent, setAgent] = useState(saved.agent ?? '')
  const [resumeMode, setResumeMode] = useState<ResumeMode>(() =>
    saved.resume === 'continue' ? 'continue' : saved.resume && typeof saved.resume === 'object' ? 'session' : 'new'
  )
  const [sessionId, setSessionId] = useState(
    saved.resume && typeof saved.resume === 'object' ? saved.resume.id : ''
  )
  const [fork, setFork] = useState(Boolean(saved.fork))
  const [auto, setAuto] = useState(Boolean(saved.auto))
  const [prompt, setPrompt] = useState(saved.prompt ?? '')
  const [info, setInfo] = useState<OpencodeInfo | null>(null)
  const [asking, setAsking] = useState(true)

  // The lists come from the CLI the pane itself would run, through the same
  // courier — native here, or the WSL launcher's login shell — so what the
  // dialog shows is what that pane can actually use.
  useEffect(() => {
    if (!isOpencodeProfile(profileId)) return
    let live = true
    setAsking(true)
    api.opencode
      .query(profileId, workspace?.cwd)
      .then((answer) => {
        if (live) {
          setInfo(answer)
          setAsking(false)
        }
      })
      .catch(() => {
        if (live) setAsking(false)
      })
    return () => {
      live = false
    }
  }, [profileId, workspace?.cwd])

  const launch = useMemo<OpencodeLaunch>(
    () => ({
      model: model.trim() || undefined,
      agent: agent.trim() || undefined,
      resume:
        resumeMode === 'continue'
          ? 'continue'
          : resumeMode === 'session' && sessionId.trim()
            ? { id: sessionId.trim() }
            : 'new',
      fork: fork && resumeMode !== 'new' ? true : undefined,
      auto: auto || undefined,
      prompt: prompt.trim() || undefined
    }),
    [model, agent, resumeMode, sessionId, fork, auto, prompt]
  )

  const wsl = Boolean(profile?.id.startsWith('wsl:'))
  const preview = wsl
    ? `wsl bash -lic ${opencodeWslScript(launch)}`
    : [profile?.command ?? 'opencode', ...opencodeArgs(launch)].join(' ')
  const suffix = opencodePaneSuffix(launch)

  const open = (): void => {
    if (!profile) return
    remember(profileId, launch)
    addPane(workspaceId, profile, {
      command: profile.command,
      ...(wsl
        ? { args: ['-e', 'bash', '-lic', opencodeWslScript(launch)] }
        : { args: opencodeArgs(launch) }),
      ...(suffix ? { name: `${profile.name} · ${suffix}` } : {})
    })
    onClose()
  }

  const sessions = info?.sessions ?? []

  return (
    <Modal title="OpenCode pane" onClose={onClose} footer={
      <>
        <span className="foot-note">{preview}</span>
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" onClick={open}>
          Open pane
        </button>
      </>
    }>
      <Field
        label="Session"
        hint={
          resumeMode === 'session'
            ? 'The session the TUI opens with. Leaving it unset starts a fresh one.'
            : resumeMode === 'continue'
              ? 'Picks up the most recent session this folder last talked about.'
              : undefined
        }
      >
        <div className="segmented wide" role="group" aria-label="Which session to open">
          {RESUME.map(([value, label]) => (
            <button
              key={value}
              className={resumeMode === value ? 'on' : ''}
              onClick={() => setResumeMode(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </Field>

      {resumeMode === 'session' ? (
        <div className="field">
          {asking ? (
            <div className="oc-note">Asking opencode for sessions…</div>
          ) : sessions.length ? (
            <div className="oc-sessions" role="listbox" aria-label="Recent sessions">
              {sessions.map((session) => (
                <button
                  key={session.id}
                  role="option"
                  aria-selected={sessionId === session.id}
                  className={`oc-session ${sessionId === session.id ? 'on' : ''}`}
                  onClick={() => setSessionId(session.id)}
                  title={session.directory}
                >
                  <span className="oc-session-title">{session.title}</span>
                  <span className="oc-session-meta">
                    {folderOf(session.directory)}
                    {folderOf(session.directory) && ago(session.updated) ? ' · ' : ''}
                    {ago(session.updated)}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="oc-note">opencode named no sessions yet.</div>
          )}
          <input
            value={sessionId}
            placeholder="or a session id (ses_…)"
            spellCheck={false}
            onChange={(event) => setSessionId(event.target.value)}
          />
        </div>
      ) : null}

      {resumeMode !== 'new' ? (
        <Toggle
          checked={Boolean(fork)}
          onChange={setFork}
          label="Fork it"
          hint="Copy the session and continue the copy, so the original stays as it was."
        />
      ) : null}

      {/* Why the lists below are empty, when that is not simply "opencode is
          thinking". Shown whatever the resume mode — the model and agent
          pickers say just as much. */}
      {!asking && info?.error ? <div className="oc-note bad">{info.error}</div> : null}

      <Field
        label="Model"
        hint={
          info?.models.length
            ? 'provider/model — empty keeps opencode’s own default.'
            : 'provider/model, e.g. anthropic/claude-sonnet-4. Empty keeps opencode’s own default.'
        }
      >
        <input
          value={model}
          placeholder="default"
          spellCheck={false}
          list="oc-models"
          onChange={(event) => setModel(event.target.value)}
        />
        <datalist id="oc-models">
          {(info?.models ?? []).map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      </Field>

      <Field
        label="Agent"
        hint={
          info?.agents.length
            ? 'How opencode behaves — build, plan, or one of yours. Empty keeps the default.'
            : 'build, plan, or an agent of your own. Empty keeps the default.'
        }
      >
        <input
          value={agent}
          placeholder="default"
          spellCheck={false}
          list="oc-agents"
          onChange={(event) => setAgent(event.target.value)}
        />
        <datalist id="oc-agents">
          {(info?.agents ?? []).map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      </Field>

      <Field
        label="Opening prompt"
        hint="The task opencode starts reading the moment the pane opens. Optional."
      >
        <textarea
          value={prompt}
          rows={3}
          placeholder="What should it get on with?"
          spellCheck={false}
          onChange={(event) => setPrompt(event.target.value)}
        />
      </Field>

      <Toggle
        checked={auto}
        onChange={setAuto}
        label="Auto-approve permissions"
        hint="opencode stops asking before edits and commands. Convenient, and exactly as safe as it sounds."
      />
    </Modal>
  )
}
