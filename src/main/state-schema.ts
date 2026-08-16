import type {
  Pane,
  PaneStatus,
  PersistedState,
  Profile,
  Settings,
  TemplatePane,
  Workspace,
  WorkspaceAction,
  WorkspaceTemplate
} from '@shared/types'

/**
 * The state file is plain JSON in the profile directory, which makes it the one
 * input an attacker can shape without running any code first: a bare file write
 * plants a pane, `autoStartPanes` — in the same file — grants it a zero-click
 * spawn, and the deck executes it on every launch. See issue #59.
 *
 * Two layers stand between that file and a spawn, and they answer different
 * questions:
 *
 *  1. `sanitizeState` — is it shaped right? Every field the app consumes is
 *     checked for its declared type and rebuilt onto a fresh object, so nothing
 *     rides through on a spread. A malformed pane or workspace is dropped
 *     rather than repaired; a root that is not a state file at all is refused.
 *     Runs on both directions: what `loadState` reads and what `state:save` is
 *     about to write.
 *  2. `flagUntrustedPanes` — did the UI write it? A well-typed pane is exactly
 *     what an attacker would write, so types prove nothing about provenance.
 *     The only anchor the state file cannot forge is a profile the app itself
 *     detected on the machine — an agent binary found on PATH, a shell, a WSL
 *     launcher. Saved launchers (`custom:*`) and the free-text `custom`
 *     sentinel do not count: they are read from `custom-profiles.json`, a file
 *     in the same userData directory as `workspaces.json` and no better
 *     guarded (`profiles:saveCustom` is an ungated IPC call besides), so they
 *     are exactly as forgeable as the state file they would be vouching for. A
 *     pane whose command line re-derives from a *built-in* profile, and that
 *     carries no `setup` line (which has no anchor outside the state file
 *     either — `workspace.setupCommand` lives in that same file), was
 *     producible by the UI. Anything else is kept but flagged, and the
 *     renderer holds it at its Start overlay — the click, with the command
 *     line and every field it was flagged for on screen, is the user's
 *     confirmation.
 */

type Dict = Record<string, unknown>

const isDict = (value: unknown): value is Dict =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isString = (value: unknown): value is string => typeof value === 'string'
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean'
const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isString)

/** `env` reaches the child process verbatim, so every value must already be a string. */
const isEnv = (value: unknown): value is Record<string, string> =>
  isDict(value) && Object.values(value).every(isString)

const PANE_STATUSES: readonly unknown[] = [
  'idle',
  'running',
  'waiting',
  'exited'
] satisfies PaneStatus[]

/**
 * Everything that shapes the spawn — command, args, cwd, env, viaShell, setup —
 * must hold its declared type or the pane is dropped whole: coercing any of
 * them would be composing a command line on the file's behalf. Fields that only
 * shape presentation are normalized instead, the way `hydrate()` resets them
 * anyway.
 */
function sanitizePane(value: unknown): Pane | null {
  if (!isDict(value)) return null
  const { id, profileId, command, args, cwd, viaShell, env, setup } = value
  if (!isString(id) || !isString(profileId) || !isString(command) || !isString(cwd)) return null
  if (!isStringArray(args)) return null
  if (viaShell !== undefined && !isBoolean(viaShell)) return null
  if (env !== undefined && !isEnv(env)) return null
  if (setup !== undefined && !isString(setup)) return null

  // `needsReview` is deliberately never read off disk: it is main's verdict,
  // recomputed by `flagUntrustedPanes` on every load, and the file is exactly
  // what an attacker controls.
  return {
    id,
    profileId,
    command,
    args: [...args],
    cwd,
    ...(viaShell !== undefined ? { viaShell } : {}),
    ...(env !== undefined ? { env: { ...env } } : {}),
    ...(setup !== undefined ? { setup } : {}),
    ...(isString(value.name) ? { name: value.name } : {}),
    ...(isString(value.worktree) ? { worktree: value.worktree } : {}),
    ...(isBoolean(value.autoRestart) ? { autoRestart: value.autoRestart } : {}),
    ...(isBoolean(value.readOnly) ? { readOnly: value.readOnly } : {}),
    ...(isBoolean(value.attentionMuted) ? { attentionMuted: value.attentionMuted } : {}),
    status: PANE_STATUSES.includes(value.status) ? (value.status as PaneStatus) : 'idle',
    exitCode: isNumber(value.exitCode) ? value.exitCode : null,
    epoch: isNumber(value.epoch) ? value.epoch : 0
  }
}

const sanitizeAction = (value: unknown): WorkspaceAction | null =>
  isDict(value) && isString(value.id) && isString(value.label) && isString(value.command)
    ? { id: value.id, label: value.label, command: value.command }
    : null

