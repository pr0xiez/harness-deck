import { useMemo, useState } from 'react'
import { useDeck } from '../store'
import { relativeCwd } from '../templates'
import { Field, Modal } from './ui'
import { Icon } from './Icon'

const api = window.harness

/** What a pane calls itself before it has a process to ask. */
function paneLabel(name: string | undefined, profileName: string | undefined, command: string): string {
  return name || profileName || command
}

/** The folder a template pane lands in, said the way a person would. */
const folderLabel = (relative: string): string => (relative ? `./${relative}` : 'the workspace folder')

/** Local time, because a template is a local file. */
function savedOn(iso: string): string {
  const at = new Date(iso)
  return Number.isNaN(at.getTime())
    ? 'saved'
    : at.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

export function SaveTemplateDialog({
  workspaceId,
  onClose
}: {
  workspaceId: string
  onClose: () => void
}): React.JSX.Element | null {
  const workspace = useDeck((s) => s.workspaces.find((w) => w.id === workspaceId))
  const profiles = useDeck((s) => s.profiles)
  const templates = useDeck((s) => s.templates)
  const saveTemplate = useDeck((s) => s.saveTemplate)
  const [name, setName] = useState(workspace?.name ?? '')

  const rows = useMemo(() => {
    if (!workspace) return []
    return workspace.panes.map((pane) => ({
      id: pane.id,
      label: paneLabel(pane.name, profiles.find((p) => p.id === pane.profileId)?.name, pane.command),
      // A worktree is this workspace's own directory; the template can only
      // record that the pane wanted one, so say that rather than a path.
      folder: pane.worktree ? 'a worktree of it' : folderLabel(relativeCwd(workspace.cwd, pane.cwd))
    }))
  }, [workspace, profiles])

  if (!workspace) return null

  const label = name.trim() || workspace.name
  const replaces = templates.some((t) => t.name === label)

  const save = (): void => {
    saveTemplate(workspace.id, label)
    onClose()
  }

  return (
    <Modal
      title="Save as template"
      onClose={onClose}
      footer={
        <>
          <span className="foot-note">
            {replaces ? `Replaces the template already called “${label}”.` : ''}
          </span>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            Save template
          </button>
        </>
      }
    >
      <Field
        label="Name"
        hint="A template keeps the panes, the layout and the accent — everything but the folder."
      >
        <input
          autoFocus
          value={name}
          placeholder={workspace.name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') save()
          }}
        />
      </Field>

      <div className="field">
        <span className="field-label">
          {rows.length ? `${rows.length} pane${rows.length === 1 ? '' : 's'}` : 'No panes'}
        </span>
        {rows.length ? (
          <div className="tpl-panes">
            {rows.map((row) => (
              <div className="tpl-pane" key={row.id}>
                <span className="tpl-pane-name">{row.label}</span>
                <span className="tpl-pane-dir">{row.folder}</span>
              </div>
            ))}
          </div>
        ) : null}
        <span className="field-hint">
          Pane folders are kept relative to <code>{workspace.cwd}</code>, so the same set of panes can
          be pointed at another repo. A pane outside that folder comes back to the root.
        </span>
      </div>
    </Modal>
  )
}

export function TemplatePicker({ onClose }: { onClose: () => void }): React.JSX.Element {
  const templates = useDeck((s) => s.templates)
  const removeTemplate = useDeck((s) => s.removeTemplate)
  const newWorkspaceFromTemplate = useDeck((s) => s.newWorkspaceFromTemplate)
  const defaultCwd = useDeck((s) => s.settings.defaultCwd)
  const [busy, setBusy] = useState(false)

  const instantiate = async (id: string): Promise<void> => {
    const dir = await api.pickDirectory(defaultCwd)
    if (!dir) return
    setBusy(true)
    // A folder the template cannot be built against leaves the picker open, so
    // the answer to the dialog that just said so is to pick another one.
    const created = await newWorkspaceFromTemplate(id, dir)
    setBusy(false)
    if (created) onClose()
  }

  return (
    <Modal
      title="New workspace from template"
      onClose={onClose}
      footer={
        <button className="btn ghost" onClick={onClose}>
          Close
        </button>
      }
    >
      {templates.length ? (
        <div className="tpl-list">
          {templates.map((template) => (
            <div className="tpl-row" key={template.id}>
              <button
                className="tpl-pick"
                disabled={busy}
                onClick={() => void instantiate(template.id)}
                title="Choose a folder and open this template against it"
              >
                <span className="tpl-mark" style={{ background: template.accent }} />
                <span className="tpl-text">
                  <span className="tpl-name">{template.name}</span>
                  <span className="tpl-detail">
                    {savedOn(template.createdAt)} · {template.panes.length} pane
                    {template.panes.length === 1 ? '' : 's'} ·{' '}
                    {template.panes.map((pane) => pane.name || pane.command).join(', ') || 'empty'}
                  </span>
                </span>
                <Icon name="folder" />
              </button>
              <button
                className="icon-btn danger"
                title="Forget this template"
                onClick={async () => {
                  const ok = await api.confirm({
                    title: 'Forget template',
                    message: `Forget “${template.name}”?`,
                    detail: 'Workspaces already made from it are not touched.',
                    confirmLabel: 'Forget'
                  })
                  if (ok) removeTemplate(template.id)
                }}
              >
                <Icon name="trash" size={13} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="tpl-empty">
          No templates yet. Save one from a workspace's menu in the sidebar — it keeps the panes and
          the layout without the folder, so you can open the same setup against another repo.
        </p>
      )}
    </Modal>
  )
}
