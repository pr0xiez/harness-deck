import { beforeEach, describe, expect, it } from 'vitest'
import type { GitHubItem } from '@shared/github'
import { harness } from './test/harness'
import { githubCount, needsGitHubAttention, useGitHub } from './github'

export const item: GitHubItem = { id: 'repo#1|me', repository: 'owner/repo', number: 1, title: 'Change', url: 'https://github.com/owner/repo/pull/1', revision: 'v1', signals: [{ kind: 'review', label: 'Review requested', url: 'https://github.com/owner/repo/pull/1', revision: 'v1' }] }
const snapshot = { items: [item], checkedAt: 123, repository: 'owner/repo', account: 'me' }

beforeEach(() => {
  useGitHub.getState().configure(['/repo'])
  useGitHub.setState({ enabled: true, marks: {}, snapshots: {}, loading: false, now: Date.now() })
  harness.github.query.mockResolvedValue(snapshot)
})

describe('GitHub attention state', () => {
  it('persists acknowledgements, deduplicates badges and wakes on actionable changes', async () => {
    await useGitHub.getState().refresh()
    useGitHub.setState({ snapshots: { '/repo': snapshot, '/worktree': snapshot } })
    expect(githubCount(useGitHub.getState())).toBe(1)
    expect(githubCount(useGitHub.getState(), '')).toBe(0)
    useGitHub.getState().acknowledge(item)
    expect(githubCount(useGitHub.getState())).toBe(0)
    expect(localStorage.getItem('harness-deck-github-attention-v1')).toContain('v1')
    expect(needsGitHubAttention({ ...item, revision: 'v2' }, useGitHub.getState().marks, Date.now())).toBe(true)
  })
  it('snoozes for one hour, and new signals can wake the PR early', () => {
    useGitHub.getState().snooze(item)
    const marks = useGitHub.getState().marks
    expect(needsGitHubAttention(item, marks, Date.now())).toBe(false)
    expect(needsGitHubAttention(item, marks, Date.now() + 3_600_001)).toBe(true)
    expect(needsGitHubAttention({ ...item, revision: 'v2' }, marks, Date.now())).toBe(true)
  })
  it('preserves stale results on failure and clears resolved rows after success', async () => {
    await useGitHub.getState().refresh()
    harness.github.query.mockResolvedValueOnce({ items: [], checkedAt: 456, error: 'offline' })
    await useGitHub.getState().refresh()
    expect(useGitHub.getState().snapshots['/repo']).toMatchObject({ items: [item], checkedAt: 123, error: 'offline' })
    useGitHub.getState().acknowledge(item)
    harness.github.query.mockResolvedValueOnce({ items: [], checkedAt: 789 })
    await useGitHub.getState().refresh()
    expect(githubCount(useGitHub.getState())).toBe(0)
    expect(useGitHub.getState().marks[item.id]).toBeUndefined()
  })
  it('does not wake an acknowledged PR when a failed check resolves', async () => {
    const withFailure: GitHubItem = { ...item, revision: 'review-and-failure', signals: [...item.signals, { kind: 'checks', label: 'CI failed', url: item.url, revision: 'failed' }] }
    harness.github.query.mockResolvedValueOnce({ ...snapshot, items: [withFailure] })
    await useGitHub.getState().refresh()
    useGitHub.getState().acknowledge(withFailure)
    await useGitHub.getState().refresh()
    expect(githubCount(useGitHub.getState())).toBe(0)
  })
  it('discards a late response after watching is disabled', async () => {
    let finish!: (value: typeof snapshot) => void
    harness.github.query.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = useGitHub.getState().refresh()
    useGitHub.getState().setEnabled(false)
    finish(snapshot)
    await pending
    expect(useGitHub.getState().snapshots).toEqual({})
    expect(githubCount(useGitHub.getState())).toBe(0)
  })
  it('drops removed workspaces and ignores their in-flight responses', async () => {
    let finish!: (value: typeof snapshot) => void
    harness.github.query.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = useGitHub.getState().refresh()
    useGitHub.getState().configure(['/new'])
    finish(snapshot)
    await pending
    expect(useGitHub.getState().snapshots).toEqual({})
  })
})
