/** Types shared between the main process, the preload bridge and the renderer. */

/** Explicit agent activity, independent of PTY output and process liveness. */
export type AgentActivity = 'unknown' | 'ready' | 'working' | 'waiting'

export interface AgentActivityEvent { id: string; activity: AgentActivity }

/** Waiting is live: a hook requested attention, or an untracked agent went quiet. */
export type PaneStatus = 'idle' | 'running' | 'waiting' | 'exited'
export type LayoutMode = 'grid' | 'tabs'
export type ProfileKind = 'agent' | 'shell' | 'custom'

/** A launchable command ("harness") the user can drop into a pane. */
export interface Profile {
  id: string
  name: string
  /** Executable, resolved against the login-shell PATH when possible. */
  command: string
  args: string[]
  kind: ProfileKind
  /** Single glyph shown in pane headers and menus. */
  icon: string
  accent: string
  /** Whether the executable was found on PATH. */
  available: boolean
  /** Where we found it, or a hint on how to install it. */
  detail?: string
  /** Run the command line through an interactive login shell. */
  viaShell?: boolean
  /** Saved launchers only: the folder and environment the user pinned to it. */
  cwd?: string
  env?: Record<string, string>
}

/** Everything needed to (re)spawn a pane's process. */
export interface PaneSpec {
  id: string
  command: string
  args: string[]
  cwd: string
  viaShell?: boolean
  env?: Record<string, string>
  /** Runs before the command line, through a shell, in the same pane. See HD-16. */
  setup?: string
  /** Changes only for an explicit fresh conversation; stable across process/app restarts. */
  sessionGeneration?: string
}

export interface Pane extends PaneSpec {
  profileId: string
  /** User-supplied name; falls back to the profile name. */
  name?: string
  /** Title reported by the process through the OSC title escape sequence. */
  processTitle?: string
  status: PaneStatus
  exitCode?: number | null
  /** Bumped to force a fresh terminal + process. */
  epoch: number
  /** Output arrived while the pane was not focused. */
  activity?: boolean
  /** The process rang the terminal bell. */
  bell?: boolean
  /** Bring the process back when it dies with a non-zero code. See HD-11. */
  autoRestart?: boolean
  /** Refuse everything that would put bytes into this pane's process. See HD-13. */
  readOnly?: boolean
  /** Set when the pane's cwd is a worktree this app created for it. */
  worktree?: string
  /**
   * Never reaches an attention aggregate — badge, queue or jump.
   * The pane's own header dot stays: local truth survives the mute. See HD-15.
   */
  attentionMuted?: boolean
}

export interface Workspace {
  id: string
  name: string
  cwd: string
  accent: string
  panes: Pane[]
  activePaneId: string | null
  layout: LayoutMode
  /** Column count for grid layout (1-4). */
  columns: number
  zoomedPaneId: string | null
  /** Copied onto worktree panes at creation, run before their command. See HD-16. */
  setupCommand?: string
  actions?: WorkspaceAction[]
}

/** A named command the toolbar offers as one click. See HD-16. */
export interface WorkspaceAction {
  id: string
  label: string
  command: string
}

/**
 * A workspace saved without its folder, so the same set of panes can be pointed
 * at another repo. See HD-5.
 */
export interface WorkspaceTemplate {
  id: string
  name: string
  accent: string
  layout: LayoutMode
  columns: number
  panes: TemplatePane[]
  /** Both travel with the panes when the template lands on another repo. See HD-16. */
  setupCommand?: string
  actions?: WorkspaceAction[]
  /** ISO date it was saved, shown in the picker. */
  createdAt: string
}

/** A pane inside a template. It carries no absolute path and no worktree. */
export interface TemplatePane {
  profileId: string
  command: string
  args: string[]
  /** Folder relative to the workspace folder, `/`-separated. Empty is the folder itself. */
  cwd: string
  viaShell?: boolean
  env?: Record<string, string>
  name?: string
  /**
   * The pane ran in a worktree of its workspace. The path cannot travel — two
   * workspaces sharing one worktree directory is the thing worktree panes exist
   * to avoid — so only the intent does, and a fresh one is made on the way in.
   */
  worktree?: boolean
}

export interface Settings {
  fontSize: number
  fontFamily: string
  cursorStyle: 'block' | 'underline' | 'bar'
  cursorBlink: boolean
  scrollback: number
  copyOnSelect: boolean
  confirmCloseRunning: boolean
  /** Start every pane of a workspace as soon as it is first opened. */
  autoStartPanes: boolean
  defaultCwd: string
  sidebarCollapsed: boolean
  voice: VoiceSettings
  attention: AttentionSettings
  remote: RemoteSettings
  /** Which release channel the updater watches. See HD-10. */
  updateChannel: UpdateChannel
  /** Recent broadcast prompts, most recent first. */
  broadcastHistory: string[]
  /** Prompts the user keeps around to send again. */
  broadcastSnippets: string[]
  /** Profile ids shown again at the top of the new-pane menu. */
  favoriteProfileIds: string[]
}

