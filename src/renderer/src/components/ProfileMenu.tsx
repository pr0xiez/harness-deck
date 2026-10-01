import { useEffect, useMemo, useState } from 'react'
import type { RemoteKind } from '@shared/remote'
import type { Profile } from '@shared/types'
import { isOpencodeProfile } from '@shared/opencode'
import { isRouterProfile } from '@shared/openrouter'
import { worktreeBranch, worktreePath } from '@shared/worktree'
import { useDeck } from '../store'
import { Dropdown } from './ui'
import { PaneDialog } from './PaneDialog'
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
  const cwd = useDeck((s) => s.workspaces.find((w) => w.id === workspaceId)?.cwd ?? '')
  const setupCommand = useDeck(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.setupCommand ?? ''
  )
  const repo = useDeck((s) => s.repos[cwd] ?? null)
  const refreshRepo = useDeck((s) => s.refreshRepo)
  const addPane = useDeck((s) => s.addPane)
  const refreshProfiles = useDeck((s) => s.refreshProfiles)
  const removeLauncher = useDeck((s) => s.removeLauncher)
  const favoriteProfileIds = useDeck((s) => s.settings.favoriteProfileIds)
  const updateSettings = useDeck((s) => s.updateSettings)
  const setUi = useDeck((s) => s.setUi)
  const [dialogFor, setDialogFor] = useState<'local' | RemoteKind | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Opening the menu is as good a moment as any to re-ask: the folder may have
  // become a repo, or stopped being one, since the toolbar last looked.
  useEffect(() => {
    void refreshRepo(cwd)
  }, [cwd, refreshRepo])

  const groups = useMemo<Group[]>(() => {
    const native = profiles.filter((p) => p.kind === 'agent' && !p.id.startsWith('wsl:'))
    const wsl = profiles.filter((p) => p.kind === 'agent' && p.id.startsWith('wsl:'))
    // The bare `custom` entry is the "Custom command…" action at the foot of the
    // menu, not a launcher anyone saved.
    const saved = profiles.filter((p) => p.id.startsWith('custom:'))
    const shells = profiles.filter((p) => p.kind === 'shell')
    const favorites = favoriteProfileIds
      .map((id) => profiles.find((profile) => profile.id === id))
      .filter((profile): profile is Profile => Boolean(profile))
    return [
      ...(favorites.length ? [{ label: 'Favorites', profiles: favorites }] : []),
      { label: 'Coding agents', profiles: native },
      ...(wsl.length ? [{ label: 'Inside WSL', profiles: wsl }] : []),
      ...(saved.length ? [{ label: 'Saved launchers', profiles: saved }] : []),
      { label: 'Shells', profiles: shells }
    ]
  }, [favoriteProfileIds, profiles])

  const toggleFavorite = (profileId: string): void => {
    updateSettings({
      favoriteProfileIds: favoriteProfileIds.includes(profileId)
        ? favoriteProfileIds.filter((id) => id !== profileId)
        : [...favoriteProfileIds, profileId]
    })
  }

  const add = (profile: Profile): void => {
    addPane(workspaceId, profile)
    onClose()
  }

  /**
   * The point of the whole feature: this pane gets a checkout of its own, so two
   * agents on one task stop overwriting each other. The branch it lands on may
   * come back numbered — the repo, not the menu, knows what is already taken.
   */
  const addInWorktree = async (profile: Profile): Promise<void> => {
    if (!repo || busy) return
    setBusy(profile.id)
    setError(null)
    const branch = worktreeBranch(profile.name)
    const result = await api.git.addWorktree({
      repo: repo.root,
      branch,
      path: worktreePath(repo.root, branch)
    })
    setBusy(null)
    if (!result.ok || !result.path) {
      setError(result.error || 'git would not create the worktree.')
      return
    }
    // Two panes running the same harness are only told apart by the tree they
    // are in, and when the repo already held that branch it is the number git
    // handed out that differs — so the header says which one this is.
    const folder = result.path.split(/[\\/]/).filter(Boolean).pop() ?? branch
    addPane(workspaceId, profile, {
      cwd: result.path,
      worktree: result.path,
      name: `${profile.name} · ${folder}`,
      // A brand-new checkout has no node_modules and no build, and three agents
      // discovering that separately is three different guesses at the install.
      // The pane runs the workspace's answer first, in front of you. See HD-16.
      ...(setupCommand ? { setup: setupCommand } : {})
    })
    onClose()
  }

  if (dialogFor) {
    return (
      <PaneDialog
        workspaceId={workspaceId}
        where={dialogFor}
        onClose={() => {
          setDialogFor(null)
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
              <span className="menu-actions">
                <span
                  className={`icon-btn tiny menu-favorite ${favoriteProfileIds.includes(profile.id) ? 'on' : ''}`}
                  role="button"
                  aria-label={`${favoriteProfileIds.includes(profile.id) ? 'Remove' : 'Add'} ${profile.name} ${
                    favoriteProfileIds.includes(profile.id) ? 'from' : 'to'
                  } favorites`}
                  title={`${favoriteProfileIds.includes(profile.id) ? 'Remove from' : 'Add to'} favorites`}
                  onClick={(event) => {
                    event.stopPropagation()
                    toggleFavorite(profile.id)
                  }}
                >
                  <Icon name="star" size={11} />
                </span>
                {repo && profile.kind === 'agent' ? (
                  // Spans, because the row is itself a button.
                  <span
                    className={`icon-btn tiny menu-worktree ${busy === profile.id ? 'busy' : ''}`}
                    role="button"
                    title={`Open ${profile.name} in a worktree of its own, branched off ${repo.branch}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      void addInWorktree(profile)
                    }}
                  >
                    <Icon name="branch" size={11} />
                  </span>
                ) : null}
                {isOpencodeProfile(profile.id) ? (
                  // OpenCode's options are worth showing before the pane opens;
                  // a plain click on the row launches exactly as it always has.
                  <span
                    className="icon-btn tiny menu-worktree"
                    role="button"
                    title={`Open ${profile.name} with options — model, agent, session, prompt`}
                    onClick={(event) => {
                      event.stopPropagation()
                      setUi({ opencodeFor: { workspaceId, profileId: profile.id } })
                    }}
                  >
                    <Icon name="settings" size={11} />
                  </span>
                ) : null}
                {isRouterProfile(profile.id) ? (
                  <span className="icon-btn tiny menu-worktree" role="button"
                    aria-label={`Open ${profile.name} with provider options`}
                    title={`Open ${profile.name} with provider options — OpenRouter, model`}
                    onClick={event => {
                      event.stopPropagation()
                      setUi({ routerFor: { workspaceId, profileId: profile.id } })
                      onClose()
                    }}>
                    <Icon name="settings" size={11} />
                  </span>
                ) : null}
                {profile.id.startsWith('custom:') ? (
                  // Forgetting the launcher leaves any pane opened from it alone.
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
              </span>
            </button>
          ))}
        </div>
      ))}

      {repo ? (
        <div className="menu-note">
          <Icon name="branch" size={11} />
          <span>
            {busy ? (
              'Creating the worktree…'
            ) : setupCommand ? (
              <>
                opens the agent in its own worktree, after <code>{setupCommand}</code> has run in it.
              </>
            ) : (
              'opens the agent in its own worktree, so two of them can work at once.'
            )}
          </span>
        </div>
      ) : null}
      {error ? <div className="menu-note bad">{error}</div> : null}

      <div className="menu-sep" />
      <button className="menu-item" onClick={() => setDialogFor('local')}>
        <span className="profile-badge" style={{ ['--badge' as string]: '#94a3b8' }}>
          »
        </span>
        <span className="profile-text">
          <span className="profile-name">Custom command…</span>
          <span className="profile-detail">Any command line, in a login shell</span>
        </span>
      </button>
      {/* No list to pick from: a container probe hangs on a wedged daemon and an
          ssh config is a parser, so the host is typed and kept as a launcher. */}
      <button className="menu-item" onClick={() => setDialogFor('ssh')}>
        <span className="profile-badge" style={{ ['--badge' as string]: '#38bdf8' }}>
          SS
        </span>
        <span className="profile-text">
          <span className="profile-name">Over SSH…</span>
          <span className="profile-detail">A harness on another machine</span>
        </span>
      </button>
      <button className="menu-item" onClick={() => setDialogFor('docker')}>
        <span className="profile-badge" style={{ ['--badge' as string]: '#2496ed' }}>
          DK
        </span>
        <span className="profile-text">
          <span className="profile-name">In a container…</span>
          <span className="profile-detail">docker exec into a running container</span>
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
