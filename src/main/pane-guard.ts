import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { PaneSpec, Profile } from '@shared/types'

/**
 * The gate `pty:ensure` runs behind. The renderer used to hand over a full
 * PaneSpec — command, args, cwd, viaShell, env — and the main process spawned
 * it verbatim, which made one IPC message equal to arbitrary shell execution
 * (issue #18). An earlier version of this file re-checked the spec against
 * `workspaces.json`, but that file is itself written by an unvalidated
 * `state:save` IPC call — the renderer authors the very record the guard was
 * reading, so that "trust source" was the attacker's own input reflected back.
 * Nothing the renderer can write (`state:save`, `profiles:saveCustom`) or
 * click (any DOM element) is a trust anchor here any more.
 *
 * What main actually owns instead:
 *
 *   - `detectProfiles()`'s BUILT-IN entries — the agents, shells and WSL
 *     targets this machine actually has, discovered by main itself. A spec
 *     that is exactly one of those command lines runs without asking.
 *     Saved launchers (`custom:*`) and the "Custom command…" sentinel are
 *     excluded: both live in `custom-profiles.json`, written verbatim by the
 *     renderer-facing `profiles:saveCustom` IPC call, so they carry no more
 *     authority than the spec itself;
 *   - a native `dialog.showMessageBox` click. A compromised renderer can send
 *     any IPC message it likes, but it cannot forge a click on an OS-drawn
 *     button. Anything that is not a bare built-in profile — a custom pane, a
 *     saved launcher, a workspace action, a `setup` line, extra `env` — needs
 *     one of these once, and only once: the answer is cached by a digest of
 *     the exact spec and remembered in a file main alone writes.
 *
 * `env` is additionally sanitised on every route: pane-level variables are a
 * user feature with user-chosen names, so there is no allowlist to derive —
 * but keys that would hijack the app, the loader or the shell's startup are
 * dropped unconditionally, wherever they came from.
 *
 * No `electron` import here: this runs under plain-Node unit tests. The one
 * genuinely Electron-only step — showing the dialog — is injected as
 * `GuardSources.approve`, so a test can drive it without a window.
 */

/**
 * Env keys never forwarded to a pane's process, whatever their source.
 * Comparison is case-insensitive because Windows environments are.
 *
 *   - PATH / PATHEXT decide what a bare command name resolves to;
 *   - ELECTRON_RUN_AS_NODE / NODE_OPTIONS / NODE_REPL_EXTERNAL_MODULE turn any
 *     Electron- or Node-based child into an arbitrary-code loader;
 *   - LD_* / DYLD_* inject libraries into every process spawned under them;
 *   - BASH_ENV / ENV / ZDOTDIR make the shell itself run a file of the
 *     caller's choosing before the command does.
 */
const BLOCKED_ENV = new Set([
  'PATH',
  'PATHEXT',
  'ELECTRON_RUN_AS_NODE',
  'NODE_OPTIONS',
  'NODE_REPL_EXTERNAL_MODULE',
  'BASH_ENV',
  'ENV',
  'ZDOTDIR'
])

export function isBlockedEnvKey(key: string): boolean {
  const upper = key.toUpperCase()
  return BLOCKED_ENV.has(upper) || upper.startsWith('LD_') || upper.startsWith('DYLD_')
}

/** Drops blocked keys and anything that is not a plain string pair. */
export function sanitizeEnv(
  env: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!env) return undefined
  const clean: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof key !== 'string' || typeof value !== 'string' || !key.trim()) continue
    if (isBlockedEnvKey(key)) {
      console.warn(`[pane-guard] dropped env variable ${key} — not forwarded to panes`)
      continue
    }
    clean[key] = value
  }
  return Object.keys(clean).length ? clean : undefined
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

const isEnvRecord = (value: unknown): value is Record<string, string> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.entries(value).every(([k, v]) => typeof k === 'string' && typeof v === 'string')