/** One resumable opencode session, as `opencode session list --format json` reports it. */
export interface OpencodeSession {
  id: string
  /** What the session was about; the CLI may leave it blank. */
  title: string
  /** Epoch milliseconds of the last turn, when the CLI said. */
  updated?: number
  /** Folder the session ran in, when the CLI said. */
  directory?: string
}

/**
 * What the opencode pane dialog offers to pick from. Any list may come back
 * empty — a CLI that would not answer still leaves every field usable as free
 * text, which is all it ever was to opencode.
 */
export interface OpencodeInfo {
  models: string[]
  agents: string[]
  sessions: OpencodeSession[]
  /** Why the lists are empty, when the CLI could not be asked at all. */
  error?: string
}

/** When a quiet pane counts as wanting attention, and how loudly it says so. */
export interface AttentionSettings {
  /** Milliseconds of silence from a running process before it counts as waiting. */
  quietMs: number
  /** Count waiting panes on the dock icon or flash the taskbar. */
  badge: boolean
}

/**
 * Deck Remote — the page this app can serve so another device may watch the
 * deck. See HD-21. Unrelated to `RemoteTarget` in `shared/remote.ts`, which is
 * a pane whose process runs somewhere else. The access token is deliberately
 * absent: it is regenerated on every enable and lives only in main-process
 * memory.
 */
export interface RemoteSettings {
  enabled: boolean
  /** Listen on every interface rather than loopback only. */
  lan: boolean
  allowTyping: boolean
}

/** What the remote server is doing right now. See HD-21/22. */
export interface RemoteStatus {
  enabled: boolean
  /** Reachable URL including the token fragment, when enabled. */
  url: string | null
  lan: boolean
  allowTyping: boolean
  clients: number
}

/** Speech-to-text service. `custom` is any OpenAI-compatible endpoint. */
export type VoiceProvider = 'openrouter' | 'openai' | 'groq' | 'custom'

/** Dictation preferences. Empty strings mean "use the provider default". */
export interface VoiceSettings {
  provider: VoiceProvider
  baseUrl: string
  model: string
  /** ISO-639-1 hint ("en"); empty lets the model detect the language. */
  language: string
  /** Vocabulary hint — names and jargon the model keeps misspelling. */
  prompt: string
  /** Press Enter after the transcript is inserted. */
  submit: boolean
  /** Stop recording by itself once you stop talking. */
  autoStop: boolean
}

/** Where the API key for the selected provider comes from, if anywhere. */
export interface VoiceKeyState {
  hasKey: boolean
  source: 'stored' | 'env' | 'none'
  /** Environment variable it was read from, when `source` is `env`. */
  envVar?: string
  /** False when no OS keychain was available and the stored key is only obfuscated. */
  encrypted?: boolean
}

export interface TranscribeRequest {
  audio: ArrayBuffer
  mimeType: string
  fileName: string
  provider: VoiceProvider
  /** Fully resolved, without a trailing slash. */
  baseUrl: string
  model: string
  language?: string
  prompt?: string
}

export interface TranscribeResult {
  text?: string
  error?: string
  /** HTTP status, when the request reached the service. */
  status?: number
  ms: number
}

export interface PersistedState {
  version: number
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  settings: Settings
  /** Optional: a state file written before templates existed has none. */
  templates?: WorkspaceTemplate[]
}

/** What became of one attempt to put the state file on disk. */
export interface SaveStateResult {
  ok: boolean
  error?: string
}

export interface AppInfo {
  platform: NodeJS.Platform
  versions: { electron: string; chrome: string; node: string; app: string }
  homeDir: string
  defaultShell: string
  defaultCwd: string
}

export interface EnsureResult {
  /** False when the session already existed and was re-attached. */
  created: boolean
  agentActivity?: AgentActivity
  status: PaneStatus
  pid?: number
  exitCode?: number | null
  /** Buffered output to replay into a fresh terminal. */
  replay: string
  /**
   * The replay opens with output from before the app was last quit, restored
   * from disk. History, not a live process — `status` still describes the one
   * running now. See HD-6.
   */
  previousSession?: boolean
  error?: string
}

