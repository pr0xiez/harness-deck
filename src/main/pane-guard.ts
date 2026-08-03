import type { PaneSpec, PersistedState, Profile } from '@shared/types'

/**
 * The gate `pty:ensure` runs behind. The renderer used to hand over a full
 * PaneSpec — command, args, cwd, viaShell, env — and the main process spawned
 * it verbatim, which made one IPC message equal to arbitrary shell execution
 * (issue #18). The renderer is the least-trusted process in the app, so nothing
 * it says about *what to run* is taken at face value any more.
 *
 * What is trusted instead are the main process's own records of what the user
 * configured:
 *
 *   - the persisted deck state (`workspaces.json`, written via `state:save`) —
 *     a spec must match its pane, found by id, field for field; the spawn then
 *     uses the persisted copy, not the renderer's;
 *   - the profile registry (`detectProfiles()`: detected harnesses, shells,
 *     WSL entries and saved launchers) — for a pane so fresh the debounced
 *     save has not landed yet, the spec must be exactly some profile's
 *     command line (only the working directory is the caller's to choose).
 *
 * Free-form custom commands remain a real feature: they exist as panes in the
 * saved state (the renderer flushes its save before asking for a spawn) or as
 * saved launchers, and both routes verify here. What no longer works is a spec
 * that corresponds to nothing the user ever configured.
 *
 * `env` is additionally sanitised on every route: pane-level variables are a
 * user feature with user-chosen names, so there is no allowlist to derive —
 * but keys that would hijack the app, the loader or the shell's startup are
 * dropped unconditionally, wherever they came from.
 *
 * No `electron` import here: this runs under plain-Node unit tests, and every
 * source of truth is injected.
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

/** Where the truth about panes and profiles comes from — injected, for tests. */
export interface GuardSources {
  /** The persisted deck state, re-read per call: `state:save` is the writer. */
  state: () => PersistedState | null
  /** Detected harnesses + shells + saved launchers. Only consulted on a miss by id. */
  profiles: () => Profile[] | Promise<Profile[]>
  /**
   * True when a live session already exists for this id. `ensure` on a live
   * session only re-attaches — it reads nothing from the spec but the id — so
   * a window reload may re-attach to a pane the state file has not caught up
   * with yet.
   */
  attached?: (id: string) => boolean
  /**
   * One retry, this long after a miss, before refusing. The renderer flushes
   * its save before asking for a spawn, but the two messages ride different
   * IPC channels — this absorbs the save landing a beat late.
   */
  retryMs?: number
}

export type GuardVerdict = { ok: true; spec: PaneSpec } | { ok: false; reason: string }

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
      (spec.env === undefined || isEnvRecord(spec.env))
  )
}

const sameArgs = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((item, i) => item === b[i])

function sameEnv(a: Record<string, string> = {}, b: Record<string, string> = {}): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key])
}

/** The renderer's spec against a record the main process holds. cwd optional: a
 *  profile pins no folder, so any directory is the user's to pick. */
function matches(
  spec: PaneSpec,
  known: Pick<PaneSpec, 'command' | 'args' | 'viaShell' | 'env'> & { cwd?: string },
  checkCwd: boolean
): boolean {
  return (
    spec.command === known.command &&
    sameArgs(spec.args, known.args) &&
    Boolean(spec.viaShell) === Boolean(known.viaShell) &&
    sameEnv(spec.env, known.env) &&
    (!checkCwd || spec.cwd === (known.cwd ?? spec.cwd))
  )
}

/** One pass over both sources. Returns the verified spec, rebuilt from the
 *  matching record rather than the renderer's copy, or null. */
async function findMatch(spec: PaneSpec, sources: GuardSources): Promise<PaneSpec | null> {
  const state = sources.state()
  const pane = state?.workspaces.flatMap((w) => w.panes).find((p) => p.id === spec.id)
  if (pane && matches(spec, pane, true)) {
    return {
      id: spec.id,
      command: pane.command,
      args: [...pane.args],
      cwd: pane.cwd,
      ...(pane.viaShell ? { viaShell: true } : {}),
      ...(pane.env ? { env: pane.env } : {})
    }
  }

  // Not in the state file (or the file is behind): a brand-new pane opened
  // straight from a profile. The command line must be some profile's, exactly;
  // the folder is free — that is the one thing a user picks per pane.
  if (spec.command) {
    const profiles = await sources.profiles()
    const profile = profiles.find((p) => p.command && matches(spec, p, false))
    if (profile) {
      return {
        id: spec.id,
        command: profile.command,
        args: [...profile.args],
        cwd: spec.cwd,
        ...(profile.viaShell ? { viaShell: true } : {}),
        ...(profile.env ? { env: profile.env } : {})
      }
    }
  }
  return null
}

const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

/**
 * Decides whether `pty:ensure` may act on a renderer-supplied spec. On success
 * the spec handed back is rebuilt from the matching main-process record with
 * its env sanitised — the renderer's inline copy is never what gets spawned.
 */
export async function verifyPaneSpec(raw: unknown, sources: GuardSources): Promise<GuardVerdict> {
  if (!isSpecShaped(raw)) return { ok: false, reason: 'malformed pane spec' }
  const spec = raw

  // A live session: no spawn will happen, and ensure() reads only the id.
  if (sources.attached?.(spec.id)) {
    return { ok: true, spec: { ...spec, env: sanitizeEnv(spec.env) } }
  }

  let match = await findMatch(spec, sources)
  if (!match) {
    // The state save and the spawn request race once per brand-new pane; give
    // the save one chance to land before calling the spec unknown.
    await wait(sources.retryMs ?? 300)
    match = await findMatch(spec, sources)
  }
  if (!match) {
    return {
      ok: false,
      reason: `pane ${spec.id} does not correspond to any configured pane or profile`
    }
  }
  return { ok: true, spec: { ...match, env: sanitizeEnv(match.env) } }
}