/** Structural check only — says nothing about whether the spec is *known*. */
function isSpecShaped(value: unknown): value is PaneSpec {
  const spec = value as PaneSpec | null
  return Boolean(
    spec &&
      typeof spec === 'object' &&
      typeof spec.id === 'string' &&
      spec.id.length > 0 &&
      typeof spec.command === 'string' &&
      isStringArray(spec.args) &&
      typeof spec.cwd === 'string' &&
      (spec.viaShell === undefined || typeof spec.viaShell === 'boolean') &&
      (spec.env === undefined || isEnvRecord(spec.env)) &&
      (spec.setup === undefined || typeof spec.setup === 'string')
  )
}

const sameArgs = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((item, i) => item === b[i])

/**
 * Every key `spec` names must equal what `known` has for it. `spec` may name
 * fewer keys than `known` offers — asking for less than a profile provides is
 * fine — but never a key `known` lacks, or a different value for one it has.
 * Absent entirely is a subset of anything, including nothing.
 */
function envIsSubset(
  spec: Record<string, string> | undefined,
  known: Record<string, string> | undefined
): boolean {
  if (!spec) return true
  const has = known ?? {}
  return Object.entries(spec).every(([key, value]) => has[key] === value)
}

/**
 * Whether `spec` is a bare re-derivation of a detected profile: the same
 * command line, the same shell-or-not, its folder free unless the profile
 * pins one, its env (if any) a subset of the profile's, and no `setup` — a
 * profile never carries one, so a spec that adds one is asking to run
 * something the profile never offered.
 */
function matches(
  spec: PaneSpec,
  profile: Pick<Profile, 'command' | 'args' | 'viaShell' | 'env' | 'cwd'>,
  checkCwd: boolean
): boolean {
  return (
    spec.command === profile.command &&
    sameArgs(spec.args, profile.args) &&
    Boolean(spec.viaShell) === Boolean(profile.viaShell) &&
    envIsSubset(spec.env, profile.env) &&
    (!checkCwd || spec.cwd === profile.cwd) &&
    !spec.setup?.trim()
  )
}

/**
 * A spec that matches some BUILT-IN profile exactly, or null. Saved launchers
 * and the "Custom command…" sentinel (`kind: 'custom'`) are never consulted
 * here — see the module doc comment for why.
 */
async function findBuiltinMatch(
  spec: PaneSpec,
  sources: Pick<GuardSources, 'profiles'>
): Promise<PaneSpec | null> {
  if (!spec.command) return null
  const profiles = await sources.profiles()
  const profile = profiles.find(
    (p) => p.kind !== 'custom' && p.command && matches(spec, p, Boolean(p.cwd))
  )
  if (!profile) return null
  return {
    id: spec.id,
    command: profile.command,
    args: [...profile.args],
    cwd: profile.cwd ?? spec.cwd,
    ...(profile.viaShell ? { viaShell: true } : {}),
    env: sanitizeEnv(profile.env)
  }
}

/** What the approval dialog is shown, and what the digest below is over. */
export interface ApprovalCandidate {
  command: string
  args: string[]
  cwd: string
  viaShell: boolean
  setup?: string
  env?: Record<string, string>
}

/**
 * Stable across process restarts and independent of object key order, so the
 * same spec always lands on the same digest and a request that only reorders
 * its own env never re-prompts.
 */
