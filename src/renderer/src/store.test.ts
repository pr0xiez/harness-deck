import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneStatus, PersistedState, PtyQuietEvent } from '@shared/types'
import { harness } from './test/harness'
import {
  actionableCount,
  activeWorkspace,
  DEFAULT_SETTINGS,
  isActionable,
  isLive,
  liveCount,
  onQuietPane,
  serialize,
  startAttention,
  totalActionableCount,
  totalLiveCount,
  useDeck,
  type DeckWorkspace,
  type PaneView
} from './store'

/**
 * The store reads `window.harness` while it is being imported, so the import at
 * the top of this file is itself part of what is under test: without the stub
 * the setup file installs, none of these tests would get as far as running.
 */

const pane = (id: string, status: PaneStatus, over: Partial<PaneView> = {}): PaneView => ({
  id,
  profileId: 'claude',
  command: 'claude',
  args: [],
  cwd: '/repos/deck',
  status,
  epoch: 0,
  ...over
})

const workspace = (
  id: string,
  panes: PaneView[] = [],
  over: Partial<DeckWorkspace> = {}
): DeckWorkspace => ({
  id,
  name: id,
  cwd: `/repos/${id}`,
  accent: '#7aa2f7',
  panes,
  activePaneId: panes[0]?.id ?? null,
  layout: 'grid',
  columns: 2,
  zoomedPaneId: null,
  ...over
})

/** Matches BROADCAST_HISTORY in store.ts. */
const BROADCAST_HISTORY = 50
/** Matches the debounce in `startPersistence`. */
const SAVE_MS = 400

const deck = (): ReturnType<typeof useDeck.getState> => useDeck.getState()
const ids = (): string[] => deck().workspaces.map((w) => w.id)
const paneIds = (workspaceId: string): string[] =>
  deck()
    .workspaces.find((w) => w.id === workspaceId)!
    .panes.map((p) => p.id)
const front = (): DeckWorkspace | undefined => activeWorkspace(deck())

beforeEach(() => {
  // The store is a module singleton, so one test's deck would otherwise still
  // be on screen for the next.
  useDeck.setState({
    workspaces: [],
    activeWorkspaceId: null,
    repos: {},
    mounted: [],
    templates: [],
    hydrated: false,
    settings: DEFAULT_SETTINGS
  })
})

describe('isLive', () => {
  it('counts a pane that has fallen quiet at a prompt, not only one still talking', () => {
    expect(isLive(pane('a', 'running'))).toBe(true)
    expect(isLive(pane('a', 'waiting'))).toBe(true)
  })

  it('does not count a pane with no process on the end of it', () => {
    expect(isLive(pane('a', 'idle'))).toBe(false)
    expect(isLive(pane('a', 'exited'))).toBe(false)
  })
})

describe('activeWorkspace', () => {
  it('picks the one the deck is pointed at, not the first on the list', () => {
    useDeck.setState({
      workspaces: [workspace('one'), workspace('two'), workspace('three')],
      activeWorkspaceId: 'two'
    })

    expect(activeWorkspace(useDeck.getState())?.id).toBe('two')
  })

  it('has no answer for a deck that is pointed at nothing', () => {
    useDeck.setState({ workspaces: [workspace('one')], activeWorkspaceId: null })

    expect(activeWorkspace(useDeck.getState())).toBeUndefined()
  })

  /** The gap between closing a workspace and the id being repointed. */
  it('has no answer for an id no workspace carries any more', () => {
    useDeck.setState({ workspaces: [workspace('one')], activeWorkspaceId: 'closed' })

    expect(activeWorkspace(useDeck.getState())).toBeUndefined()
  })
})

/** The bridge is stubbed, so this is where the stub earns its keep. */
describe('refreshRepo', () => {
  it('files what git said under the folder that was asked about', async () => {
    const repo = { root: '/repos/deck', branch: 'main', dirty: 2 }
    harness.git.info.mockResolvedValue(repo)

    await useDeck.getState().refreshRepo('/repos/deck/src')

    expect(harness.git.info).toHaveBeenCalledWith('/repos/deck/src')
    expect(useDeck.getState().repos).toEqual({ '/repos/deck/src': repo })
  })

  it('does not ask git about a pane that has no folder', async () => {
    await useDeck.getState().refreshRepo('')

    expect(harness.git.info).not.toHaveBeenCalled()
    expect(useDeck.getState().repos).toEqual({})
  })
})

/**
 * Everything the app remembers about itself goes through here, so a field this
 * function drops is a field the user loses on quit — silently, and only visible
 * the next time they open the app.
 */
