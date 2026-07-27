import { describe, expect, it } from 'vitest'
import { worktreeBranch, worktreePath } from './worktree'

describe('worktreeBranch', () => {
  it('turns a harness name into something git will accept', () => {
    expect(worktreeBranch('Claude Code')).toBe('hd/claude-code')
    expect(worktreeBranch('Codex CLI')).toBe('hd/codex-cli')
  })

  it('flattens the punctuation a launcher name can carry', () => {
    expect(worktreeBranch('Claude Code (WSL)')).toBe('hd/claude-code-wsl')
    expect(worktreeBranch('claude --resume')).toBe('hd/claude-resume')
    expect(worktreeBranch('  spaced  out  ')).toBe('hd/spaced-out')
  })

  it('still names a pane whose title survives none of that', () => {
    expect(worktreeBranch('***')).toBe('hd/pane')
    expect(worktreeBranch('')).toBe('hd/pane')
  })
})

describe('worktreePath', () => {
  it('puts the worktree beside the repo, never inside it', () => {
    const path = worktreePath('/home/dev/projects/deck', 'hd/claude-code')

    expect(path).toBe('/home/dev/projects/.harness-deck/deck/hd/claude-code')
    expect(path.startsWith('/home/dev/projects/deck/')).toBe(false)
  })

  it('names the folder after the repo, so two repos never share one', () => {
    expect(worktreePath('/src/alpha', 'hd/a')).toBe('/src/.harness-deck/alpha/hd/a')
    expect(worktreePath('/src/beta', 'hd/a')).toBe('/src/.harness-deck/beta/hd/a')
  })

  it('ignores a trailing separator on the root', () => {
    expect(worktreePath('/src/alpha/', 'hd/a')).toBe('/src/.harness-deck/alpha/hd/a')
  })

  it('keeps a Windows root on backslashes', () => {
    expect(worktreePath('C:\\Users\\dev\\deck', 'hd/claude-code')).toBe(
      'C:\\Users\\dev\\.harness-deck\\deck\\hd\\claude-code'
    )
  })

  /** git reports forward slashes on Windows too, and Windows takes them back. */
  it('leaves a root git reported with forward slashes alone', () => {
    expect(worktreePath('C:/Users/dev/deck', 'hd/claude-code')).toBe(
      'C:/Users/dev/.harness-deck/deck/hd/claude-code'
    )
  })

  it('survives a repo checked out at the root of a drive', () => {
    expect(worktreePath('/deck', 'hd/a')).toBe('/.harness-deck/deck/hd/a')
  })
})
