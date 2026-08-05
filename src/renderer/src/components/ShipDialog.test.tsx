import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { DiffResult, Profile, RepoInfo } from '@shared/types'
import { useDeck, type DeckWorkspace, type PaneView } from '../store'
import { harness } from '../test/harness'
import { ShipDialog, shipChain, shipCommands, type ShipPlan } from './ShipDialog'

/**
 * The preview is the contract — the string composed here is the string a pane
 * spawns — so most of what is worth testing is the composition, not the markup
 * around it. Chiefly the quoting: a commit message is prose, and prose is full
 * of apostrophes.
 *
 * The rendered half covers the three refusals, which are the ones a user only
 * ever meets when something is already wrong: nothing to commit, no forge CLI,
 * and a worktree path whose repo has moved on underneath it.
 */

const plan = (over: Partial<ShipPlan> = {}): ShipPlan => ({
  message: 'a message',
  branch: 'feat/hd-18-ship',
  commit: true,
  push: true,
  pr: true,
  forge: 'gh',
  flavour: 'posix',
  ...over
})

describe('shipCommands', () => {
  it('composes the whole chain in the order the steps depend on each other', () => {
    expect(shipCommands(plan())).toEqual([
      'git add -A',
      "git commit -m 'a message'",
      'git push -u origin feat/hd-18-ship',
      'gh pr create --fill'
    ])
  })

  it('keeps a message with spaces and apostrophes as one argument to git', () => {
    // The shape POSIX sh actually accepts: close the quote, an escaped
    // apostrophe, reopen. `"don't"` written any other way ends the string.
    const [, commit] = shipCommands(plan({ message: "don't ship what you can't read" }))
    expect(commit).toBe(`git commit -m 'don'\\''t ship what you can'\\''t read'`)

    // And the whole of it is still one word: split on unquoted whitespace, the
    // command is three tokens — git, commit, -m — plus the quoted message.
    expect(commit.slice(0, commit.indexOf("'"))).toBe('git commit -m ')
  })

  it('trims the message, so a stray trailing space is not committed', () => {
    expect(shipCommands(plan({ message: '  tidy up  ' }))[1]).toBe("git commit -m 'tidy up'")
  })

  it('drops the PR step when no forge CLI was found, and keeps the rest', () => {
    expect(shipCommands(plan({ forge: null }))).toEqual([
      'git add -A',
      "git commit -m 'a message'",
      'git push -u origin feat/hd-18-ship'
    ])
  })

  it('speaks GitLab when glab is what is installed', () => {
    expect(shipCommands(plan({ forge: 'glab' })).at(-1)).toBe('glab mr create --fill')
  })

  it('honours each toggle on its own', () => {
    expect(shipCommands(plan({ commit: false }))).toEqual([
      'git push -u origin feat/hd-18-ship',
      'gh pr create --fill'
    ])
    expect(shipCommands(plan({ push: false, pr: false }))).toEqual([
      'git add -A',
      "git commit -m 'a message'"
    ])
    expect(shipCommands(plan({ commit: false, push: false, pr: false }))).toEqual([])
  })

  it('quotes a branch name only when git has let something shell-ish into it', () => {
    expect(shipCommands(plan({ branch: 'fix/HD-18_v2.1' }))[2]).toBe(
      'git push -u origin fix/HD-18_v2.1'
    )
    // Legal refname, unsafe word: refname rules forbid space, ~, ^, : and ?,
    // but not $, ; or ( — and an unquoted one would be run, not pushed.
    expect(shipCommands(plan({ branch: 'feat/$(id)' }))[2]).toBe(
      `git push -u origin 'feat/$(id)'`
    )
  })

  it('pushes HEAD when git could not name a branch', () => {
    expect(shipCommands(plan({ branch: '' }))[2]).toBe('git push -u origin HEAD')
  })
})

