import { describe, expect, it, vi } from 'vitest'
import { attentionItem, createGitHubReader, type GhRunner } from './github'

const pr = (extra = {}) => ({ number: 12, title: 'A change', url: 'https://github.com/owner/repo/pull/12', headRefOid: 'abc', reviews: [], comments: [], statusCheckRollup: [], ...extra })
const failed = { __typename: 'CheckRun', name: 'tests', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/owner/repo/actions/runs/1', completedAt: '2026-09-07T12:00:00Z' }

describe('GitHub attention signals', () => {
  it('combines requests, feedback and failing CI into one PR', () => {
    const item = attentionItem(pr({ reviewDecision: 'CHANGES_REQUESTED', statusCheckRollup: [failed] }), 'owner/repo', 'me', true, true)!
    expect(item.signals.map(s => s.kind)).toEqual(['review', 'feedback', 'checks'])
    expect(item.signals[2].url).toBe(failed.detailsUrl)
  })
  it('ignores successful and pending checks, self comments and feedback on someone else’s PR', () => {
    expect(attentionItem(pr({ comments: [{ author: { login: 'ME' }, createdAt: 'today' }], statusCheckRollup: [{ ...failed, status: 'IN_PROGRESS' }] }), 'owner/repo', 'me', false, true)).toBeNull()
    expect(attentionItem(pr({ reviewDecision: 'CHANGES_REQUESTED', statusCheckRollup: [failed] }), 'owner/repo', 'me', false, false)).toBeNull()
  })
  it('recognizes legacy status failures and uses a safe browser link', () => {
    const item = attentionItem(pr({ statusCheckRollup: [{ __typename: 'StatusContext', context: 'build', state: 'ERROR', targetUrl: 'javascript:bad' }] }), 'owner/repo', 'me', false, true)!
    expect(item.signals[0].url).toBe(pr().url)
  })
  it('keeps acknowledgement stable for unrelated edits but wakes for new inline feedback and reruns', () => {
    const original = pr({ statusCheckRollup: [failed] })
    const item = attentionItem(original, 'owner/repo', 'me', false, true)!
    expect(attentionItem({ ...original, title: 'Renamed', updatedAt: 'later' }, 'owner/repo', 'me', false, true)!.revision).toBe(item.revision)
    expect(attentionItem(original, 'owner/repo', 'me', false, true, [{ id: 5, updated_at: '2026-09-07', user: { login: 'reviewer' } }])!.revision).not.toBe(item.revision)
    expect(attentionItem(pr({ statusCheckRollup: [{ ...failed, completedAt: 'later' }] }), 'owner/repo', 'me', false, true)!.revision).not.toBe(item.revision)
  })
})

function runner() {
  return vi.fn<GhRunner>(async args => {
    if (args[0] === 'repo') return { nameWithOwner: 'owner/repo', url: 'https://github.example.com/owner/repo' }
    if (args.includes('user')) return { login: 'me' }
    if (args[0] === 'pr') return [pr()]
    return [[]]
  })
}

describe('GitHub CLI reader', () => {
  it('uses explicit repository and host arguments, paginates inline comments, and coalesces workspaces', async () => {
    const run = runner()
    const read = createGitHubReader(run)
    const [a, b] = await Promise.all([read('/repo'), read('/worktree')])
    expect(a).toEqual(b)
    expect(a.items).toHaveLength(1)
    expect(run.mock.calls.filter(([args]) => args[0] === 'pr')).toHaveLength(2)
    expect(run).toHaveBeenCalledWith(expect.arrayContaining(['--repo', 'github.example.com/owner/repo', '--author', 'me']), '/repo')
    expect(run).toHaveBeenCalledWith(expect.arrayContaining(['--hostname', 'github.example.com', '--paginate', '--slurp']), '/repo')
    expect(run.mock.calls.every(([args]) => !(args.includes('--slurp') && args.includes('--jq')))).toBe(true)
    await read('/repo')
    expect(run.mock.calls.filter(([args]) => args[0] === 'repo')).toHaveLength(2)
  })
  it('reads feedback from later pages of inline comments', async () => {
    const base = runner()
    const read = createGitHubReader(async (args, cwd) => args.includes('--paginate')
      ? [[], [{ id: 99, updated_at: '2026-09-07', user: { login: 'reviewer' }, html_url: pr().url + '#discussion_r99' }]]
      : base(args, cwd))
    const result = await read('/repo')
    expect(result.items[0].signals.find(signal => signal.kind === 'feedback')?.url).toContain('#discussion_r99')
  })
  it('expires cached failures and permits retry', async () => {
    let now = 0
    const run = runner().mockRejectedValueOnce(new Error('Please run gh auth login'))
    const read = createGitHubReader(run, () => now)
    expect((await read('/repo')).error).toContain('gh auth login')
    now = 60_001
    expect((await read('/repo')).error).toBeUndefined()
  })
  it('does not return partial success when a feedback page fails', async () => {
    const base = runner()
    const read = createGitHubReader(async (args, cwd) => {
      if (args.includes('--paginate')) throw new Error('rate limited')
      return base(args, cwd)
    })
    expect(await read('/repo')).toMatchObject({ items: [], error: 'rate limited' })
  })
  it('rejects invalid paths and malformed CLI output without running arbitrary commands', async () => {
    const run = runner()
    const read = createGitHubReader(run)
    expect((await read('relative')).error).toBeTruthy()
    expect((await read(null)).error).toBeTruthy()
    expect(run).not.toHaveBeenCalled()
    const malformed = createGitHubReader(async () => ({ nameWithOwner: '--evil' }))
    expect((await malformed('/repo')).error).toBeTruthy()
  })
})
