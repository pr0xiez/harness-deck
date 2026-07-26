/** Types shared between the main process, the preload bridge and the renderer. */

export type PaneStatus = 'idle' | 'running' | 'exited'
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