describe('shipChain', () => {
  it('joins with && so a rejected push cannot be followed by a pull request', () => {
    expect(shipChain(plan({ commit: false }))).toBe(
      'git push -u origin feat/hd-18-ship &&\ngh pr create --fill'
    )
  })

  it('is empty when nothing is selected, which is what disables the buttons', () => {
    expect(shipChain(plan({ commit: false, push: false, pr: false }))).toBe('')
  })

  // The pane spawns `shell:default`, and on Windows that is never a POSIX
  // shell — the chain has to arrive in the spawning shell's own grammar or the
  // preview contract is a lie there (PS 5.1 has no `&&` at all).
  it("speaks PowerShell when that is the pane's shell: doubled quotes, no &&", () => {
    expect(shipChain(plan({ flavour: 'powershell', message: "don't stop" }))).toBe(
      "git add -A; if ($LASTEXITCODE -eq 0) { git commit -m 'don''t stop'; " +
        'if ($LASTEXITCODE -eq 0) { git push -u origin feat/hd-18-ship; ' +
        'if ($LASTEXITCODE -eq 0) { gh pr create --fill } } }'
    )
  })

  it("speaks cmd when that is the pane's shell: double quotes, one line", () => {
    expect(shipChain(plan({ flavour: 'cmd', message: 'say "when"' }))).toBe(
      'git add -A && git commit -m "say ""when""" && ' +
        'git push -u origin feat/hd-18-ship && gh pr create --fill'
    )
  })

  it('quotes a shell-ish branch in the same grammar as the message', () => {
    expect(shipCommands(plan({ flavour: 'powershell', branch: 'feat/$(id)' }))[2]).toBe(
      "git push -u origin 'feat/$(id)'"
    )
  })
})

const SHELL: Profile = {
  id: 'shell:default',
  name: 'Shell',
  command: '/bin/zsh',
  args: [],
  kind: 'shell',
  icon: '»',
  accent: '#94a3b8',
  available: true
}

const WORKTREE = '/repo/.worktrees/hd-18'

const shipPane: PaneView = {
  id: 'pane_1',
  profileId: 'agent:claude',
  command: 'claude',
  args: [],
  cwd: WORKTREE,
  worktree: WORKTREE,
  status: 'waiting',
  exitCode: null,
  epoch: 0
}

const diff = (over: Partial<DiffResult> = {}): DiffResult => ({
  dir: WORKTREE,
  root: '/repo',
  branch: 'feat/hd-18-ship',
  base: 'abc1234',
  baseRef: 'main',
  stat: ' src/a.ts | 2 +-\n',
  patch: '',
  patchLines: 0,
  truncated: false,
  untracked: 0,
  ...over
})

const linked: RepoInfo = { root: '/repo', branch: 'feat/hd-18-ship', dirty: 3, worktreeOf: '/repo' }

/** The pane the dialog made, if it made one. */
const shipped = (): PaneView | undefined =>
  useDeck
    .getState()
    .workspaces[0].panes.find((p) => p.id !== shipPane.id)

/**
 * By class, not by text: half the toggle hints quote the command they turn on,
 * so `getByText(/git add -A/)` finds the hint as readily as the preview.
 */
const preview = (): string => document.querySelector('.ship-preview')?.textContent ?? ''

