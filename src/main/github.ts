import { isAbsolute } from 'node:path'
import type { GitHubItem, GitHubSignal, GitHubSnapshot } from '@shared/github'
import { runProcess } from './process'
import { shellEnv } from './shell-env'

const TTL = 60_000
const LIMIT = 100
const FIELDS = 'number,title,url,headRefOid,reviewDecision,reviews,comments,statusCheckRollup'
type Json = Record<string, any>
export type GhRunner = (args: string[], cwd: string) => Promise<unknown>

const runGh: GhRunner = async (args, cwd) => {
  const env = { ...shellEnv(), GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', NO_COLOR: '1' }
  // A shell's override must not redirect every workspace to the same repository.
  delete (env as NodeJS.ProcessEnv).GH_REPO
  const result = await runProcess('gh', args, { cwd, env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })
  if (!result.ok) {
    if ((result.error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      throw new Error('GitHub CLI was not found. Install gh on the system running Deck, then run gh auth login.')
    }
    throw new Error(result.stderr.trim().slice(0, 600) || 'GitHub CLI failed or timed out. Check gh auth status and your connection.')
  }
  return JSON.parse(result.stdout)
}

function array(value: unknown): Json[] {
  if (!Array.isArray(value)) throw new Error('GitHub CLI returned an unexpected response.')
  return value
}

function https(value: unknown, fallback: string): string {
  try { if (typeof value === 'string' && new URL(value).protocol === 'https:') return value } catch { /* use PR */ }
  return fallback
}

/** One row per PR; only attention-bearing facts contribute to its revision. */
export function attentionItem(pr: Json, repository: string, account: string, requested: boolean, authored: boolean, inline: Json[] = []): GitHubItem | null {
  if (!Number.isInteger(pr.number) || typeof pr.title !== 'string' || typeof pr.url !== 'string') {
    throw new Error('GitHub CLI returned an invalid pull request.')
  }
  const url = https(pr.url, '')
  if (!url) throw new Error('GitHub CLI returned an invalid pull request URL.')
  const signals: GitHubSignal[] = []
  if (requested) {
    signals.push({ kind: 'review', label: 'Review requested', url, revision: String(pr.headRefOid ?? '') })
  }
  if (authored) {
    const feedback = [
      ...array(pr.reviews ?? []).filter(r => ['COMMENTED', 'CHANGES_REQUESTED'].includes(r.state)).map(r => ({ id: r.id, at: r.submittedAt, login: r.author?.login, url: r.url })),
      ...array(pr.comments ?? []).map(c => ({ id: c.id, at: c.updatedAt ?? c.createdAt, login: c.author?.login, url: c.url })),
      ...inline.map(c => ({ id: c.id, at: c.updated_at, login: c.user?.login, url: c.html_url }))
    ].filter(c => c.login && c.login.toLowerCase() !== account.toLowerCase() && c.at)
      .sort((a, b) => String(a.at).localeCompare(String(b.at)) || String(a.id).localeCompare(String(b.id)))
    const latest = feedback.at(-1)
    if (latest || pr.reviewDecision === 'CHANGES_REQUESTED') {
      signals.push({ kind: 'feedback', label: pr.reviewDecision === 'CHANGES_REQUESTED' ? 'Changes requested' : 'Feedback on your PR',
        url: https(latest?.url, url), revision: JSON.stringify([pr.reviewDecision, latest?.id, latest?.at]) })
    }
    const failures = array(pr.statusCheckRollup ?? []).filter(c =>
      c.__typename === 'StatusContext' ? ['FAILURE', 'ERROR'].includes(c.state) :
        c.status === 'COMPLETED' && ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(c.conclusion)
    ).sort((a, b) => String(a.name ?? a.context).localeCompare(String(b.name ?? b.context)))
    if (failures.length) {
      signals.push({ kind: 'checks', label: `${failures.length} failed check${failures.length === 1 ? '' : 's'}`,
        url: https(failures[0].detailsUrl ?? failures[0].targetUrl, url),
        revision: JSON.stringify([pr.headRefOid, failures.map(c => [c.name ?? c.context, c.conclusion ?? c.state, c.detailsUrl ?? c.targetUrl, c.completedAt ?? c.createdAt])]) })
    }
  }
  if (!signals.length) return null
  return { id: `${url}|${account.toLowerCase()}`, repository, number: pr.number, title: pr.title, url, signals,
    revision: JSON.stringify(signals.map(s => [s.kind, s.revision])) }
}

/** CLI calls are bounded, coalesced and cached across workspaces sharing a repo. */
export function createGitHubReader(run: GhRunner = runGh, now: () => number = Date.now) {
  const folders = new Map<string, { until: number; promise: Promise<GitHubSnapshot> }>()
  const repos = new Map<string, { until: number; promise: Promise<GitHubSnapshot> }>()
  async function readRepo(cwd: string, repository: string, host: string): Promise<GitHubSnapshot> {
    const user = await run(['api', '--hostname', host, 'user'], cwd) as Json
    if (typeof user.login !== 'string' || !/^[a-z0-9_-]+$/i.test(user.login)) throw new Error('Could not identify your GitHub account. Run gh auth login.')
    const account = user.login
    const base = ['pr', 'list', '--repo', `${host}/${repository}`, '--state', 'open', '--limit', String(LIMIT), '--json', FIELDS]
    const [mine, requested] = await Promise.all([
      run([...base, '--author', account], cwd).then(array),
      run([...base, '--search', `review-requested:${account}`], cwd).then(array)
    ])
    const all = new Map<number, Json>()
    for (const pr of [...requested, ...mine]) all.set(pr.number, pr)
    const mineIds = new Set(mine.map(p => p.number))
    const requestedIds = new Set(requested.map(p => p.number))
    const items: GitHubItem[] = []
    // Limit concurrency and retain the whole previous snapshot if any page fails.
    const pending = [...all.values()]
    await Promise.all(Array.from({ length: Math.min(3, pending.length) }, async () => {
      while (pending.length) {
        const pr = pending.shift()!
        if (!Number.isInteger(pr.number) || pr.number < 1) throw new Error('Invalid pull request number.')
        const authored = mineIds.has(pr.number)
        const inline = authored ? array(await run(['api', '--hostname', host,
          `repos/${repository}/pulls/${pr.number}/comments?per_page=100`, '--paginate', '--slurp'], cwd)).flatMap(array) : []
        const item = attentionItem(pr, repository, account, requestedIds.has(pr.number), authored, inline)
        if (item) items.push(item)
      }
    })).catch(error => { pending.length = 0; throw error })
    return { repository, account, items: items.sort((a, b) => a.number - b.number), checkedAt: now(),
      ...(mine.length >= LIMIT || requested.length >= LIMIT ? { warning: 'Showing up to 100 authored PRs and 100 review requests. More may exist on GitHub.' } : {}) }
  }
  return function query(cwd: unknown): Promise<GitHubSnapshot> {
    if (typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.includes('\0')) {
      return Promise.resolve({ items: [], checkedAt: now(), error: 'Choose an absolute workspace folder to check GitHub.' })
    }
    for (const cache of [folders, repos]) for (const [key, value] of cache) if (value.until < now()) cache.delete(key)
    const cached = folders.get(cwd)
    if (cached) return cached.promise
    const entry = { until: Infinity, promise: Promise.resolve(null as unknown as GitHubSnapshot) }
    entry.promise = (async () => {
      const repo = await run(['repo', 'view', '--json', 'nameWithOwner,url'], cwd) as Json
      if (typeof repo.nameWithOwner !== 'string' || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repo.nameWithOwner)) throw new Error('The workspace does not resolve to a GitHub repository.')
      const parsed = new URL(repo.url)
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('Invalid GitHub repository URL.')
      const key = `${parsed.host}/${repo.nameWithOwner}`.toLowerCase()
      let shared = repos.get(key)
      if (!shared) {
        shared = { until: Infinity, promise: Promise.resolve(null as unknown as GitHubSnapshot) }
        const target = shared
        target.promise = readRepo(cwd, repo.nameWithOwner, parsed.host)
          .catch(error => ({ repository: repo.nameWithOwner, items: [], checkedAt: now(), error: error instanceof Error ? error.message : 'GitHub refresh failed.' }))
          .finally(() => { target.until = now() + TTL })
        repos.set(key, target)
      }
      return shared.promise
    })().catch(error => ({ items: [], checkedAt: now(), error: error instanceof Error ? error.message : 'GitHub refresh failed.' }))
      .finally(() => { entry.until = now() + TTL })
    folders.set(cwd, entry)
    return entry.promise
  }
}

export const queryGitHub = createGitHubReader()