export function approvalDigest(candidate: ApprovalCandidate): string {
  const env = Object.entries(candidate.env ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const normalized = JSON.stringify([
    candidate.command,
    candidate.args,
    candidate.cwd,
    candidate.viaShell,
    candidate.setup ?? '',
    env
  ])
  return createHash('sha256').update(normalized).digest('hex')
}

/** Where a digest that has already cleared the dialog once is remembered. */
export interface ApprovalStore {
  has: (digest: string) => boolean
  remember: (digest: string) => void
}

/**
 * Backed by a JSON file of previously approved digests. Written by main only
 * — no IPC channel writes this file, so a compromised renderer cannot grant
 * itself a standing approval the way it could when the guard trusted
 * `workspaces.json`. Read once at construction; every new `remember` rewrites
 * the file through a temp-then-rename, the same crash-safe pattern
 * `store.ts`'s `writeJsonAtomic` uses (not imported from there, so this file
 * stays free of the `electron` import that pulls in).
 */
export function loadApprovalStore(filePath: string): ApprovalStore {
  const digests = new Set<string>()
  try {
    if (existsSync(filePath)) {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown
      if (Array.isArray(parsed)) {
        for (const entry of parsed) if (typeof entry === 'string') digests.add(entry)
      }
    }
  } catch (err) {
    console.error(`[pane-guard] ignoring unreadable approvals at ${filePath}:`, err)
  }
  return {
    has: (digest) => digests.has(digest),
    remember: (digest) => {
      if (digests.has(digest)) return
      digests.add(digest)
      try {
        mkdirSync(dirname(filePath), { recursive: true })
        const tmp = `${filePath}.tmp`
        writeFileSync(tmp, JSON.stringify([...digests], null, 2), 'utf8')
        renameSync(tmp, filePath)
      } catch (err) {
        console.error(`[pane-guard] failed to persist approvals at ${filePath}:`, err)
      }
    }
  }
}

/** Where the truth about panes and profiles comes from — injected, for tests. */
export interface GuardSources {
  /** Detected harnesses + shells + WSL entries + saved launchers + the
   *  sentinel. Only entries with `kind !== 'custom'` can vouch for a spec
   *  without asking (see `findBuiltinMatch`). */
  profiles: () => Profile[] | Promise<Profile[]>
  /**
   * True when a live session already exists for this id. `ensure` on a live
   * session only re-attaches — it reads nothing from the spec but the id — so
   * a window reload may re-attach to a pane no other source has caught up
   * with yet.
   */
  attached?: (id: string) => boolean
  /**
   * Shows the native "Start this pane?" dialog and resolves true on approval.
   * Only called once per distinct digest — see `approvals`. A compromised
   * renderer can call `pty:ensure` any number of times, but cannot click an
   * OS-drawn button on main's behalf.
   */
  approve: (candidate: ApprovalCandidate) => Promise<boolean>
  /** Digests already approved, so the same spec is never asked twice. */
  approvals: ApprovalStore
}

export type GuardVerdict = { ok: true; spec: PaneSpec } | { ok: false; reason: string }

/**
 * Decides whether `pty:ensure` may act on a renderer-supplied spec. On success
 * the spec handed back is rebuilt from the matching profile or the approved
 * candidate — never the renderer's raw object verbatim — with its env
 * sanitised.
 */
export async function verifyPaneSpec(raw: unknown, sources: GuardSources): Promise<GuardVerdict> {
  if (!isSpecShaped(raw)) return { ok: false, reason: 'malformed pane spec' }
  const spec = raw

  // A live session: no spawn will happen, and ensure() reads only the id.
  if (sources.attached?.(spec.id)) {
    return { ok: true, spec: { ...spec, env: sanitizeEnv(spec.env) } }
  }

  const builtin = await findBuiltinMatch(spec, sources)
  if (builtin) return { ok: true, spec: builtin }

  // Not a bare built-in: a custom pane, a saved launcher, a workspace action,
  // or anything carrying `setup` or env a profile did not offer. One human
  // click, remembered by digest so it only happens once for this exact spec.
  const candidate: ApprovalCandidate = {
    command: spec.command,
    args: [...spec.args],
    cwd: spec.cwd,
    viaShell: Boolean(spec.viaShell),
    ...(spec.setup?.trim() ? { setup: spec.setup } : {}),
    ...(spec.env ? { env: spec.env } : {})
  }
  const digest = approvalDigest(candidate)
  const approved = sources.approvals.has(digest) || (await sources.approve(candidate))
  if (!approved) {
    return {
      ok: false,
      reason: `pane ${spec.id} was not approved to run ${spec.command || '(empty command)'}`
    }
  }
  sources.approvals.remember(digest)

  return {
    ok: true,
    spec: {
      id: spec.id,
      command: candidate.command,
      args: candidate.args,
      cwd: candidate.cwd,
      ...(candidate.viaShell ? { viaShell: true } : {}),
      ...(candidate.setup ? { setup: candidate.setup } : {}),
      env: sanitizeEnv(candidate.env)
    }
  }
}