function sanitizeWorkspace(value: unknown): Workspace | null {
  if (!isDict(value)) return null
  const { id, name, cwd, accent, panes } = value
  if (!isString(id) || !isString(name) || !isString(cwd) || !isString(accent)) return null
  if (!Array.isArray(panes)) return null
  const actions = Array.isArray(value.actions)
    ? value.actions.map(sanitizeAction).filter((a): a is WorkspaceAction => a !== null)
    : undefined
  return {
    id,
    name,
    cwd,
    accent,
    panes: panes.map(sanitizePane).filter((p): p is Pane => p !== null),
    activePaneId: isString(value.activePaneId) ? value.activePaneId : null,
    layout: value.layout === 'tabs' ? 'tabs' : 'grid',
    columns: isNumber(value.columns) ? Math.min(4, Math.max(1, value.columns)) : 2,
    zoomedPaneId: isString(value.zoomedPaneId) ? value.zoomedPaneId : null,
    ...(isString(value.setupCommand) ? { setupCommand: value.setupCommand } : {}),
    ...(actions ? { actions } : {})
  }
}

/**
 * Held to the same bar as a live pane: a template pane becomes a spawn the
 * moment the template lands on a folder, so its execution fields are dropped
 * whole on a type mismatch just like `sanitizePane`'s.
 */
function sanitizeTemplatePane(value: unknown): TemplatePane | null {
  if (!isDict(value)) return null
  const { profileId, command, args, cwd, viaShell, env } = value
  if (!isString(profileId) || !isString(command) || !isStringArray(args) || !isString(cwd)) {
    return null
  }
  if (viaShell !== undefined && !isBoolean(viaShell)) return null
  if (env !== undefined && !isEnv(env)) return null
  return {
    profileId,
    command,
    args: [...args],
    cwd,
    ...(viaShell !== undefined ? { viaShell } : {}),
    ...(env !== undefined ? { env: { ...env } } : {}),
    ...(isString(value.name) ? { name: value.name } : {}),
    ...(isBoolean(value.worktree) ? { worktree: value.worktree } : {})
  }
}

function sanitizeTemplate(value: unknown): WorkspaceTemplate | null {
  if (!isDict(value)) return null
  const { id, name, accent, createdAt, panes } = value
  if (!isString(id) || !isString(name) || !isString(accent) || !isString(createdAt)) return null
  if (!Array.isArray(panes)) return null
  const actions = Array.isArray(value.actions)
    ? value.actions.map(sanitizeAction).filter((a): a is WorkspaceAction => a !== null)
    : undefined
  return {
    id,
    name,
    accent,
    createdAt,
    layout: value.layout === 'tabs' ? 'tabs' : 'grid',
    columns: isNumber(value.columns) ? Math.min(4, Math.max(1, value.columns)) : 2,
    panes: panes.map(sanitizeTemplatePane).filter((p): p is TemplatePane => p !== null),
    ...(isString(value.setupCommand) ? { setupCommand: value.setupCommand } : {}),
    ...(actions ? { actions } : {})
  }
}

/** Copies only the declared keys, and each only when it holds its declared type. */
function pickTyped(raw: Dict, checks: Record<string, (value: unknown) => boolean>): Dict {
  const out: Dict = {}
  for (const [key, ok] of Object.entries(checks)) {
    if (key in raw && ok(raw[key])) out[key] = raw[key]
  }
  return out
}

const VOICE_CHECKS = {
  provider: (v: unknown) => v === 'openrouter' || v === 'openai' || v === 'groq' || v === 'custom',
  baseUrl: isString,
  model: isString,
  language: isString,
  prompt: isString,
  submit: isBoolean,
  autoStop: isBoolean
}

const ATTENTION_CHECKS = { quietMs: isNumber, notify: isBoolean, badge: isBoolean }

const REMOTE_CHECKS = { enabled: isBoolean, lan: isBoolean, allowTyping: isBoolean }

const SETTINGS_CHECKS = {
  fontSize: isNumber,
  fontFamily: isString,
  cursorStyle: (v: unknown) => v === 'block' || v === 'underline' || v === 'bar',
  cursorBlink: isBoolean,
  scrollback: isNumber,
  copyOnSelect: isBoolean,
  confirmCloseRunning: isBoolean,
  autoStartPanes: isBoolean,
  defaultCwd: isString,
  bellNotifications: isBoolean,
  sidebarCollapsed: isBoolean,
  updateChannel: (v: unknown) => v === 'local' || v === 'github' || v === 'off',
  broadcastHistory: isStringArray,
  broadcastSnippets: isStringArray
}

/**
 * Wrong-typed fields are dropped rather than defaulted: `hydrate()` in the
 * renderer already spreads the defaults underneath whatever this returns — the
 * same path a state file written before a field existed has always taken. The
 * cast says that same thing to the compiler: a partial Settings is what every
 * consumer handles.
 */