describe('serialize', () => {
  const saved = (): PersistedState => serialize(useDeck.getState())
  const firstPane = (): PersistedState['workspaces'][number]['panes'][number] =>
    saved().workspaces[0].panes[0]

  it('writes a pane down as idle, whatever its process was doing at the time', () => {
    useDeck.setState({
      workspaces: [workspace('one', [pane('a', 'exited', { exitCode: 137, epoch: 3 })])]
    })

    expect(firstPane()).toMatchObject({ status: 'idle', exitCode: null, epoch: 0 })
  })

  /**
   * A restored deck claiming an exit code, an unread badge or a process title
   * from a process that died with the last session is worse than saying
   * nothing: it is a pane that looks alive and answers to nothing.
   */
  it('does not carry over what the last session happened to leave on screen', () => {
    useDeck.setState({
      workspaces: [
        workspace('one', [
          pane('a', 'running', {
            activity: true,
            bell: true,
            processTitle: 'claude — /repos/deck',
            autostart: true,
            crashRestarts: 2
          })
        ])
      ]
    })

    expect(firstPane()).not.toHaveProperty('activity')
    expect(firstPane()).not.toHaveProperty('bell')
    expect(firstPane()).not.toHaveProperty('processTitle')
    expect(firstPane()).not.toHaveProperty('autostart')
    expect(firstPane()).not.toHaveProperty('crashRestarts')
  })

  /**
   * The one piece of per-pane state that has to survive even though the pane
   * itself does not: the worktree is a folder this app made, and only the pane
   * that owns it will ever offer to remove it. Forget it on quit and the
   * checkout is orphaned on disk with nothing left that knows it is ours.
   */
  /**
   * The ship pane runs a commit-and-push chain the user approved once. A
   * persisted copy would autostart on relaunch and run it again — against
   * whatever the tree holds by then, under the old message.
   */
  it('leaves a transient pane out entirely, and repoints the active id past it', () => {
    useDeck.setState({
      workspaces: [
        workspace(
          'one',
          [
            pane('a', 'waiting'),
            pane('ship', 'running', { command: 'git add -A', transient: true })
          ],
          { activePaneId: 'ship' }
        )
      ]
    })

    const ws = saved().workspaces[0]
    expect(ws.panes.map((p) => p.id)).toEqual(['a'])
    expect(ws.activePaneId).toBe('a')
  })

  it('keeps the worktree a pane owns even while stripping the rest of its state', () => {
    useDeck.setState({
      workspaces: [
        workspace('one', [
          pane('a', 'running', { worktree: '/repos/.harness-deck/deck/hd/agent-a' })
        ])
      ]
    })

    expect(firstPane().worktree).toBe('/repos/.harness-deck/deck/hd/agent-a')
    expect(firstPane().status).toBe('idle')
  })

  it('carries everything a pane needs to start again where it left off', () => {
    useDeck.setState({
      workspaces: [
        workspace('one', [
          {
            id: 'a',
            profileId: 'custom:reviewer',
            command: 'claude',
            args: ['--resume', 'last'],
            cwd: '/repos/deck/src',
            viaShell: true,
            name: 'Reviewer',
            env: { HD_ROLE: 'review' },
            worktree: '/repos/.harness-deck/deck/hd/reviewer',
            autoRestart: true,
            readOnly: true,
            attentionMuted: true,
            status: 'waiting',
            exitCode: 0,
            epoch: 7,
            // Transient attention state, which must not survive the restart the
            // rest of this pane is about to make.
            waitingSince: 1_700_000_000_000,
            acknowledged: true,
            snooze: 'quiet',
            woke: true
          }
        ])
      ]
    })

    // Spelled out in full rather than field by field, so a field quietly added
    // to the pane and forgotten here fails on the way past.
    expect(firstPane()).toEqual({
      id: 'a',
      profileId: 'custom:reviewer',
      command: 'claude',
      args: ['--resume', 'last'],
      cwd: '/repos/deck/src',
      viaShell: true,
      name: 'Reviewer',
      env: { HD_ROLE: 'review' },
      worktree: '/repos/.harness-deck/deck/hd/reviewer',
      autoRestart: true,
      readOnly: true,
      attentionMuted: true,
      status: 'idle',
      exitCode: null,
      epoch: 0
    })
  })

  /** Zoom is where you were looking, not how the workspace is arranged. */
  it('reopens a workspace unzoomed, however much of it one pane was filling', () => {
    useDeck.setState({
      workspaces: [
        workspace('one', [pane('a', 'idle'), pane('b', 'idle')], { zoomedPaneId: 'b' })
      ]
    })

    expect(saved().workspaces[0].zoomedPaneId).toBeNull()
  })

  it('saves the deck around the panes — the layout, the front workspace and the settings', () => {
    const template = {
      id: 'tpl_1',
      name: 'Review',
      accent: '#7aa2f7',
      layout: 'grid' as const,
      columns: 2,
      panes: [],
      createdAt: '2026-01-01T00:00:00.000Z'
    }
    useDeck.setState({
      workspaces: [
        workspace('one', [pane('a', 'idle')], {
          name: 'Deck',
          cwd: '/repos/deck',
          accent: '#bb9af7',
          layout: 'tabs',
          columns: 3,
          activePaneId: 'a'
        }),
        workspace('two')
      ],
      activeWorkspaceId: 'two',
      templates: [template],
      settings: { ...DEFAULT_SETTINGS, fontSize: 16 }
    })

    const state = saved()

    expect(state.version).toBe(1)
    expect(state.activeWorkspaceId).toBe('two')
    expect(state.templates).toEqual([template])
    expect(state.settings.fontSize).toBe(16)
    expect(state.workspaces[0]).toMatchObject({
      id: 'one',
      name: 'Deck',
      cwd: '/repos/deck',
      accent: '#bb9af7',
      layout: 'tabs',
      columns: 3,
      activePaneId: 'a'
    })
  })
})

/**
 * `saveTimer` and `lastSnapshot` live at module scope, so a timer armed — or a
 * snapshot remembered — by one test would decide the outcome of the next: a
 * test whose deck happened to serialize to the same JSON as its predecessor's
 * would see no write and blame the code. Re-importing the module behind
 * `vi.resetModules()` is the reset. Each test gets its own store, its own timer
 * handle and its own empty `lastSnapshot`, and the subscription it starts is on
 * a store nothing outside the test will ever touch again.
 */