describe('ShipDialog', () => {
  beforeEach(() => {
    const workspace: DeckWorkspace = {
      id: 'ws_1',
      name: 'Deck',
      cwd: '/repo',
      accent: '#94a3b8',
      panes: [shipPane],
      activePaneId: shipPane.id,
      layout: 'grid',
      columns: 2,
      zoomedPaneId: null
    }
    useDeck.setState({ profiles: [SHELL], workspaces: [workspace], repos: {}, info: null })
    harness.git.forge.mockResolvedValue('gh')
    harness.git.info.mockResolvedValue(linked)
  })

  it('runs a pane whose command is character-for-character the preview', async () => {
    const user = userEvent.setup()
    render(<ShipDialog workspaceId="ws_1" pane={shipPane} diff={diff()} onClose={vi.fn()} />)
    await screen.findByText(/gh pr create/)

    await user.type(screen.getByRole('textbox'), "don't hold back")
    const shown = preview()

    await user.click(screen.getByRole('button', { name: 'Run in a pane' }))

    await waitFor(() => expect(shipped()).toBeDefined())
    const pane = shipped()!
    expect(pane.command).toBe(shown)
    expect(pane.command).toBe(
      `git add -A &&\ngit commit -m 'don'\\''t hold back' &&\n` +
        'git push -u origin feat/hd-18-ship &&\ngh pr create --fill'
    )
    // A shell has to see the chain as a chain, and the pane runs in the
    // worktree rather than wherever the workspace happens to point.
    expect(pane.viaShell).toBe(true)
    expect(pane.cwd).toBe(WORKTREE)
    expect(pane.name).toBe('ship · feat/hd-18-ship')
    // Not the ship pane's to delete: closing it must never offer to take the
    // folder the agent pane is still working in.
    expect(pane.worktree).toBeUndefined()
    // And not the state file's to keep: a persisted ship pane would autostart
    // on relaunch and run the chain again against whatever is in the tree.
    expect(pane.transient).toBe(true)
  })

  it('runs nothing when the dialog closes while git is still answering', async () => {
    const user = userEvent.setup()
    let answer: (info: RepoInfo) => void = () => {}
    harness.git.info.mockImplementation(
      () =>
        new Promise<RepoInfo>((resolve) => {
          answer = resolve
        })
    )
    const view = render(
      <ShipDialog workspaceId="ws_1" pane={shipPane} diff={diff()} onClose={vi.fn()} />
    )
    await screen.findByText(/gh pr create/)
    await user.type(screen.getByRole('textbox'), 'ready')
    await user.click(screen.getByRole('button', { name: 'Run in a pane' }))

    // Escape landed while the worktree re-check was in flight: the dialog is
    // gone by the time git answers. The footer's promise holds — nothing runs.
    view.unmount()
    answer(linked)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(shipped()).toBeUndefined()
  })

  it('previews the chain in the grammar of the shell the pane will spawn', async () => {
    useDeck.setState({
      info: {
        platform: 'win32',
        versions: { electron: '', chrome: '', node: '', app: '' },
        homeDir: 'C:\\Users\\t',
        defaultShell: 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        defaultCwd: 'C:\\Users\\t'
      }
    })
    render(<ShipDialog workspaceId="ws_1" pane={shipPane} diff={diff()} onClose={vi.fn()} />)
    await screen.findByText(/gh pr create/)

    expect(preview()).toContain('$LASTEXITCODE')
    expect(preview()).not.toContain('&&')
  })

  it('runs nothing when the dialog is closed', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<ShipDialog workspaceId="ws_1" pane={shipPane} diff={diff()} onClose={onClose} />)
    await screen.findByText(/gh pr create/)

    await user.type(screen.getByRole('textbox'), 'ready')
    await user.keyboard('{Escape}')

    expect(onClose).toHaveBeenCalledOnce()
    expect(shipped()).toBeUndefined()
    expect(harness.git.info).not.toHaveBeenCalled()
  })

  it('refuses a path git no longer calls a linked worktree', async () => {
    const user = userEvent.setup()
    // The repo moved on since `worktree` was persisted — the same trap
    // `requestClosePane` re-checks for before offering to delete a folder.
    harness.git.info.mockResolvedValue({ root: '/repo', branch: 'main', dirty: 0 })

    render(<ShipDialog workspaceId="ws_1" pane={shipPane} diff={diff()} onClose={vi.fn()} />)
    await screen.findByText(/gh pr create/)
    await user.type(screen.getByRole('textbox'), 'ready')
    await user.click(screen.getByRole('button', { name: 'Run in a pane' }))

    expect(await screen.findByText(/not a linked worktree any more/)).toBeTruthy()
    expect(shipped()).toBeUndefined()
  })

  it('drops the pull request step, and says why, when no forge CLI is installed', async () => {
    harness.git.forge.mockResolvedValue(null)
    render(<ShipDialog workspaceId="ws_1" pane={shipPane} diff={diff()} onClose={vi.fn()} />)

    expect(await screen.findByText(/Not on PATH — install with: brew install gh/)).toBeTruthy()
    expect(preview()).not.toContain('pr create')
    expect(screen.getByRole('switch', { name: /pull request/ })).toHaveProperty('disabled', true)
  })

  it('will not offer a commit that would come back empty', async () => {
    render(
      <ShipDialog workspaceId="ws_1" pane={shipPane} diff={diff({ stat: '' })} onClose={vi.fn()} />
    )
    await screen.findByText(/gh pr create/)

    expect(screen.getByText(/Nothing has changed since this branched off main/)).toBeTruthy()
    expect(screen.getByRole('switch', { name: /Commit/ })).toHaveProperty('disabled', true)
    expect(preview()).not.toContain('git commit')
    expect(preview()).toContain('git push')
  })

  it('asks git itself when it was opened from a pane rather than a column', async () => {
    harness.git.diffRange.mockResolvedValue(diff())
    render(<ShipDialog workspaceId="ws_1" pane={shipPane} onClose={vi.fn()} />)

    await waitFor(() =>
      expect(harness.git.diffRange).toHaveBeenCalledWith({ dir: WORKTREE, limit: 1 })
    )
    await waitFor(() => expect(preview()).toContain('git push -u origin feat/hd-18-ship'))
  })
})