function sanitizeSettings(value: unknown): Settings {
  const raw = isDict(value) ? value : {}
  const out = pickTyped(raw, SETTINGS_CHECKS)
  if (isDict(raw.voice)) out.voice = pickTyped(raw.voice, VOICE_CHECKS)
  if (isDict(raw.attention)) out.attention = pickTyped(raw.attention, ATTENTION_CHECKS)
  if (isDict(raw.remote)) out.remote = pickTyped(raw.remote, REMOTE_CHECKS)
  return out as unknown as Settings
}

/**
 * `unknown` in, a state built field by field out — or null when the value is
 * not salvageable as a state file at all. Individual malformed panes,
 * workspaces and templates are dropped rather than taking the rest of the
 * deck down with them; a wrong-typed value never survives either way.
 *
 * `settings` and `templates` are presence-preserving: a file written before
 * either existed round-trips without them, exactly as it always has.
 */
export function sanitizeState(value: unknown): PersistedState | null {
  if (!isDict(value) || !Array.isArray(value.workspaces)) return null
  return {
    version: isNumber(value.version) ? value.version : 1,
    workspaces: value.workspaces.map(sanitizeWorkspace).filter((w): w is Workspace => w !== null),
    activeWorkspaceId: isString(value.activeWorkspaceId) ? value.activeWorkspaceId : null,
    ...('settings' in value ? { settings: sanitizeSettings(value.settings) } : {}),
    ...(Array.isArray(value.templates)
      ? {
          templates: value.templates
            .map(sanitizeTemplate)
            .filter((t): t is WorkspaceTemplate => t !== null)
        }
      : {})
  } as PersistedState
}

/**
 * The slice of a profile a pane's spawn is shaped by. `detectProfiles()`
 * returns a superset; taking only this keeps the trust check testable in plain
 * Node, where nothing can walk PATH the way the real registry does. `kind` is
 * what tells a profile the app detected on the machine apart from one read out
 * of `custom-profiles.json` — see `rederives`.
 */
export type LauncherShape = Pick<Profile, 'id' | 'command' | 'args' | 'viaShell' | 'env' | 'kind'>

/** The fields common to a live `Pane` and a template's `TemplatePane`. */
type Launchable = Pick<Pane, 'profileId' | 'command' | 'args' | 'viaShell' | 'env'>

const sameArgs = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((arg, i) => arg === b[i])

const sameEnv = (
  a: Record<string, string> | undefined,
  b: Record<string, string> | undefined
): boolean => {
  const left = Object.entries(a ?? {})
  const right = b ?? {}
  return left.length === Object.keys(right).length && left.every(([key, val]) => right[key] === val)
}

/**
 * Does this pane's command line re-derive, field for field, from a *built-in*
 * profile it claims? `env` counts as command-shaping — LD_PRELOAD under a
 * trusted binary is as much a payload as the binary itself. `cwd` does not:
 * pointing a real launcher at another folder is what workspaces are for.
 *
 * `kind === 'custom'` covers both a saved launcher (`custom:*`) and the
 * free-text sentinel (`custom` itself, `command: ''`): neither came from this
 * machine, so neither can vouch, however exactly the pane matches it.
 */
function rederives(pane: Launchable, launchers: LauncherShape[]): boolean {
  const profile = launchers.find((p) => p.id === pane.profileId)
  if (!profile || profile.kind === 'custom') return false
  return (
    pane.command === profile.command &&
    sameArgs(pane.args, profile.args) &&
    Boolean(pane.viaShell) === Boolean(profile.viaShell) &&
    sameEnv(pane.env, profile.env)
  )
}

/**
 * Marks every pane whose command line the profile registry cannot vouch for —
 * in both a workspace's live panes and any saved templates, since a template's
 * panes spawn on instantiation with just as little review. The registry is the
 * trust anchor precisely because a built-in profile is the one thing the state
 * file cannot write for itself: any gate decidable from the file alone —
 * including `settings.autoStartPanes` — is a gate the attacker operates, and
 * (per `rederives`) so is anything sourced from `custom-profiles.json`.
 *
 * A `setup` line gets no exception either: `pane.setup` and
 * `workspace.setupCommand` live in the same file, so a match between them
 * proves nothing — the attacker who writes one writes both. Any pane carrying
 * a non-empty `setup` is flagged outright. Kept but flagged, either way: the
 * renderer turns the flag into the Start overlay, the command and every
 * flagged field in view, one click to run.
 */
export function flagUntrustedPanes(
  state: PersistedState,
  launchers: LauncherShape[]
): PersistedState {
  return {
    ...state,
    workspaces: state.workspaces.map((workspace) => ({
      ...workspace,
      panes: workspace.panes.map((pane) => {
        const trusted = !pane.setup && rederives(pane, launchers)
        return trusted ? pane : { ...pane, needsReview: true as const }
      })
    })),
    ...(state.templates
      ? {
          templates: state.templates.map((template) => ({
            ...template,
            panes: template.panes.map((pane) =>
              rederives(pane, launchers) ? pane : { ...pane, needsReview: true as const }
            )
          }))
        }
      : {})
  }
}