describe('startPersistence', () => {
  let store: typeof import('./store')
  let stop: () => void

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.resetModules()
    store = await import('./store')
    stop = store.startPersistence()
  })

  afterEach(() => {
    stop()
    vi.useRealTimers()
  })

  const written = (n = 0): PersistedState => harness.saveState.mock.calls[n][0] as PersistedState

  /**
   * The deck is empty until `hydrate()` has read the file. Saving in that
   * window would write the empty deck over the workspaces still being loaded —
   * the one bug in here that costs the user everything at once.
   */
  it('writes nothing before the deck has been read back off disk', () => {
    store.useDeck.setState({ workspaces: [workspace('one', [pane('a', 'idle')])] })
    vi.advanceTimersByTime(SAVE_MS * 5)

    expect(harness.saveState).not.toHaveBeenCalled()
  })

  it('waits for the deck to settle before writing at all', () => {
    store.useDeck.setState({ hydrated: true, workspaces: [workspace('one')] })

    vi.advanceTimersByTime(SAVE_MS - 1)
    expect(harness.saveState).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(harness.saveState).toHaveBeenCalledTimes(1)
  })

  /** Renaming a workspace is a keystroke per character; the file is not. */
  it('collapses a run of changes into one write, however long the run goes on', () => {
    store.useDeck.setState({ hydrated: true })
    for (let n = 0; n < 5; n++) {
      store.useDeck.getState().addWorkspace(`Workspace ${n}`)
      vi.advanceTimersByTime(SAVE_MS - 1)
    }

    expect(harness.saveState).not.toHaveBeenCalled()

    vi.advanceTimersByTime(SAVE_MS)
    expect(harness.saveState).toHaveBeenCalledTimes(1)
    expect(written().workspaces).toHaveLength(5)
  })

  it('writes the deck as it ended up, not as it was when the timer was armed', () => {
    store.useDeck.setState({ hydrated: true, workspaces: [workspace('one')] })
    vi.advanceTimersByTime(SAVE_MS - 1)
    store.useDeck.getState().updateWorkspace('one', { name: 'renamed' })
    vi.advanceTimersByTime(SAVE_MS)

    expect(harness.saveState).toHaveBeenCalledTimes(1)
    expect(written().workspaces[0].name).toBe('renamed')
  })

  /**
   * A pane goes running → waiting → running every time an agent answers, and
   * none of it survives a restart. Without the snapshot check the busiest thing
   * in the app would be rewriting a file whose contents never changed.
   */
  it('does not rewrite the file when nothing that survives a restart moved', () => {
    store.useDeck.setState({
      hydrated: true,
      workspaces: [workspace('one', [pane('a', 'idle')])]
    })
    vi.advanceTimersByTime(SAVE_MS)
    expect(harness.saveState).toHaveBeenCalledTimes(1)

    store.useDeck.getState().setPaneStatus('a', 'running')
    store.useDeck.getState().setUi({ palette: true })
    vi.advanceTimersByTime(SAVE_MS)

    expect(harness.saveState).toHaveBeenCalledTimes(1)
  })

  it('writes again as soon as something that does survive moves', () => {
    store.useDeck.setState({
      hydrated: true,
      workspaces: [workspace('one', [pane('a', 'idle')])]
    })
    vi.advanceTimersByTime(SAVE_MS)

    store.useDeck.getState().updateWorkspace('one', { name: 'renamed' })
    vi.advanceTimersByTime(SAVE_MS)

    expect(harness.saveState).toHaveBeenCalledTimes(2)
    expect(written(1).workspaces[0].name).toBe('renamed')
  })

  it('stops writing once the caller lets the subscription go', () => {
    store.useDeck.setState({ hydrated: true, workspaces: [workspace('one')] })
    vi.advanceTimersByTime(SAVE_MS)
    expect(harness.saveState).toHaveBeenCalledTimes(1)

    stop()
    store.useDeck.getState().addWorkspace('two')
    vi.advanceTimersByTime(SAVE_MS * 5)

    expect(harness.saveState).toHaveBeenCalledTimes(1)
  })

  /**
   * Issue #26: the write used to be fire-and-forget end to end, so a full disk
   * lost the whole session with no signal anywhere the user could see it.
   * These drive the failure path: the reason lands in `saveError` (which is
   * what SaveErrorToast renders), stays one message for the whole streak, and
   * clears itself the moment a save gets through.
   */
  it('surfaces the reason a write did not land, and clears it when one does', async () => {
    harness.saveState.mockResolvedValueOnce({ ok: false, error: 'disk full' })
    store.useDeck.setState({ hydrated: true, workspaces: [workspace('one')] })
    await vi.advanceTimersByTimeAsync(SAVE_MS)

    expect(store.useDeck.getState().saveError).toBe('disk full')

    store.useDeck.getState().updateWorkspace('one', { name: 'renamed' })
    await vi.advanceTimersByTimeAsync(SAVE_MS)

    expect(store.useDeck.getState().saveError).toBeNull()
  })

  it('does not believe a failed write saved the deck: the next change tries again', async () => {
    harness.saveState.mockResolvedValueOnce({ ok: false, error: 'disk full' })
    store.useDeck.setState({
      hydrated: true,
      workspaces: [workspace('one', [pane('a', 'idle')])]
    })
    await vi.advanceTimersByTimeAsync(SAVE_MS)
    expect(harness.saveState).toHaveBeenCalledTimes(1)

    // Nothing that survives a restart moved — but the deck never reached disk,
    // so the snapshot check must not swallow this attempt.
    store.useDeck.getState().setPaneStatus('a', 'running')
    await vi.advanceTimersByTimeAsync(SAVE_MS)

    expect(harness.saveState).toHaveBeenCalledTimes(2)
    expect(store.useDeck.getState().saveError).toBeNull()
  })

  it('keeps a waved-off toast down while the same failure repeats, until a save lands', async () => {
    harness.saveState.mockResolvedValueOnce({ ok: false, error: 'disk full' })
    store.useDeck.setState({ hydrated: true, workspaces: [workspace('one')] })
    await vi.advanceTimersByTimeAsync(SAVE_MS)
    store.useDeck.getState().dismissSaveError()

    harness.saveState.mockResolvedValueOnce({ ok: false, error: 'disk full' })
    store.useDeck.getState().updateWorkspace('one', { name: 'renamed' })
    await vi.advanceTimersByTimeAsync(SAVE_MS)

    // Still the same outage: the message is unchanged and the dismissal holds.
    expect(store.useDeck.getState().saveError).toBe('disk full')
    expect(store.useDeck.getState().saveErrorDismissed).toBe(true)

    store.useDeck.getState().updateWorkspace('one', { name: 'again' })
    await vi.advanceTimersByTimeAsync(SAVE_MS)

    // A save landed, so the slate is clean — the next streak shows a toast.
    expect(store.useDeck.getState().saveError).toBeNull()
    expect(store.useDeck.getState().saveErrorDismissed).toBe(false)
  })

  it('retrySave writes right away and takes the error down when it works', async () => {
    harness.saveState.mockResolvedValueOnce({ ok: false, error: 'disk full' })
    store.useDeck.setState({ hydrated: true, workspaces: [workspace('one')] })
    await vi.advanceTimersByTimeAsync(SAVE_MS)
    expect(store.useDeck.getState().saveError).toBe('disk full')

    await store.useDeck.getState().retrySave()

    expect(harness.saveState).toHaveBeenCalledTimes(2)
    expect(store.useDeck.getState().saveError).toBeNull()
  })
})

