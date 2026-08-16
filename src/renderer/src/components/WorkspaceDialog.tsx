import { useState } from 'react'
import type { WorkspaceAction } from '@shared/types'
import { shortcutLabel } from '../shortcuts'
import { useDeck } from '../store'
import { Field, Modal } from './ui'
import { Icon } from './Icon'

/**
 * The two things a workspace knows about a repo that a pane cannot work out for
 * itself: what has to run in a fresh checkout before an agent is any use in it,
 * and the handful of commands this project runs all day. One dialog, because
 * they are the same answer to the same question — "what do you type here?"
 */

interface Row {
  /** Rows are edited by position, and two blank labels must stay distinguishable. */
  key: number
  id: string
  label: string
  command: string
}

let rowSeq = 0
let idSeq = 0

const makeId = (): string =>
  `act_${Date.now().toString(36)}${(idSeq += 1).toString(36)}${Math.random().toString(36).slice(2, 5)}`

const makeRow = (action?: WorkspaceAction): Row => ({
  key: (rowSeq += 1),
  // Kept across an edit, so a chip that is already bound to Alt+Shift+2 stays
  // the same action rather than becoming a new one on every save.
  id: action?.id ?? makeId(),
  label: action?.label ?? '',
  command: action?.command ?? ''
})

/** A row is worth keeping once it has something to run; the label can wait. */
const collect = (rows: Row[]): WorkspaceAction[] =>
  rows
    .filter((row) => row.command.trim())
    .map((row) => ({
      id: row.id,
      label: row.label.trim() || row.command.trim().split(/\s+/)[0],
      command: row.command.trim()
    }))

export function WorkspaceDialog({
  workspaceId,
  onClose
}: {
  workspaceId: string
  onClose: () => void
}): React.JSX.Element | null {
  const workspace = useDeck((s) => s.workspaces.find((w) => w.id === workspaceId))
  const updateWorkspace = useDeck((s) => s.updateWorkspace)
  const [setup, setSetup] = useState(workspace?.setupCommand ?? '')
  const [rows, setRows] = useState<Row[]>(() => (workspace?.actions ?? []).map((a) => makeRow(a)))

  if (!workspace) return null

  const actions = collect(rows)

  const patchRow = (key: number, patch: Partial<Row>): void =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)))

  const save = (): void => {
    updateWorkspace(workspace.id, {
      setupCommand: setup.trim() || undefined,
      actions: actions.length ? actions : undefined
    })
    onClose()
  }

  return (
    <Modal
      title={`Setup and actions — ${workspace.name}`}
      onClose={onClose}
      footer={
        <>
          <span className="foot-note">
            {actions.length
              ? `${actions.length} chip${actions.length === 1 ? '' : 's'} in the toolbar.`
              : ''}
          </span>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            Save
          </button>
        </>
      }
    >
      <Field
        label="After creating a worktree, run"
        hint="Runs in the new worktree, in the agent's own pane, before the agent starts — so the install scrolls by and then it takes over. If it fails the agent never starts, and the pane is left showing why. Existing panes are unaffected."
      >
        <input
          autoFocus
          value={setup}
          placeholder="npm ci  ·  make setup  ·  uv sync"
          spellCheck={false}
          onChange={(event) => setSetup(event.target.value)}
        />
      </Field>

      <div className="field">
        <span className="field-label">Actions</span>

        {rows.length ? (
          <div className="action-table">
            {rows.map((row) => (
              <div className="action-row" key={row.key}>
                <input
                  className="action-label"
                  value={row.label}
                  placeholder="Tests"
                  onChange={(event) => patchRow(row.key, { label: event.target.value })}
                />
                <input
                  className="action-command"
                  value={row.command}
                  placeholder="npm test"
                  spellCheck={false}
                  onChange={(event) => patchRow(row.key, { command: event.target.value })}
                />
                <button
                  className="icon-btn danger"
                  title="Remove action"
                  onClick={() => setRows((current) => current.filter((r) => r.key !== row.key))}
                >
                  <Icon name="close" size={12} />
                </button>
              </div>
            ))}
          </div>
        ) : null}

        <button
          className="btn subtle action-add"
          onClick={() => setRows((current) => [...current, makeRow()])}
        >
          <Icon name="plus" />
          <span>Add action</span>
        </button>

        <span className="field-hint">
          Each one is a chip in the toolbar and a command in the palette. Clicking it opens an
          ordinary shell pane in <code>{workspace.cwd}</code> — restartable, closable,
          transcript-able. The first nine also answer{' '}
          <code>
            {shortcutLabel('run-action-by-digit', 1)}…{shortcutLabel('run-action-by-digit', 9)}
          </code>
          .
        </span>
      </div>
    </Modal>
  )
}
