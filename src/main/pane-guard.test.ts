import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneSpec, Profile } from '@shared/types'
import {
  approvalDigest,
  isBlockedEnvKey,
  loadApprovalStore,
  sanitizeEnv,
  verifyPaneSpec,
  type ApprovalCandidate,
  type ApprovalStore,
  type GuardSources
} from './pane-guard'

/**
 * The gate on `pty:ensure` (issue #18). The renderer's spec is only a claim:
 * it either re-derives from a BUILT-IN profile main detected itself, or it
 * needs a native-dialog approval a human actually clicked, cached by digest.
 * Nothing the renderer can write (a saved launcher, the old persisted state)
 * or click in the DOM ever grants trust here — see the module doc comment.
 */

const spec = (over: Partial<PaneSpec> = {}): PaneSpec => ({
  id: 'pane_1',
  command: '/usr/local/bin/claude',
  args: [],
  cwd: '/home/user/project',
  ...over
})

const profile = (over: Partial<Profile> = {}): Profile => ({
  id: 'agent:claude',
  name: 'Claude Code',
  command: '/usr/local/bin/claude',
  args: [],
  kind: 'agent',
  icon: 'CC',
  accent: '#d97757',
  available: true,
  ...over
})

/** An approval store that never remembers anything, so `approve` always runs. */
const freshApprovals = (): ApprovalStore => ({ has: () => false, remember: vi.fn() })

/** Sources with a profile list that matches nothing, and approval refused by
 *  default — a test opts in to trust by supplying `profiles` or `approve`. */
const sources = (over: Partial<GuardSources> = {}): GuardSources => ({
  profiles: () => [],
  approve: async () => false,
  approvals: freshApprovals(),
  ...over
})