describe('moveWorkspace', () => {
  beforeEach(() => {
    useDeck.setState({ workspaces: [workspace('one'), workspace('two'), workspace('three')] })
  })

  it('swaps a workspace with the neighbour it is moved towards', () => {
    deck().moveWorkspace('three', -1)

    expect(ids()).toEqual(['one', 'three', 'two'])
  })

  it('leaves the first where it is rather than wrapping it round to the end', () => {
    deck().moveWorkspace('one', -1)

    expect(ids()).toEqual(['one', 'two', 'three'])
  })

  it('leaves the last where it is rather than wrapping it round to the front', () => {
    deck().moveWorkspace('three', 1)

    expect(ids()).toEqual(['one', 'two', 'three'])
  })

  /** Without the index guard, `splice(-1, 1)` would move the *last* workspace. */
  it('does nothing for an id no workspace carries', () => {
    deck().moveWorkspace('closed', 1)

    expect(ids()).toEqual(['one', 'two', 'three'])
  })
})

describe('cycleWorkspace', () => {
  beforeEach(() => {
    useDeck.setState({
      workspaces: [workspace('one'), workspace('two'), workspace('three')],
      activeWorkspaceId: 'three',
      mounted: ['three']
    })
  })

  it('wraps past the last workspace round to the first', () => {
    deck().cycleWorkspace(1)

    expect(deck().activeWorkspaceId).toBe('one')
  })

  it('wraps backwards past the first round to the last', () => {
    useDeck.setState({ activeWorkspaceId: 'one' })
    deck().cycleWorkspace(-1)

    expect(deck().activeWorkspaceId).toBe('three')
  })

  /** Terminals keep running once mounted, so cycling has to mount as it goes. */
  it('mounts a workspace the user has not been to yet', () => {
    deck().cycleWorkspace(1)

    expect(deck().mounted).toEqual(['three', 'one'])
  })

  it('has nowhere to go when the deck holds a single workspace', () => {
    useDeck.setState({ workspaces: [workspace('one')], activeWorkspaceId: 'one', mounted: ['one'] })
    deck().cycleWorkspace(1)

    expect(deck().activeWorkspaceId).toBe('one')
    expect(deck().mounted).toEqual(['one'])
  })
})

describe('movePane', () => {
  beforeEach(() => {
    useDeck.setState({
      workspaces: [
        workspace('one', [pane('a', 'idle'), pane('b', 'idle'), pane('c', 'idle')]),
        workspace('two', [pane('d', 'idle')])
      ]
    })
  })

  it('swaps a pane with the neighbour it is moved towards', () => {
    deck().movePane('one', 'a', 1)

    expect(paneIds('one')).toEqual(['b', 'a', 'c'])
  })

  it('leaves the first pane where it is rather than wrapping it round to the end', () => {
    deck().movePane('one', 'a', -1)

    expect(paneIds('one')).toEqual(['a', 'b', 'c'])
  })

  it('leaves the last pane where it is rather than wrapping it round to the front', () => {
    deck().movePane('one', 'c', 1)

    expect(paneIds('one')).toEqual(['a', 'b', 'c'])
  })

  /** Without the index guard, `splice(-1, 1)` would move the *last* pane. */
  it('does nothing for a pane the named workspace does not hold', () => {
    deck().movePane('one', 'd', 1)

    expect(paneIds('one')).toEqual(['a', 'b', 'c'])
    expect(paneIds('two')).toEqual(['d'])
  })
})

describe('cyclePane', () => {
  beforeEach(() => {
    useDeck.setState({
      workspaces: [
        workspace('one', [pane('a', 'idle'), pane('b', 'idle'), pane('c', 'idle')], {
          activePaneId: 'c'
        })
      ],
      activeWorkspaceId: 'one'
    })
  })

  it('wraps past the last pane round to the first', () => {
    deck().cyclePane(1)

    expect(front()?.activePaneId).toBe('a')
  })

  it('wraps backwards past the first pane round to the last', () => {
    deck().updateWorkspace('one', { activePaneId: 'a' })
    deck().cyclePane(-1)

    expect(front()?.activePaneId).toBe('c')
  })

  /** Otherwise the badge stays lit on the pane the user is looking straight at. */
  it('clears the unread markers on the pane it lands on', () => {
    deck().updatePane('a', { activity: true, bell: true })
    deck().cyclePane(1)

    expect(front()?.panes[0]).toMatchObject({ id: 'a', activity: false, bell: false })
  })

  it('has nowhere to go in a workspace holding a single pane', () => {
    useDeck.setState({ workspaces: [workspace('one', [pane('a', 'idle')])] })
    deck().cyclePane(1)

    expect(front()?.activePaneId).toBe('a')
  })
})

describe('closePane', () => {
  beforeEach(() => {
    useDeck.setState({
      workspaces: [
        workspace('one', [pane('a', 'idle'), pane('b', 'idle'), pane('c', 'idle')], {
          activePaneId: 'b'
        }),
        workspace('two', [pane('d', 'idle')])
      ],
      activeWorkspaceId: 'one'
    })
  })

  /** A workspace left pointing at a pane that is gone renders nothing at all. */
  it('falls back to the last pane left when the focused one is the one closed', () => {
    deck().closePane('one', 'b')

    expect(paneIds('one')).toEqual(['a', 'c'])
    expect(front()?.activePaneId).toBe('c')
    expect(harness.pty.dispose).toHaveBeenCalledWith('b')
  })

  it('leaves the focus where it is when some other pane is closed', () => {
    deck().closePane('one', 'c')

    expect(front()?.activePaneId).toBe('b')
  })

  it('has no pane left to point at once the last one is closed', () => {
    useDeck.setState({ workspaces: [workspace('one', [pane('a', 'idle')])] })
    deck().closePane('one', 'a')

    expect(front()?.panes).toEqual([])
    expect(front()?.activePaneId).toBeNull()
  })

  /** A workspace zoomed on a pane that no longer exists shows an empty screen. */
  it('un-zooms when the pane filling the workspace is the one closed', () => {
    deck().updateWorkspace('one', { zoomedPaneId: 'b' })
    deck().closePane('one', 'b')

    expect(front()?.zoomedPaneId).toBeNull()
  })

  it('keeps the zoom when a pane behind it is closed', () => {
    deck().updateWorkspace('one', { zoomedPaneId: 'b' })
    deck().closePane('one', 'c')

    expect(front()?.zoomedPaneId).toBe('b')
  })
})

