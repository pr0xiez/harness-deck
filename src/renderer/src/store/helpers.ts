import type { Pane, PaneStatus, Profile, Workspace } from '@shared/types'
import { ACCENTS } from '../theme'

export const api = window.harness

/** The long leg of the snooze cycle. Long enough to be a decision, short enough to forget. */
export const SNOOZE_MS = 60 * 60 * 1000

/** Panes carry a bit of state we never want to write to disk. */
export interface StoredPane extends Omit<Pane, 'status' | 'exitCode' | 'activity' | 'bell' | 'processTitle'> {
  autostart?: boolean
}

export interface PaneView extends Pane {
  autostart?: boolean
  /**
   * Never written to disk — the pane exists for one run of one command (the
   * ship pane, HD-18). A persisted copy would autostart on relaunch and run
   * the command again against whatever the folder holds by then, which for a
   * commit-and-push chain is a repo mutation nobody asked for.
   */
  transient?: boolean
  /**
   * Auto-restarts spent on the crash loop the pane is in. Transient on purpose:
   * a pane that comes back with the app is starting fresh, not resuming a loop
   * whose process died before the window closed.
   */
  crashRestarts?: number
  /**
   * When the pane last went quiet — the queue's ordering, oldest first. The
   * three fields below are the same bargain as `crashRestarts`: how you felt
   * about a prompt an hour ago is not something a restart should inherit, so
   * none of them are persisted. Only `attentionMuted` is, on `Pane`.
   */
  waitingSince?: number
  /** Seen it. Cleared the next time the pane goes quiet — a fresh stop is fresh news. */
  acknowledged?: boolean
  /** Not now: until this pane next goes quiet, or until a wall-clock moment. */
  snooze?: 'quiet' | number
  /** The bell cut a snooze short: this pane raised its hand while you were away. */
  woke?: boolean
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

/**
 * Is this pane's snooze still in force? "Until next quiet" runs until the quiet
 * handler lifts it; an hour-long one expires on its own, and is re-read rather
 * than cleared on a timer — nothing else in the app is waiting on the moment it
 * lapses, and the next thing that touches the store notices.
 */
export function isSnoozed(pane: PaneView, now: number = Date.now()): boolean {
  if (pane.snooze === undefined) return false
  return pane.snooze === 'quiet' || pane.snooze > now
}

/**
 * The one question every aggregate is really asking: does this pane want you,
 * *and* have you not already said otherwise? The dock badge, the sidebar counts,
 * the title-bar Waiting button, the palette hint and Ctrl+Shift+J all run on
 * this, so muting a pane, snoozing it or acknowledging it takes it out of all
 * five at once.
 *
 * The waiting queue itself is deliberately looser — it still shows what you
 * acknowledged, dimmed — and a pane's own amber header dot is looser still: that
 * is the local truth, and muting is about the aggregates, not about lying to the
 * pane you are looking at.
 */
export function isActionable(pane: PaneView, now: number = Date.now()): boolean {
  return (
    pane.status === 'waiting' &&
    !pane.attentionMuted &&
    !pane.acknowledged &&
    !isSnoozed(pane, now)
  )
}
