import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DiffResult } from '@shared/types'
import { useDeck, type DeckWorkspace, type PaneView } from '../store'
import { Icon } from './Icon'

const api = window.harness

/**
 * The payoff of worktree panes: broadcast one prompt, then read three agents'
 * answers as three diffs rather than three terminals.
 *
 * Read-only throughout. Nothing here writes to a repo, stages anything or opens
 * an editor — the pane already has a shell in it, and that is where git lives.
 */

/**
 * Patch lines asked for per column. The cap is enforced in `git.ts`, so a
 * 5,000-line diff is cut before it crosses IPC and this number is also the most
 * the renderer will ever be asked to lay out — three columns of it is a page
 * you can scroll, not a frame you can lose.
 */
const PATCH_LINES = 700

type Loaded = Record<string, DiffResult>

interface Props {
  workspace: DeckWorkspace
  onClose: () => void
}

/** Which colour a patch line takes. The order matters: `+++` is not an addition. */
function lineClass(line: string): string {
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  if (/^(diff --git|index |new file|deleted file|old mode|new mode|similarity |rename |Binary files)/.test(line)) {
    return 'meta'
  }
  return ''
}

function Lines({ text }: { text: string }): React.JSX.Element {
  const lines = useMemo(() => text.split('\n'), [text])
  return (
    <pre className="cmp-diff">
      {lines.map((line, index) => (
        <span key={index} className={`cmp-line ${lineClass(line)}`}>
          {line || ' '}
        </span>
      ))}
    </pre>
  )
}

interface ColumnProps {
  pane: PaneView
  accent: string
  diff: DiffResult | undefined
  full: boolean
}

function Column({ pane, accent, diff, full }: ColumnProps): React.JSX.Element {
  const profile = useDeck((s) => s.profiles.find((p) => p.id === pane.profileId))
  const title = pane.name || pane.processTitle || profile?.name || pane.command

  return (
    <section className="cmp-col" style={{ ['--pane-accent' as string]: profile?.accent || accent }}>
      <header className="cmp-col-head">
        <span className="pane-badge" title={profile?.name}>
          {profile?.icon ?? '»'}
        </span>
        <span className="cmp-col-title" title={pane.cwd}>
          {title}
        </span>
        <button
          className="icon-btn tiny"
          title={`Open ${pane.cwd}`}
          onClick={() => api.openPath(pane.cwd)}
        >
          <Icon name="folder" size={11} />
        </button>
      </header>

      {diff ? (
        <div className="cmp-col-sub">
          <Icon name="branch" size={11} />
          <span className="cmp-branch">{diff.branch || '—'}</span>
          {diff.baseRef ? <span className="cmp-base">vs {diff.baseRef}</span> : null}
        </div>
      ) : null}

      <div className="cmp-col-body">
        {!diff ? (
          <p className="cmp-note">Asking git…</p>
        ) : diff.error ? (
          <p className="cmp-note bad">{diff.error}</p>
        ) : !diff.stat ? (
          // Never an empty column: a pane that changed nothing has to say so,
          // or it reads as a pane the view failed to ask about.
          <p className="cmp-note">No changes since it branched off {diff.baseRef}.</p>
        ) : (
          <>
            <Lines text={diff.stat} />
            {full && diff.patch ? (
              <>
                <div className="cmp-rule" />
                <Lines text={diff.patch} />
                {diff.truncated ? (
                  <p className="cmp-fold">
                    {`Showing ${diff.patch.split('\n').length} of ${diff.patchLines} lines.`}{' '}
                    <button className="link" onClick={() => api.openPath(pane.cwd)}>
                      Open the folder
                    </button>{' '}
                    to read the rest.
                  </p>
                ) : null}
              </>
            ) : null}
          </>
        )}
      </div>
    </section>
  )
}

export function CompareView({ workspace, onClose }: Props): React.JSX.Element {
  const [diffs, setDiffs] = useState<Loaded>({})
  const [busy, setBusy] = useState(true)
  const [full, setFull] = useState(false)

  // A pane going quiet or changing status rebuilds `workspace.panes`, and
  // re-reading git every time one did would make the view flicker for no
  // reason. Only the set of folders on screen is worth reacting to.
  const key = workspace.panes.map((pane) => `${pane.id}:${pane.worktree ?? ''}`).join('|')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const panes = useMemo(() => workspace.panes.filter((pane) => pane.worktree), [key])

  const read = useCallback(async () => {
    setBusy(true)
    const results = await Promise.all(
      panes.map((pane) => api.git.diffRange({ dir: pane.cwd, limit: PATCH_LINES }))
    )
    setDiffs(Object.fromEntries(panes.map((pane, index) => [pane.id, results[index]])))
    setBusy(false)
  }, [panes])

  useEffect(() => {
    void read()
  }, [read])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // Captured before the terminals see it, the same way a modal takes it.
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const changed = panes.filter((pane) => diffs[pane.id]?.stat).length

  return (
    <div className="compare" role="dialog" aria-label="Compare worktrees">
      <header className="cmp-head">
        <span className="ws-chip" style={{ background: workspace.accent }} />
        <h2>Compare</h2>
        <span className="cmp-lead">
          {busy
            ? `reading ${panes.length} worktrees…`
            : `${changed} of ${panes.length} ${panes.length === 1 ? 'pane has' : 'panes have'} changed something`}
        </span>

        <div className="cmp-head-right">
          <div className="segmented" role="group" aria-label="Detail">
            <button className={full ? '' : 'on'} onClick={() => setFull(false)}>
              Summary
            </button>
            <button className={full ? 'on' : ''} onClick={() => setFull(true)}>
              Full diff
            </button>
          </div>
          <button className="ghost-btn" title="Ask git again" onClick={() => void read()}>
            <Icon name="refresh" />
            <span>Refresh</span>
          </button>
          <button className="icon-btn" title="Close (Esc)" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
      </header>

      <div className="cmp-cols">
        {panes.map((pane) => (
          <Column
            key={pane.id}
            pane={pane}
            accent={workspace.accent}
            diff={diffs[pane.id]}
            full={full}
          />
        ))}
      </div>
    </div>
  )
}
