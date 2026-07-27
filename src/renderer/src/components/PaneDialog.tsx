import { useMemo, useState } from 'react'
import { buildRemote, parseRemote, type RemoteKind } from '@shared/remote'
import type { SavedProfile } from '@shared/types'
import { useDeck } from '../store'
import { RESTART_CAP } from '../restart'
import { Field, Modal, Toggle } from './ui'
import { Icon } from './Icon'

const api = window.harness

/** Where a pane's process runs. `local` is this machine, and the default. */
type Where = RemoteKind | 'local'

const WHERE: Array<[Where, string]> = [
  ['local', 'This machine'],
  ['ssh', 'SSH host'],
  ['docker', 'Container']
]

/** Remote panes are worth telling apart at a glance, so they keep their own. */
const REMOTE_LOOK: Record<RemoteKind, { icon: string; accent: string }> = {
  ssh: { icon: 'SS', accent: '#38bdf8' },
  docker: { icon: 'DK', accent: '#2496ed' }
}

interface Props {
  workspaceId: string
  /** Set when the dialog is editing a pane that already exists. */
  paneId?: string
  /** Opens straight onto a remote pane, from the harness menu's own entries. */
  where?: Where
  onClose: () => void
}

interface EnvRow {
  /** Rows are edited by position, and two blank keys must stay distinguishable. */
  key: number
  name: string
  value: string
}

let rowSeq = 0
const makeRow = (name = '', value = ''): EnvRow => ({ key: (rowSeq += 1), name, value })

/** Two letters for the pane badge, from the launcher's name. */
function badgeFor(name: string, fallback: string): string {
  const words = (name.trim() || fallback.trim()).split(/\s+/).filter(Boolean)
  const letters = words.length > 1 ? `${words[0][0]}${words[1][0]}` : (words[0] ?? '»').slice(0, 2)
  return letters.toUpperCase() || '»'
}

function collectEnv(rows: EnvRow[]): Record<string, string> | undefined {
  const env: Record<string, string> = {}
  for (const row of rows) {
    const name = row.name.trim()
    // The value is taken verbatim — an `=` or a quote inside it is data, and
    // there is no KEY=VALUE line anywhere on the way to the process to re-parse.
    if (name) env[name] = row.value
  }
  return Object.keys(env).length ? env : undefined
}

function sameEnv(a: Record<string, string> = {}, b: Record<string, string> = {}): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key])
}

/**
 * One dialog, two jobs: edit the pane in front of you, and keep what you typed
 * as a launcher you can click again tomorrow. "Runs on" makes a third out of
 * the same form rather than a second dialog — an SSH or container pane is this
 * one's command line with a longer way of getting to it.
 */
