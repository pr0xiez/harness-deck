import { useMemo, useState } from 'react'
import type { Profile } from '@shared/types'
import { useDeck } from '../store'
import { Dropdown } from './ui'
import { PaneDialog } from './PaneDialog'
import { Icon } from './Icon'

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
  const removeLauncher = useDeck((s) => s.removeLauncher)
  const [customOpen, setCustomOpen] = useState(false)

  const groups = useMemo<Group[]>(() => {
    const native = profiles.filter((p) => p.kind === 'agent' && !p.id.startsWith('wsl:'))
    const wsl = profiles.filter((p) => p.kind === 'agent' && p.id.startsWith('wsl:'))
    // The bare `custom` entry is the "Custom command…" action at the foot of the
    // menu, not a launcher anyone saved.
    const saved = profiles.filter((p) => p.id.startsWith('custom:'))
    const shells = profiles.filter((p) => p.kind === 'shell')
    return [
      { label: 'Coding agents', profiles: native },
      ...(wsl.length ? [{ label: 'Inside WSL', profiles: wsl }] : []),
      ...(saved.length ? [{ label: 'Saved launchers', profiles: saved }] : []),
      { label: 'Shells', profiles: shells }
    ]
  }, [profiles])

  const add = (profile: Profile): void => {
    addPane(workspaceId, profile)
    onClose()
  }

  if (customOpen) {
    return (
      <PaneDialog
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
              {profile.id.startsWith('custom:') ? (
                // A span, because a launcher row is itself a button — and
                // forgetting the launcher leaves any pane opened from it alone.
                <span
                  className="icon-btn tiny danger menu-forget"
                  role="button"
                  title={`Forget ${profile.name}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    void removeLauncher(profile.id)
                  }}
                >
                  <Icon name="trash" size={11} />
                </span>
              ) : null}
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
