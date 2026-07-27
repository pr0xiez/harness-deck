/** Types shared between the main process, the preload bridge and the renderer. */

/** `waiting` is a running process that has stopped producing output — see HD-1. */
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
  /** Set when the pane's cwd is a worktree this app created for it. */
  worktree?: string
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
  bellNotifications: boolean
  sidebarCollapsed: boolean
  voice: VoiceSettings
  attention: AttentionSettings
  /** Which release channel the updater watches. See HD-10. */
  updateChannel: UpdateChannel
  /** Recent broadcast prompts, most recent first. */
  broadcastHistory: string[]
  /** Prompts the user keeps around to send again. */
  broadcastSnippets: string[]
}

/** When a quiet pane counts as wanting attention, and how loudly it says so. */
export interface AttentionSettings {
  /** Milliseconds of silence from a running process before it counts as waiting. */
  quietMs: number
  notify: boolean
  /** Bounce the dock / flash the taskbar as well as notifying. */
  badge: boolean
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
