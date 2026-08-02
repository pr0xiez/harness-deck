import type { Pane, PaneStatus, Profile, Workspace } from '@shared/types'
import { ACCENTS } from '../theme'

export const api = window.harness

/** Panes carry a bit of state we never want to write to disk. */
export interface StoredPane extends Omit<Pane, 'status' | 'exitCode' | 'activity' | 'bell' | 'processTitle'> {
  autostart?: boolean
}

export interface PaneView extends Pane {
  autostart?: boolean
  /**
   * Auto-restarts spent on the crash loop the pane is in. Transient on purpose:
   * a pane that comes back with the app is starting fresh, not resuming a loop
   * whose process died before the window closed.
   */
  crashRestarts?: number
}

export interface DeckWorkspace extends Workspace {
  panes: PaneView[]
}

let idCounter = 0
export const uid = (prefix: string): string => {
  idCounter += 1
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 6)}`
}

export const shortName = (cwd: string): string => {
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || cwd || 'Workspace'
}

export function paneFromProfile(profile: Profile, cwd: string, overrides: Partial<PaneView> = {}): PaneView {
  return {
    id: uid('pane'),
    profileId: profile.id,
    command: profile.command,
    args: [...profile.args],
    viaShell: profile.viaShell,
    cwd,
    env: profile.env,
    // A saved launcher can be deleted while panes opened from it are still
    // running, so the pane keeps the label rather than looking it up later.
    ...(profile.id.startsWith('custom:') ? { name: profile.name } : {}),
    status: 'idle',
    exitCode: null,
    epoch: 0,
    autostart: true,
    ...overrides
  }
}

export function makeWorkspace(name: string, cwd: string, index: number): DeckWorkspace {
  return {
    id: uid('ws'),
    name,
    cwd,
    accent: ACCENTS[index % ACCENTS.length],
    panes: [],
    activePaneId: null,
    layout: 'grid',
    columns: 2,
    zoomedPaneId: null
  }
}

/**
 * A waiting pane is a running one that has gone quiet, so everything that asks
 * "is there still a process on the end of this?" — close prompts, broadcast
 * targets, the running count — has to count it.
 */
export const isLive = (pane: { status: PaneStatus }): boolean =>
  pane.status === 'running' || pane.status === 'waiting'