export interface PtyDataEvent {
  id: string
  data: string
  /** Attachment generation and cumulative UTF-8 bytes sent on it. */
  flowId: number
  offset: number
}

export interface PtyExitEvent {
  id: string
  exitCode: number
  signal?: number
}

export interface PtyQuietEvent {
  id: string
  /** True when the pane went quiet, false on the first byte after that. */
  quiet: boolean
}

/** A git repository behind a workspace or pane folder. See HD-2. */
export interface RepoInfo {
  root: string
  branch: string
  dirty: number
  /** Set when this folder is a linked worktree rather than the main one. */
  worktreeOf?: string
}

export interface WorktreeRequest {
  repo: string
  /** Branch to create; the caller guarantees it is unique. */
  branch: string
  path: string
}

export interface WorktreeResult {
  ok: boolean
  path?: string
  error?: string
}

/** One pane's work, asked for by the compare view. See HD-3. */
export interface DiffRequest {
  /** The pane's folder. The answer is about the whole worktree above it. */
  dir: string
  /**
   * Diff from this ref instead of the branch point the main process would
   * otherwise compute. `DiffResult.base`/`baseRef` report whichever won. See HD-20.
   */
  base?: string
  /** Most patch lines to send back. The main process never ships more than this. */
  limit?: number
}

/**
 * What one column of the compare view draws. Measured from the branch point
 * rather than from HEAD, and inclusive of staged, committed and untracked work
 * — an agent that finished its task and committed it has changed everything,
 * and plain `git diff` would report nothing at all.
 */
export interface DiffResult {
  /** Echoed back, so a late answer can be matched to the pane that asked. */
  dir: string
  /** Empty when the folder is not a git repository. */
  root: string
  branch: string
  /** The commit the diff is measured from. */
  base: string
  /** What that commit belongs to — a branch name, or `HEAD`. For the header. */
  baseRef: string
  /** `git diff --stat`, with a block of its own for files git has not been told about. */
  stat: string
  /** The patch, cut to `limit` lines. */
  patch: string
  /** Lines the patch has in full, so the fold can say how much is missing. */
  patchLines: number
  /** True when `patch` stops short of `patchLines`. */
  truncated: boolean
  /** New files in the tree, counted whether or not each one got a diff of its own. */
  untracked: number
  /** Why there is nothing to show, when that is not simply "nothing changed". */
  error?: string
}

/** One quiet-burst snapshot of a worktree. See HD-20. */
export interface CheckpointInfo {
  ref: string
  /** ISO time the burst ended. */
  at: string
  /** `git diff --shortstat` against the previous checkpoint, for the menu. */
  summary: string
}

/** Which PR-capable CLI is on PATH, if any. See HD-18. */
export type ForgeCli = 'gh' | 'glab'

/** A launcher the user saved, merged with the detected ones. See HD-4. */
export interface SavedProfile {
  id: string
  name: string
  command: string
  args: string[]
  cwd?: string
  env?: Record<string, string>
  icon: string
  accent: string
  viaShell?: boolean
}

/** Text on its way to a file the user picks — a pane transcript today. See HD-8. */
export interface SaveTextRequest {
  /** Pre-filled in the dialog; the user is free to rename it. */
  defaultName: string
  text: string
}

export interface SaveTextResult {
  ok: boolean
  /** Where it landed, when it landed. */
  path?: string
  /** The user dismissed the dialog — not a failure, and nothing to report. */
  canceled?: boolean
  error?: string
}

/** What a waiting release tells the user about itself. */
export interface UpdateInfo {
  version: string
  /** One-line summary of the change, usually the release commit subject. */
  notes?: string
  releasedAt?: string
  /** Installer size in bytes. */
  size?: number
}

/**
 * Where updates come from: a manifest `npm run release` writes on this machine,
 * the GitHub release CI publishes to, or nowhere at all.
 */
export type UpdateChannel = 'local' | 'github' | 'off'

export interface UpdateState {
  stage: 'idle' | 'available' | 'error'
  /** Version of the running app. */
  current: string
  /** Set only when a newer release is sitting in the channel, ready to install. */
  available: UpdateInfo | null
  /** The channel the state was produced by — the others are not being polled. */
  channel: UpdateChannel
  /** The manifest the app is watching — shown in Settings so it can be checked. */
  manifestPath: string
  /** The `latest*.yml` the GitHub channel reads, for the same reason. */
  feedUrl: string
  lastCheckedAt: string | null
  /** Why the last check failed. A check that fails leaves the poll running. */
  error?: string
  /** False in `npm run dev`: there is no installed copy to replace. */
  installable: boolean
}

export interface InstallResult {
  ok: boolean
  error?: string
}