describe('requestClosePane', () => {
  const tree = '/repos/.harness-deck/deck/hd/agent-a'

  beforeEach(() => {
    useDeck.setState({
      workspaces: [workspace('one', [pane('a', 'exited', { worktree: tree })])],
      activeWorkspaceId: 'one',
      notice: null
    })
    harness.git.info.mockResolvedValue({
      root: tree,
      branch: 'hd/agent-a',
      dirty: 0,
      worktreeOf: '/repos/deck'
    })
    harness.confirm.mockResolvedValue(true)
  })

  /**
   * The pane is already gone by the time git answers, so a refusal the user
   * agreed to has nowhere visible left to land except a notice.
   */
  it('raises a notice when the worktree the user agreed to delete survives', async () => {
    harness.git.removeWorktree.mockResolvedValue({ ok: false, error: 'worktree is locked' })

    await deck().requestClosePane('one', 'a')

    expect(paneIds('one')).toEqual([])
    expect(deck().notice?.body).toContain(tree)
    expect(deck().notice?.body).toContain('worktree is locked')
  })

  it('says nothing when the removal goes through', async () => {
    harness.git.removeWorktree.mockResolvedValue({ ok: true })

    await deck().requestClosePane('one', 'a')

    expect(harness.git.removeWorktree).toHaveBeenCalledWith(tree)
    expect(deck().notice).toBeNull()
  })
})

/**
 * Pane events land many times a second, so the workspaces that do not hold the
 * pane must come through with their identity intact — a fresh object per
 * workspace here is an app-wide re-render per event (issue #57).
 */
describe('updatePane', () => {
  beforeEach(() => {
    useDeck.setState({
      workspaces: [
        workspace('one', [pane('a', 'idle'), pane('b', 'idle')]),
        workspace('two', [pane('c', 'idle')])
      ]
    })
  })

  it('patches the pane it was aimed at and no other', () => {
    deck().updatePane('c', { status: 'running' })

    expect(deck().workspaces[1].panes[0]).toMatchObject({ id: 'c', status: 'running' })
    expect(deck().workspaces[0].panes.map((p) => p.status)).toEqual(['idle', 'idle'])
  })

  it('leaves the workspaces that do not hold the pane referentially untouched', () => {
    const [, two] = deck().workspaces
    deck().updatePane('a', { status: 'running' })

    expect(deck().workspaces[1]).toBe(two)
  })

  it('does nothing at all for a pane no workspace holds', () => {
    const before = deck().workspaces
    deck().updatePane('closed', { status: 'running' })

    expect(deck().workspaces).toBe(before)
  })
})

describe('setPaneStatus', () => {
  beforeEach(() => {
    useDeck.setState({
      workspaces: [
        workspace('one', [pane('a', 'running')]),
        workspace('two', [pane('b', 'idle')])
      ]
    })
  })

  it('moves the pane to its new status, exit code and all', () => {
    deck().setPaneStatus('a', 'exited', 137)

    expect(deck().workspaces[0].panes[0]).toMatchObject({ status: 'exited', exitCode: 137 })
  })

  it('leaves the workspace next door referentially untouched', () => {
    const [, two] = deck().workspaces
    deck().setPaneStatus('a', 'waiting')

    expect(deck().workspaces[1]).toBe(two)
  })

  it('does nothing at all for a pane no workspace holds', () => {
    const before = deck().workspaces
    deck().setPaneStatus('closed', 'running')

    expect(deck().workspaces).toBe(before)
  })
})

describe('restartPane', () => {
  beforeEach(() => {
    useDeck.setState({
      workspaces: [
        workspace('one', [
          pane('a', 'exited', {
            exitCode: 1,
            epoch: 2,
            activity: true,
            bell: true,
            crashRestarts: 3
          })
        ]),
        workspace('two', [pane('b', 'idle')])
      ]
    })
  })

  it('disposes the old process and hands the pane a fresh epoch', () => {
    deck().restartPane('a')

    expect(harness.pty.dispose).toHaveBeenCalledWith('a')
    expect(deck().workspaces[0].panes[0]).toMatchObject({
      epoch: 3,
      status: 'idle',
      exitCode: null,
      autostart: true,
      activity: false,
      bell: false,
      crashRestarts: 0
    })
  })

  it('leaves the workspace next door referentially untouched', () => {
    const [, two] = deck().workspaces
    deck().restartPane('a')

    expect(deck().workspaces[1]).toBe(two)
  })

  it('does nothing to the deck for a pane no workspace holds', () => {
    const before = deck().workspaces
    deck().restartPane('closed')

    expect(deck().workspaces).toBe(before)
  })
})

describe('removeWorkspace', () => {
  beforeEach(() => {
    useDeck.setState({
      workspaces: [
        workspace('one', [pane('a', 'running')]),
        workspace('two'),
        workspace('three')
      ],
      activeWorkspaceId: 'one',
      mounted: ['one']
    })
  })

  it('points the deck at what is left, and mounts it, when the front one goes', () => {
    deck().removeWorkspace('one')

    expect(ids()).toEqual(['two', 'three'])
    expect(deck().activeWorkspaceId).toBe('two')
    expect(deck().mounted).toEqual(['two'])
    expect(harness.pty.dispose).toHaveBeenCalledWith('a')
  })

  it('leaves the deck where it is when a workspace behind it goes', () => {
    deck().removeWorkspace('three')

    expect(deck().activeWorkspaceId).toBe('one')
    expect(deck().mounted).toEqual(['one'])
  })

  it('is pointed at nothing once the last workspace goes', () => {
    useDeck.setState({ workspaces: [workspace('one')], activeWorkspaceId: 'one' })
    deck().removeWorkspace('one')

    expect(deck().activeWorkspaceId).toBeNull()
    expect(deck().mounted).toEqual([])
  })
})