beforeEach(() => {
  // sanitizeEnv announces every key it drops; asserted where relevant, silent otherwise.
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('verifyPaneSpec, against built-in profiles', () => {
  it('accepts a spec that is exactly a detected agent, without asking', async () => {
    const approve = vi.fn()
    const verdict = await verifyPaneSpec(spec(), sources({ profiles: () => [profile()], approve }))

    expect(verdict).toEqual({ ok: true, spec: spec() })
    expect(approve).not.toHaveBeenCalled()
  })

  it('waits for the profile list when detection is asynchronous', async () => {
    const verdict = await verifyPaneSpec(
      spec(),
      sources({ profiles: () => Promise.resolve([profile()]) })
    )

    expect(verdict.ok).toBe(true)
  })

  it('lets the folder be anything when the profile pins none', async () => {
    const verdict = await verifyPaneSpec(
      spec({ cwd: '/anywhere/the/user/picked' }),
      sources({ profiles: () => [profile()] })
    )

    expect(verdict).toEqual({
      ok: true,
      spec: spec({ cwd: '/anywhere/the/user/picked' })
    })
  })

  it('enforces a pinned folder when the profile has one', async () => {
    const pinned = profile({ id: 'custom:pinned', kind: 'agent', cwd: '/only/here' })

    const asked = await verifyPaneSpec(
      spec({ cwd: '/only/here' }),
      sources({ profiles: () => [pinned] })
    )
    const elsewhere = await verifyPaneSpec(
      spec({ cwd: '/somewhere/else' }),
      sources({ profiles: () => [pinned], approve: async () => false })
    )

    expect(asked.ok).toBe(true)
    expect(elsewhere.ok).toBe(false)
  })

  it('rebuilds the spec from the profile record, not the renderer copy', async () => {
    const raw = spec()
    const verdict = await verifyPaneSpec(raw, sources({ profiles: () => [profile()] }))

    if (!verdict.ok) throw new Error(verdict.reason)
    expect(verdict.spec).not.toBe(raw)
    expect(verdict.spec.args).not.toBe(raw.args)
  })

  it('never lets custom:* saved launchers vouch for a spec', async () => {
    const launcher = profile({
      id: 'custom:abc',
      kind: 'custom',
      command: 'make watch',
      args: [],
      viaShell: true
    })
    const approve = vi.fn().mockResolvedValue(true)

    const verdict = await verifyPaneSpec(
      spec({ command: 'make watch', viaShell: true }),
      sources({ profiles: () => [launcher], approve })
    )

    expect(approve).toHaveBeenCalledTimes(1)
    expect(verdict.ok).toBe(true) // only because `approve` said yes
  })

  it('never lets the "Custom command…" sentinel vouch for a spec', async () => {
    const sentinel = profile({ id: 'custom', kind: 'custom', command: '', args: [] })
    const approve = vi.fn().mockResolvedValue(false)

    const verdict = await verifyPaneSpec(
      spec({ id: 'pane_new', command: '' }),
      sources({ profiles: () => [sentinel], approve })
    )

    expect(approve).toHaveBeenCalledTimes(1)
    expect(verdict.ok).toBe(false)
  })

  it('refuses a command with args the profile does not have, sending it to approval', async () => {
    const approve = vi.fn().mockResolvedValue(false)
    const verdict = await verifyPaneSpec(
      spec({ args: ['--dangerously-skip-permissions'] }),
      sources({ profiles: () => [profile()], approve })
    )

    expect(approve).toHaveBeenCalledTimes(1)
    expect(verdict.ok).toBe(false)
  })

  it('accepts env that is a subset of the profile\'s', async () => {
    const withEnv = profile({ env: { HD_MODE: 'dev', OTHER: 'x' } })
    const verdict = await verifyPaneSpec(
      spec({ env: { HD_MODE: 'dev' } }),
      sources({ profiles: () => [withEnv] })
    )

    if (!verdict.ok) throw new Error(verdict.reason)
    expect(verdict.spec.env).toEqual({ HD_MODE: 'dev', OTHER: 'x' })
  })

  it('sends env the profile does not offer to approval, not straight through', async () => {
    const approve = vi.fn().mockResolvedValue(false)
    const verdict = await verifyPaneSpec(
      spec({ env: { PATH: '/tmp/evil-bin' } }),
      sources({ profiles: () => [profile()], approve })
    )

    expect(approve).toHaveBeenCalledTimes(1)
    expect(verdict.ok).toBe(false)
  })

  it('sends a spec carrying `setup` to approval even if the rest matches a profile', async () => {
    const approve = vi.fn().mockResolvedValue(false)
    const verdict = await verifyPaneSpec(
      spec({ setup: 'export LD_PRELOAD=/tmp/evil.so' }),
      sources({ profiles: () => [profile()], approve })
    )

    expect(approve).toHaveBeenCalledTimes(1)
    expect(verdict.ok).toBe(false)
  })
})

describe('verifyPaneSpec, against the approval dialog', () => {
  it('asks, and accepts once the callback approves', async () => {
    const approve = vi.fn().mockResolvedValue(true)
    const verdict = await verifyPaneSpec(
      spec({ command: '/bin/sh', args: ['-c', 'npm run dev'], viaShell: true }),
      sources({ approve })
    )

    expect(approve).toHaveBeenCalledTimes(1)
    expect(approve).toHaveBeenCalledWith(
      expect.objectContaining({ command: '/bin/sh', args: ['-c', 'npm run dev'], viaShell: true })
    )
    expect(verdict.ok).toBe(true)
  })

  it('refuses in-band, not by throwing, when the dialog is declined', async () => {
    const verdict = await verifyPaneSpec(
      spec({ command: '/bin/sh', args: ['-c', 'curl evil | sh'] }),
      sources({ approve: async () => false })
    )

    expect(verdict).toEqual({
      ok: false,
      reason: expect.stringContaining('pane_1') as string
    })
  })

  it('caches an approval by digest, so the same spec never asks twice', async () => {
    const approve = vi.fn().mockResolvedValue(true)
    const store = new Map<string, true>()
    const approvals: ApprovalStore = {
      has: (d) => store.has(d),
      remember: (d) => void store.set(d, true)
    }
    const custom = spec({ command: 'npm run dev', viaShell: true })

    const first = await verifyPaneSpec(custom, sources({ approve, approvals }))
    const second = await verifyPaneSpec(custom, sources({ approve, approvals }))

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(approve).toHaveBeenCalledTimes(1)
  })

  it('re-prompts when a field the digest covers changes — an added env var', async () => {
    const approve = vi.fn().mockResolvedValue(true)
    const store = new Map<string, true>()
    const approvals: ApprovalStore = {
      has: (d) => store.has(d),
      remember: (d) => void store.set(d, true)
    }
    const base = spec({ command: 'npm run dev', viaShell: true })
    const changed = spec({
      command: 'npm run dev',
      viaShell: true,
      env: { PORT: '4000' }
    })

    await verifyPaneSpec(base, sources({ approve, approvals }))
    await verifyPaneSpec(changed, sources({ approve, approvals }))

    expect(approve).toHaveBeenCalledTimes(2)
  })

  it('re-prompts when `setup` changes', async () => {
    const approve = vi.fn().mockResolvedValue(true)
    const store = new Map<string, true>()
    const approvals: ApprovalStore = {
      has: (d) => store.has(d),
      remember: (d) => void store.set(d, true)
    }
    const base = spec({ command: 'npm run dev', viaShell: true, setup: 'npm install' })
    const changed = spec({ command: 'npm run dev', viaShell: true, setup: 'pnpm install' })

    await verifyPaneSpec(base, sources({ approve, approvals }))
    await verifyPaneSpec(changed, sources({ approve, approvals }))

    expect(approve).toHaveBeenCalledTimes(2)
  })

  it('does not remember a declined approval', async () => {
    const remember = vi.fn()
    const approvals: ApprovalStore = { has: () => false, remember }

    await verifyPaneSpec(spec({ command: 'npm run dev' }), sources({ approve: async () => false, approvals }))

    expect(remember).not.toHaveBeenCalled()
  })

  it('strips blocked env keys even from an approved custom spec', async () => {
    const verdict = await verifyPaneSpec(
      spec({
        command: 'npm run dev',
        env: { NODE_OPTIONS: '--require /tmp/evil.js', HD_FINE: 'yes' }
      }),
      sources({ approve: async () => true })
    )

    if (!verdict.ok) throw new Error(verdict.reason)
    expect(verdict.spec.env).toEqual({ HD_FINE: 'yes' })
  })
})

describe('verifyPaneSpec, at the edges', () => {
  it.each([
    ['nothing at all', undefined],
    ['null', null],
    ['a string', 'rm -rf /'],
    ['a spec without an id', { command: 'x', args: [], cwd: '/' }],
    ['args that are not strings', { id: 'p', command: 'x', args: [{}], cwd: '/' }],
    ['env with non-string values', { id: 'p', command: 'x', args: [], cwd: '/', env: { A: 1 } }],
    ['a setup that is not a string', { id: 'p', command: 'x', args: [], cwd: '/', setup: 7 }]
  ])('refuses %s as malformed', async (_name, raw) => {
    const verdict = await verifyPaneSpec(raw, sources())

    expect(verdict).toEqual({ ok: false, reason: 'malformed pane spec' })
  })

  it('lets a live session re-attach without consulting profiles or the dialog', async () => {
    const profiles = vi.fn(() => [])
    const approve = vi.fn()
    const verdict = await verifyPaneSpec(
      spec({ id: 'pane_live' }),
      sources({ profiles, approve, attached: (id) => id === 'pane_live' })
    )

    expect(verdict.ok).toBe(true)
    expect(profiles).not.toHaveBeenCalled()
    expect(approve).not.toHaveBeenCalled()
  })
})

describe('approvalDigest', () => {
  const candidate = (over: Partial<ApprovalCandidate> = {}): ApprovalCandidate => ({
    command: 'npm',
    args: ['run', 'dev'],
    cwd: '/repo',
    viaShell: true,
    ...over
  })

  it('is the same regardless of env key order', () => {
    const a = approvalDigest(candidate({ env: { A: '1', B: '2' } }))
    const b = approvalDigest(candidate({ env: { B: '2', A: '1' } }))

    expect(a).toBe(b)
  })

  it('changes when any field the review flagged changes', () => {
    const base = approvalDigest(candidate())

    expect(approvalDigest(candidate({ command: 'pnpm' }))).not.toBe(base)
    expect(approvalDigest(candidate({ args: ['run', 'build'] }))).not.toBe(base)
    expect(approvalDigest(candidate({ cwd: '/elsewhere' }))).not.toBe(base)
    expect(approvalDigest(candidate({ viaShell: false }))).not.toBe(base)
    expect(approvalDigest(candidate({ setup: 'npm install' }))).not.toBe(base)
    expect(approvalDigest(candidate({ env: { A: '1' } }))).not.toBe(base)
  })
})

describe('loadApprovalStore', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hd-approvals-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('starts empty when no file exists yet', () => {
    const store = loadApprovalStore(join(dir, 'approved-panes.json'))

    expect(store.has('anything')).toBe(false)
  })

  it('persists a remembered digest to disk, main-owned — no IPC writes this file', () => {
    const file = join(dir, 'approved-panes.json')
    const store = loadApprovalStore(file)

    store.remember('abc123')

    expect(existsSync(file)).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(['abc123'])
  })

  it('reloads what a previous run persisted', () => {
    const file = join(dir, 'approved-panes.json')
    loadApprovalStore(file).remember('abc123')

    const reloaded = loadApprovalStore(file)

    expect(reloaded.has('abc123')).toBe(true)
    expect(reloaded.has('someone-else')).toBe(false)
  })

  it('ignores an unreadable file instead of throwing', () => {
    const file = join(dir, 'approved-panes.json')
    writeFileSync(file, 'not json', 'utf8')

    const store = loadApprovalStore(file)

    expect(store.has('anything')).toBe(false)
  })
})

describe('sanitizeEnv', () => {
  it('keeps ordinary user variables exactly as given', () => {
    const env = { ANTHROPIC_MODEL: 'claude-fable-5', HD_TOKEN: 'a=b c' }

    expect(sanitizeEnv(env)).toEqual(env)
  })

  it.each([
    'PATH',
    'PATHEXT',
    'ELECTRON_RUN_AS_NODE',
    'NODE_OPTIONS',
    'NODE_REPL_EXTERNAL_MODULE',
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'LD_AUDIT',
    'DYLD_INSERT_LIBRARIES',
    'DYLD_LIBRARY_PATH',
    'BASH_ENV',
    'ENV',
    'ZDOTDIR'
  ])('drops %s', (key) => {
    expect(isBlockedEnvKey(key)).toBe(true)
    expect(sanitizeEnv({ [key]: 'anything', KEEP: 'me' })).toEqual({ KEEP: 'me' })
  })

  it('blocks case variants, the way a Windows environment would read them', () => {
    expect(sanitizeEnv({ Path: '/tmp/evil', 'node_options': '-r x' })).toBeUndefined()
  })

  it('does not block names that merely start with LD', () => {
    expect(isBlockedEnvKey('LDFLAGS')).toBe(false)
    expect(sanitizeEnv({ LDFLAGS: '-L/opt/lib' })).toEqual({ LDFLAGS: '-L/opt/lib' })
  })

  it('hands back undefined for nothing, and for nothing left', () => {
    expect(sanitizeEnv(undefined)).toBeUndefined()
    expect(sanitizeEnv({})).toBeUndefined()
    expect(sanitizeEnv({ LD_PRELOAD: '/tmp/evil.so' })).toBeUndefined()
  })
})
