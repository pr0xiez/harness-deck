import { useMemo, useState } from 'react'
import type { Profile } from '@shared/types'
import { useDeck } from '../store'
import { Dropdown, Field, Modal } from './ui'
import { Icon } from './Icon'

const api = window.harness

interface Props {
  workspaceId: string
  onClose: () => void
  align?: 'left' | 'right'
}

interface Group {
  label: string
  profiles: Profile[]
}

export function ProfileMenu({ workspaceId, onClose, align = 'right' }: Props): React.JSX.Element {
  const profiles = useDeck((s) => s.profiles)
  const addPane = useDeck((s) => s.addPane)
  const refreshProfiles = useDeck((s) => s.refreshProfiles)
  const [customOpen, setCustomOpen] = useState(false)

  const groups = useMemo<Group[]>(() => {
    const native = profiles.filter((p) => p.kind === 'agent' && !p.id.startsWith('wsl:'))
    const wsl = profiles.filter((p) => p.kind === 'agent' && p.id.startsWith('wsl:'))
    const shells = profiles.filter((p) => p.kind === 'shell')
    return [
      { label: 'Coding agents', profiles: native },
      ...(wsl.length ? [{ label: 'Inside WSL', profiles: wsl }] : []),
      { label: 'Shells', profiles: shells }
    ]
  }, [profiles])

  const add = (profile: Profile): void => {
    addPane(workspaceId, profile)
    onClose()
  }

  if (customOpen) {
    return (
      <CustomCommandDialog
        workspaceId={workspaceId}
        onClose={() => {
          setCustomOpen(false)
          onClose()
        }}
      />
    )
  }

  return (
    <Dropdown onClose={onClose} align={align} className="profile-menu">
      {groups.map((group) => (
        <div key={group.label} className="menu-group">
          <div className="menu-label">{group.label}</div>
          {group.profiles.map((profile) => (
            <button
              key={profile.id}
              className={`menu-item profile ${profile.available ? '' : 'unavailable'}`}
              onClick={() => add(profile)}
              title={profile.detail}
            >
              <span className="profile-badge" style={{ ['--badge' as string]: profile.accent }}>
                {profile.icon}
              </span>
              <span className="profile-text">
                <span className="profile-name">{profile.name}</span>
                <span className="profile-detail">
                  {profile.available ? profile.detail : 'not installed — opens anyway'}
                </span>
              </span>
            </button>
          ))}
        </div>
      ))}

      <div className="menu-sep" />
      <button className="menu-item" onClick={() => setCustomOpen(true)}>
        <span className="profile-badge" style={{ ['--badge' as string]: '#94a3b8' }}>
          »
        </span>
        <span className="profile-text">
          <span className="profile-name">Custom command…</span>
          <span className="profile-detail">Any command line, in a login shell</span>
        </span>
      </button>
      <button
        className="menu-item"
        onClick={() => {
          void refreshProfiles()
          onClose()
        }}
      >
        <span className="profile-badge ghost">
          <Icon name="refresh" size={12} />
        </span>
        <span className="profile-text">
          <span className="profile-name">Rescan for harnesses</span>
          <span className="profile-detail">Re-check PATH and WSL</span>
        </span>
      </button>
    </Dropdown>
  )
}

interface CustomProps {
  workspaceId: string
  onClose: () => void
}

function CustomCommandDialog({ workspaceId, onClose }: CustomProps): React.JSX.Element {
  const workspace = useDeck((s) => s.workspaces.find((w) => w.id === workspaceId))
  const addPane = useDeck((s) => s.addPane)
  const profiles = useDeck((s) => s.profiles)
  const [command, setCommand] = useState('')
  const [name, setName] = useState('')
  const [cwd, setCwd] = useState(workspace?.cwd ?? '')

  const submit = (): void => {
    const cmdline = command.trim()
    if (!cmdline) return
    const custom = profiles.find((p) => p.id === 'custom')
    if (!custom) return
    addPane(workspaceId, custom, {
      command: cmdline,
      args: [],
      viaShell: true,
      cwd,
      name: name.trim() || cmdline.split(/\s+/)[0]
    })
    onClose()
  }

  return (
    <Modal
      title="Custom command"
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit} disabled={!command.trim()}>
            Open pane
          </button>
        </>
      }
    >
      <Field label="Command line" hint="Runs through your login shell, so aliases and functions work.">
        <input
          autoFocus
          value={command}
          placeholder="claude --resume  ·  npm run dev  ·  git log --oneline"
          onChange={(event) => setCommand(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit()
          }}
        />
      </Field>
      <Field label="Pane name" hint="Optional.">
        <input value={name} placeholder="auto" onChange={(event) => setName(event.target.value)} />
      </Field>
      <Field label="Working directory">
        <div className="row">
          <input value={cwd} onChange={(event) => setCwd(event.target.value)} />
          <button
            className="btn subtle"
            onClick={async () => {
              const dir = await api.pickDirectory(cwd)
              if (dir) setCwd(dir)
            }}
          >
            <Icon name="folder" />
          </button>
        </div>
      </Field>
    </Modal>
  )
}