/**
 * The point of the shortcut is to work through everything that is waiting, so
 * the ordering is the feature twice over: oldest first, because the agent that
 * has been at its prompt longest is the one keeping you waiting — and never the
 * pane already in front, because landing on the same one twice would leave the
 * others sitting at their prompts unnoticed.
 */
describe('focusNextWaiting', () => {
  /** Waiting since `t` seconds ago. */
  const since = (id: string, seconds: number, over: Partial<PaneView> = {}): PaneView =>
    pane(id, 'waiting', { waitingSince: Date.now() - seconds * 1000, ...over })

  it('goes to whichever pane has been waiting longest, wherever it sits in the deck', () => {
    useDeck.setState({
      workspaces: [
        workspace('one', [since('a', 10), since('b', 90), since('c', 40)], { activePaneId: null })
      ],
      activeWorkspaceId: 'one'
    })

    expect(deck().focusNextWaiting()).toBe('b')
  })

  it('starts after the pane in front, so pressing it again walks the queue', () => {
    useDeck.setState({
      workspaces: [
        workspace('one', [since('a', 90), since('b', 60), since('c', 30)], { activePaneId: 'a' })
      ],
      activeWorkspaceId: 'one'
    })

    expect(deck().focusNextWaiting()).toBe('b')
    expect(deck().focusNextWaiting()).toBe('c')
    expect(deck().focusNextWaiting()).toBe('a')
  })

  it('wraps round to a waiting pane sitting before the focused one', () => {
    useDeck.setState({
      workspaces: [
        workspace('one', [since('a', 90), pane('b', 'idle'), pane('c', 'idle')], {
          activePaneId: 'c'
        })
      ],
      activeWorkspaceId: 'one'
    })

    expect(deck().focusNextWaiting()).toBe('a')
  })

  it('passes over panes that are still producing output', () => {
    useDeck.setState({
      workspaces: [
        workspace('one', [pane('a', 'idle'), pane('b', 'running'), since('c', 5)], {
          activePaneId: 'a'
        })
      ],
      activeWorkspaceId: 'one'
    })

    expect(deck().focusNextWaiting()).toBe('c')
  })

  /** The three verbs, each one taking a pane out of the walk. */
  it('passes over the panes you muted, snoozed or already looked at', () => {
    useDeck.setState({
      workspaces: [
        workspace('one', [
          since('muted', 90, { attentionMuted: true }),
          since('snoozed', 80, { snooze: 'quiet' }),
          since('later', 70, { snooze: Date.now() + 60_000 }),
          since('seen', 60, { acknowledged: true }),
          since('asking', 10)
        ]),
        workspace('two')
      ],
      activeWorkspaceId: 'two'
    })

    expect(deck().focusNextWaiting()).toBe('asking')
  })

  /** An hour is a snooze, not a life sentence. */
  it('offers a pane again once its snooze has run out', () => {
    useDeck.setState({
      workspaces: [
        workspace('one', [pane('here', 'idle'), since('a', 90, { snooze: Date.now() - 1000 })], {
          activePaneId: 'here'
        })
      ],
      activeWorkspaceId: 'one'
    })

    expect(deck().focusNextWaiting()).toBe('a')
  })

  it('crosses into another workspace, bringing it to the front and mounting it', () => {
    useDeck.setState({
      workspaces: [workspace('one', [pane('a', 'idle')]), workspace('two', [since('b', 20)])],
      activeWorkspaceId: 'one',
      mounted: ['one']
    })

    expect(deck().focusNextWaiting()).toBe('b')
    expect(deck().activeWorkspaceId).toBe('two')
    expect(deck().mounted).toEqual(['one', 'two'])
    expect(front()?.activePaneId).toBe('b')
  })

  it('says so and leaves the deck alone when nothing is waiting', () => {
    useDeck.setState({
      workspaces: [workspace('one', [pane('a', 'running'), pane('b', 'exited')])],
      activeWorkspaceId: 'one'
    })

    expect(deck().focusNextWaiting()).toBeNull()
    expect(front()?.activePaneId).toBe('a')
  })

  /** The acceptance criterion: everything snoozed is a no-op, not an error. */
  it('says so when every waiting pane has been put off', () => {
    useDeck.setState({
      workspaces: [
        workspace(
          'one',
          [since('a', 90, { snooze: 'quiet' }), since('b', 60, { attentionMuted: true })],
          // Nothing in front, so the two panes are skipped for what was done to
          // them rather than for being where you already are.
          { activePaneId: null }
        )
      ],
      activeWorkspaceId: 'one'
    })

    expect(deck().focusNextWaiting()).toBeNull()
    expect(front()?.activePaneId).toBeNull()
  })
})

/** Every aggregate in the app runs on this one question. */
describe('isActionable', () => {
  it('is a pane that is waiting for you and has not been answered', () => {
    expect(isActionable(pane('a', 'waiting'))).toBe(true)
    expect(isActionable(pane('a', 'running'))).toBe(false)
    expect(isActionable(pane('a', 'exited'))).toBe(false)
  })

  /**
   * The build pane that goes quiet twenty times an hour. It keeps its own amber
   * dot — the local truth is never worth lying about — but it stops speaking to
   * the badge, the sidebar, the notifications and the queue.
   */
  it('never counts a muted pane, however loudly it is waiting', () => {
    expect(isActionable(pane('a', 'waiting', { attentionMuted: true }))).toBe(false)
  })

  it('does not count a pane you have already looked at', () => {
    expect(isActionable(pane('a', 'waiting', { acknowledged: true }))).toBe(false)
  })

  it('does not count a snoozed pane until the snooze has run out', () => {
    const now = Date.now()
    expect(isActionable(pane('a', 'waiting', { snooze: 'quiet' }), now)).toBe(false)
    expect(isActionable(pane('a', 'waiting', { snooze: now + 60_000 }), now)).toBe(false)
    expect(isActionable(pane('a', 'waiting', { snooze: now - 1 }), now)).toBe(true)
  })
})