export function PaneDialog({ workspaceId, paneId, where: opensOn, onClose }: Props): React.JSX.Element {
  const workspace = useDeck((s) => s.workspaces.find((w) => w.id === workspaceId))
  const pane = useDeck((s) =>
    s.workspaces.flatMap((w) => w.panes).find((p) => p.id === paneId)
  )
  const profiles = useDeck((s) => s.profiles)
  const addPane = useDeck((s) => s.addPane)
  const updatePane = useDeck((s) => s.updatePane)
  const restartPane = useDeck((s) => s.restartPane)
  const saveLauncher = useDeck((s) => s.saveLauncher)

  // A remote pane's argv is not something anyone should have to read, so it is
  // taken apart back into the fields that built it.
  const remote = pane ? parseRemote(pane.command, pane.args) : null
  const initialLine = remote
    ? remote.cmdline
    : pane
      ? `${pane.command} ${pane.args.join(' ')}`.trim()
      : ''

  const [where, setWhere] = useState<Where>(remote?.target.kind ?? opensOn ?? 'local')
  const [host, setHost] = useState(remote?.target.host ?? '')
  const [there, setThere] = useState(remote?.target.dir ?? '')
  const [remoteShell, setRemoteShell] = useState(remote?.target.shell ?? '')
  const [line, setLine] = useState(initialLine)
  const [name, setName] = useState(pane?.name ?? '')
  const [cwd, setCwd] = useState(pane?.cwd ?? workspace?.cwd ?? '')
  const [rows, setRows] = useState<EnvRow[]>(() =>
    Object.entries(pane?.env ?? {}).map(([key, value]) => makeRow(key, value))
  )
  const [reveal, setReveal] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const [autoRestart, setAutoRestart] = useState(Boolean(pane?.autoRestart))
  const [readOnly, setReadOnly] = useState(Boolean(pane?.readOnly))

  const cmdline = line.trim()
  const env = useMemo(() => collectEnv(rows), [rows])

  // A remote pane's argv is built, never typed. Locally, leaving the command
  // line alone keeps the pane's own argv, which matters for the profiles that
  // carry one — a WSL launcher's quoted `bash -lic …` does not survive being
  // flattened to a string and split again.
  const spec =
    where !== 'local'
      ? {
          ...buildRemote({ kind: where, host, dir: there, shell: remoteShell }, cmdline),
          viaShell: false
        }
      : pane && !remote && cmdline === initialLine
        ? { command: pane.command, args: pane.args, viaShell: pane.viaShell }
        : { command: cmdline, args: [] as string[], viaShell: true }

  // A remote pane is named by where it runs; a local one has to have a command.
  const target = host.trim()
  const ready = where === 'local' ? Boolean(cmdline) : Boolean(target)
  const autoName =
    where === 'local'
      ? cmdline.split(/\s+/)[0]
      : `${cmdline.split(/\s+/)[0] || 'shell'} ${where === 'ssh' ? '@' : 'in'} ${target}`

  const patchRow = (key: number, patch: Partial<EnvRow>): void =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)))

  const apply = (): void => {
    if (!ready) return
    if (pane) {
      const respawn =
        spec.command !== pane.command ||
        spec.args.join('\0') !== pane.args.join('\0') ||
        Boolean(spec.viaShell) !== Boolean(pane.viaShell) ||
        cwd !== pane.cwd ||
        !sameEnv(env, pane.env)
      updatePane(pane.id, {
        ...spec,
        cwd,
        env,
        autoRestart,
        readOnly,
        name: name.trim() || undefined
      })
      // Command line, folder and environment are all read at spawn time only,
      // so anything else is a rename and must not kill a working agent.
      if (respawn) restartPane(pane.id)
    } else {
      const custom = profiles.find((p) => p.id === 'custom')
      if (!custom) return
      addPane(workspaceId, custom, {
        ...spec,
        cwd,
        env,
        autoRestart,
        readOnly,
        name: name.trim() || autoName
      })
    }
    onClose()
  }

  const keep = (): void => {
    if (!ready) return
    // Saving a pane that came from a launcher edits that launcher rather than
    // leaving a near-duplicate behind.
    const existing = pane?.profileId.startsWith('custom:') ? pane.profileId : null
    const label = name.trim() || autoName
    const look = where === 'local' ? null : REMOTE_LOOK[where]
    const profile: SavedProfile = {
      id: existing ?? `custom:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name: label,
      ...spec,
      ...(cwd ? { cwd } : {}),
      ...(env ? { env } : {}),
      icon: look?.icon ?? badgeFor(label, cmdline),
      accent: look?.accent ?? '#94a3b8'
    }
    void saveLauncher(profile)
    setSaved(label)
  }

  return (
    <Modal
      title={pane ? 'Edit pane' : 'New pane'}
      onClose={onClose}
      footer={
        <>
          <button
            className="btn subtle"
            onClick={keep}
            disabled={!ready}
            title="Keep this as a launcher in the harness menu"
          >
            <Icon name="plus" />
            <span>Save as launcher</span>
          </button>
          <span className="foot-note">
            {saved ? `“${saved}” is in the harness menu.` : ''}
          </span>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={apply} disabled={!ready}>
            {pane ? 'Apply' : 'Open pane'}
          </button>
        </>
      }
    >
      <div className="field">
        <span className="field-label">Runs on</span>
        <div className="segmented wide" role="group" aria-label="Where the process runs">
          {WHERE.map(([value, label]) => (
            <button
              key={value}
              className={where === value ? 'on' : ''}
              onClick={() => setWhere(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {where !== 'local' ? (
        <div className="row fields">
          <Field
            label={where === 'ssh' ? 'Host' : 'Container'}
            hint={
              where === 'ssh'
                ? 'Whatever you would type after ssh — a name from your ssh config, or user@host.'
                : 'A running container, by name or id. Nothing here is guessed for you.'
            }
          >
            <input
              autoFocus
              value={host}
              placeholder={where === 'ssh' ? 'build-box  ·  me@10.0.0.4' : 'web-1'}
              spellCheck={false}
              onChange={(event) => setHost(event.target.value)}
            />
          </Field>
          <Field
            label="Directory over there"
            hint={
              where === 'ssh'
                ? 'Optional. Left empty it tries this pane’s folder (needs AcceptEnv HD_CWD on the server) and otherwise stays where you land.'
                : 'Optional. Left empty it tries this pane’s folder, which lands when the project is bind-mounted at the same path.'
            }
          >
            <input
              value={there}
              placeholder="login directory"
              spellCheck={false}
              onChange={(event) => setThere(event.target.value)}
            />
          </Field>
          {where === 'docker' ? (
            <Field label="Shell" hint="Inside the image.">
              <input
                value={remoteShell}
                placeholder="bash"
                spellCheck={false}
                onChange={(event) => setRemoteShell(event.target.value)}
              />
            </Field>
          ) : null}
        </div>
      ) : null}

      <Field
        label="Command line"
        hint={
          where !== 'local'
            ? 'Runs through a login shell over there. Leave it empty for a plain shell.'
            : pane && cmdline === initialLine
              ? 'Unchanged, so the pane keeps its own arguments. Editing it runs the line through your login shell.'
              : 'Runs through your login shell, so aliases and functions work.'
        }
      >
        <input
          autoFocus={where === 'local'}
          value={line}
          placeholder="claude --resume  ·  npm run dev  ·  git log --oneline"
          onChange={(event) => setLine(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') apply()
          }}
        />
      </Field>

      <Field label="Name" hint="Optional. Shown in the pane header, and in the menu once saved.">
        <input value={name} placeholder="auto" onChange={(event) => setName(event.target.value)} />
      </Field>

      <Field
        label="Working directory"
        hint={
          where !== 'local'
            ? 'A folder on this machine. A remote pane cannot start in it, so it is handed over as $HD_CWD instead.'
            : undefined
        }
      >
        <div className="row">
          <input value={cwd} onChange={(event) => setCwd(event.target.value)} />
          <button
            className="btn subtle"
            title="Choose a folder"
            onClick={async () => {
              const dir = await api.pickDirectory(cwd)
              if (dir) setCwd(dir)
            }}
          >
            <Icon name="folder" />
          </button>
        </div>
      </Field>

      <div className="field">
        <span className="field-label env-head">
          <span>Environment</span>
          {rows.length ? (
            <button className="btn tiny ghost" onClick={() => setReveal((v) => !v)}>
              {reveal ? 'Hide values' : 'Reveal values'}
            </button>
          ) : null}
        </span>

        {rows.length ? (
          <div className="env-table">
            {rows.map((row) => (
              <div className="env-row" key={row.key}>
                <input
                  className="env-name"
                  value={row.name}
                  placeholder="ANTHROPIC_MODEL"
                  spellCheck={false}
                  onChange={(event) => patchRow(row.key, { name: event.target.value })}
                />
                <input
                  className="env-value"
                  type={reveal ? 'text' : 'password'}
                  value={row.value}
                  placeholder="value"
                  spellCheck={false}
                  onChange={(event) => patchRow(row.key, { value: event.target.value })}
                />
                <button
                  className="icon-btn danger"
                  title="Remove variable"
                  onClick={() => setRows((current) => current.filter((r) => r.key !== row.key))}
                >
                  <Icon name="close" size={12} />
                </button>
              </div>
            ))}
          </div>
        ) : null}

        <button
          className="btn subtle env-add"
          onClick={() => setRows((current) => [...current, makeRow()])}
        >
          <Icon name="plus" />
          <span>Add variable</span>
        </button>

        <span className="field-hint">
          Set for this pane's process only, on top of your login-shell environment. A saved launcher
          keeps them in <code>custom-profiles.json</code> in plain text — there is no keychain behind
          this box.
        </span>
      </div>

      <Toggle
        checked={autoRestart}
        onChange={setAutoRestart}
        label="Restart it when it crashes"
        hint={`Only on a non-zero exit, ${RESTART_CAP} times with a growing wait, then it stops and says so. Quitting the process yourself leaves the pane where you left it.`}
      />

      <Toggle
        checked={readOnly}
        onChange={setReadOnly}
        label="Read-only"
        hint="Refuses typing, paste, broadcast and dictation, for a build or a production shell you must not disturb. Reading it — scrolling, selecting, copying, the transcript — is unaffected, and so are restarting and closing the pane."
      />
    </Modal>
  )
}