/** The shared reductions every running and waiting number on screen goes through. */
describe('pane counts', () => {
  it('counts live panes per workspace and across the deck', () => {
    const one = workspace('one', [pane('a', 'running'), pane('b', 'waiting'), pane('c', 'exited')])
    const two = workspace('two', [pane('d', 'idle'), pane('e', 'running')])

    expect(liveCount(one.panes)).toBe(2)
    expect(liveCount(two.panes)).toBe(1)
    expect(totalLiveCount([one, two])).toBe(3)
  })

  it('counts only the waiting panes still speaking to the aggregates', () => {
    const one = workspace('one', [
      pane('a', 'waiting'),
      pane('b', 'waiting', { attentionMuted: true }),
      pane('c', 'running')
    ])
    const two = workspace('two', [
      pane('d', 'waiting', { acknowledged: true }),
      pane('e', 'waiting')
    ])

    expect(actionableCount(one.panes)).toBe(1)
    expect(actionableCount(two.panes)).toBe(1)
    expect(totalActionableCount([one, two])).toBe(2)
  })

  it('lets a lapsed snooze back into the count as of the moment asked about', () => {
    const now = Date.now()
    const one = workspace('one', [
      pane('a', 'waiting', { snooze: now + 60_000 }),
      pane('b', 'waiting', { snooze: now - 1 })
    ])

    expect(actionableCount(one.panes, now)).toBe(1)
    expect(totalActionableCount([one], now)).toBe(1)
  })

  it('is zero on an empty deck', () => {
    expect(totalLiveCount([])).toBe(0)
    expect(totalActionableCount([])).toBe(0)
  })
})

/**
 * The single subscription to the bridge's quiet event: the status transition,
 * the once-per-stop notification and the attention state all hang off it, so
 * these drive it the way the main process would.
 */
describe('startAttention', () => {
  let notify: ReturnType<typeof vi.fn>
  let focus: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    // jsdom has no Notification constructor and reports the window as
    // unfocused, so both halves of "should this notify?" have to be said out
    // loud here. The default is a window you are looking at, which is the case
    // where nothing is sent.
    notify = vi.fn()
    vi.stubGlobal('Notification', notify)
    focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  })

  afterEach(() => {
    focus.mockRestore()
    vi.unstubAllGlobals()
  })

  /** Subscribes, and hands back the callback the bridge was handed. */
  const fire = (event: PtyQuietEvent): void => {
    startAttention()
    const handler = harness.pty.onQuiet.mock.calls.at(-1)?.[0] as (e: PtyQuietEvent) => void
    handler(event)
  }

  const paneAt = (id: string): PaneView =>
    deck()
      .workspaces.flatMap((w) => w.panes)
      .find((p) => p.id === id)!

  const deckWith = (...panes: PaneView[]): void => {
    useDeck.setState({ workspaces: [workspace('one', panes)], activeWorkspaceId: 'one' })
  }

  it('turns a pane that stopped producing output into one waiting for you, and dates it', () => {
    deckWith(pane('a', 'running'))
    fire({ id: 'a', quiet: true })

    expect(paneAt('a').status).toBe('waiting')
    expect(paneAt('a').waitingSince).toBeGreaterThan(0)
  })

  it('puts a pane that spoke again back to running', () => {
    deckWith(pane('a', 'waiting', { waitingSince: 1 }))
    fire({ id: 'a', quiet: false })

    expect(paneAt('a').status).toBe('running')
  })

  /** A dead pane is not waiting for you, whatever the clock in main thinks. */
  it('ignores an event for a pane that has since exited', () => {
    deckWith(pane('a', 'exited', { exitCode: 1 }))
    fire({ id: 'a', quiet: true })

    expect(paneAt('a').status).toBe('exited')
  })

  /** Same guard, doing its other job: one notification per stop, not per event. */
  it('does not re-date a pane that was already waiting', () => {
    deckWith(pane('a', 'waiting', { waitingSince: 1_000 }))
    fire({ id: 'a', quiet: true })

    expect(paneAt('a').waitingSince).toBe(1_000)
  })

  it('clears an acknowledgement when the pane stops again — a fresh stop is fresh news', () => {
    deckWith(pane('a', 'waiting', { waitingSince: 1_000, acknowledged: true }))
    // It said something, then stopped again.
    fire({ id: 'a', quiet: false })
    fire({ id: 'a', quiet: true })

    expect(paneAt('a').acknowledged).toBe(false)
    expect(isActionable(paneAt('a'))).toBe(true)
  })

  it('lifts an until-next-quiet snooze at the next quiet, and leaves an hour-long one alone', () => {
    const hour = Date.now() + 3_600_000
    deckWith(
      pane('a', 'running', { snooze: 'quiet' }),
      pane('b', 'running', { snooze: hour })
    )
    fire({ id: 'a', quiet: true })
    fire({ id: 'b', quiet: true })

    expect(paneAt('a').snooze).toBeUndefined()
    expect(paneAt('b').snooze).toBe(hour)
  })

  describe('the notification', () => {
    // A window you are looking at has already said it, on screen.
    beforeEach(() => {
      focus.mockReturnValue(false)
    })

    it('tells you once, for a pane that is only waiting', () => {
      deckWith(pane('a', 'running', { name: 'Reviewer' }))
      fire({ id: 'a', quiet: true })
      fire({ id: 'a', quiet: true })

      expect(notify).toHaveBeenCalledTimes(1)
      expect(notify.mock.calls[0][1]).toEqual({ body: 'Reviewer is waiting for you' })
    })

    it('says nothing about a muted pane', () => {
      deckWith(pane('a', 'running', { attentionMuted: true }))
      fire({ id: 'a', quiet: true })

      expect(notify).not.toHaveBeenCalled()
    })

    /** "Not now" has to mean not now, or the snooze is decoration. */
    it('says nothing about a snoozed pane', () => {
      deckWith(pane('a', 'running', { snooze: Date.now() + 3_600_000 }))
      fire({ id: 'a', quiet: true })

      expect(notify).not.toHaveBeenCalled()
    })

    it('says nothing when the window is in front of you', () => {
      focus.mockReturnValue(true)
      deckWith(pane('a', 'running'))
      fire({ id: 'a', quiet: true })

      expect(notify).not.toHaveBeenCalled()
    })

    it('says nothing when you turned notifications off', () => {
      useDeck.setState({
        settings: { ...DEFAULT_SETTINGS, attention: { ...DEFAULT_SETTINGS.attention, notify: false } }
      })
      deckWith(pane('a', 'running'))
      fire({ id: 'a', quiet: true })

      expect(notify).not.toHaveBeenCalled()
    })
  })

  /** What the toolbar's git refresh — and, later, HD-20's checkpoints — ride on. */
  it('hands the moment on to whoever else is listening', () => {
    const heard: Array<{ id: string; quiet: boolean }> = []
    const off = onQuietPane(({ id, quiet }) => heard.push({ id, quiet }))
    deckWith(pane('a', 'running'))
    fire({ id: 'a', quiet: true })
    fire({ id: 'a', quiet: false })
    off()
    fire({ id: 'a', quiet: true })

    expect(heard).toEqual([
      { id: 'a', quiet: true },
      { id: 'a', quiet: false }
    ])
  })
})

/**
 * The bell is the one signal a snooze does not outrank: Claude Code rings it at
 * a permission prompt, which is precisely the thing you did not mean to put off
 * for an hour.
 */
describe('ringBell', () => {
  const paneAt = (id: string): PaneView =>
    deck()
      .workspaces.flatMap((w) => w.panes)
      .find((p) => p.id === id)!

  it('wakes a snoozed pane, and says the bell is why', () => {
    useDeck.setState({
      workspaces: [
        workspace('one', [pane('a', 'waiting', { snooze: Date.now() + 3_600_000 })])
      ],
      activeWorkspaceId: 'one'
    })
    deck().ringBell('a')

    expect(paneAt('a').snooze).toBeUndefined()
    expect(paneAt('a').woke).toBe(true)
    expect(paneAt('a').bell).toBe(true)
    expect(isActionable(paneAt('a'))).toBe(true)
  })

  it('does not flag a pane nobody had put off', () => {
    useDeck.setState({
      workspaces: [workspace('one', [pane('a', 'waiting')])],
      activeWorkspaceId: 'one'
    })
    deck().ringBell('a')

    expect(paneAt('a').bell).toBe(true)
    expect(paneAt('a').woke).toBeUndefined()
  })

  /** Snoozing again is how you disagree with it. */
  it('is undone by the next snooze', () => {
    useDeck.setState({
      workspaces: [workspace('one', [pane('a', 'waiting', { woke: true })])],
      activeWorkspaceId: 'one'
    })
    deck().cycleSnooze('a')

    expect(paneAt('a').snooze).toBe('quiet')
    expect(paneAt('a').woke).toBe(false)
  })
})

/** Off → until next quiet → for an hour → off, and round again. */
describe('cycleSnooze', () => {
  const paneAt = (): PaneView => deck().workspaces[0].panes[0]

  beforeEach(() => {
    useDeck.setState({
      workspaces: [workspace('one', [pane('a', 'waiting')])],
      activeWorkspaceId: 'one'
    })
  })

  it('walks the three states and comes back to none', () => {
    deck().cycleSnooze('a')
    expect(paneAt().snooze).toBe('quiet')

    deck().cycleSnooze('a')
    expect(paneAt().snooze).toBeGreaterThan(Date.now())

    deck().cycleSnooze('a')
    expect(paneAt().snooze).toBeUndefined()
  })
})

describe('toggleZoom', () => {
  beforeEach(() => {
    useDeck.setState({
      workspaces: [workspace('one', [pane('a', 'idle'), pane('b', 'idle')])],
      activeWorkspaceId: 'one'
    })
  })

  it('gives the workspace back when asked to zoom the pane already filling it', () => {
    deck().toggleZoom('one', 'a')
    expect(front()?.zoomedPaneId).toBe('a')

    deck().toggleZoom('one', 'a')
    expect(front()?.zoomedPaneId).toBeNull()
  })

  it('moves the zoom straight to another pane rather than un-zooming first', () => {
    deck().toggleZoom('one', 'a')
    deck().toggleZoom('one', 'b')

    expect(front()?.zoomedPaneId).toBe('b')
  })

  /** Keystrokes follow the focused pane, so zooming one and typing at another
   * would send the input somewhere off screen. */
  it('focuses the pane it zooms', () => {
    deck().toggleZoom('one', 'b')

    expect(front()?.activePaneId).toBe('b')
  })
})

describe('rememberBroadcast', () => {
  const history = (): string[] => deck().settings.broadcastHistory

  it('moves a prompt that is sent again back to the top instead of listing it twice', () => {
    deck().rememberBroadcast('run the tests')
    deck().rememberBroadcast('commit it')
    deck().rememberBroadcast('run the tests')

    expect(history()).toEqual(['run the tests', 'commit it'])
  })

  it('forgets the oldest prompt once the history is full', () => {
    for (let n = 0; n < BROADCAST_HISTORY + 10; n++) deck().rememberBroadcast(`prompt ${n}`)

    expect(history()).toHaveLength(BROADCAST_HISTORY)
    expect(history()[0]).toBe(`prompt ${BROADCAST_HISTORY + 9}`)
    expect(history()).not.toContain('prompt 0')
  })

  /** Otherwise ↑ hands back a prompt that differs only in the space at the end. */
  it('files the trimmed prompt, not whatever the box had in it', () => {
    deck().rememberBroadcast('  ship it  ')
    deck().rememberBroadcast('ship it')

    expect(history()).toEqual(['ship it'])
  })

  it('does not file an empty prompt', () => {
    deck().rememberBroadcast('   \n ')

    expect(history()).toEqual([])
  })
})

describe('setColumns', () => {
  it('clamps the column count to a grid that can actually be drawn', () => {
    useDeck.setState({ workspaces: [workspace('one')] })

    deck().setColumns('one', 9)
    expect(deck().workspaces[0].columns).toBe(4)

    deck().setColumns('one', 0)
    expect(deck().workspaces[0].columns).toBe(1)
  })
})
