import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppInfo,
  EnsureResult,
  InstallResult,
  PaneSpec,
  PaneStatus,
  PersistedState,
  Profile,
  PtyDataEvent,
  PtyExitEvent,
  PtyQuietEvent,
  RepoInfo,
  SavedProfile,
  TranscribeRequest,
  TranscribeResult,
  UpdateState,
  VoiceKeyState,
  VoiceProvider,
  WorktreeRequest,
  WorktreeResult
} from '@shared/types'

function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  info: (): Promise<AppInfo> => ipcRenderer.invoke('app:info'),

  loadState: (): Promise<PersistedState | null> => ipcRenderer.invoke('state:load'),
  saveState: (state: PersistedState): void => ipcRenderer.send('state:save', state),
  stateLocation: (): Promise<string> => ipcRenderer.invoke('state:location'),

  /** @deprecated Use `profiles.list`. Kept so older call sites keep compiling. */
  listProfiles: (): Promise<Profile[]> => ipcRenderer.invoke('profiles:list'),

  profiles: {
    list: (): Promise<Profile[]> => ipcRenderer.invoke('profiles:list'),
    /** Returns the full detected + saved list, so callers can drop the result straight into state. */
    saveCustom: (profile: SavedProfile): Promise<Profile[]> =>
      ipcRenderer.invoke('profiles:saveCustom', profile),
    removeCustom: (id: string): Promise<Profile[]> =>
      ipcRenderer.invoke('profiles:removeCustom', id)
  },

  git: {
    info: (dir: string): Promise<RepoInfo | null> => ipcRenderer.invoke('git:info', dir),
    addWorktree: (req: WorktreeRequest): Promise<WorktreeResult> =>
      ipcRenderer.invoke('git:addWorktree', req),
    removeWorktree: (path: string): Promise<WorktreeResult> =>
      ipcRenderer.invoke('git:removeWorktree', path),
    diffStat: (dir: string): Promise<string> => ipcRenderer.invoke('git:diffStat', dir)
  },

  attention: {
    setBadge: (count: number): void => ipcRenderer.send('app:setBadge', count)
  },

  update: {
    state: (): Promise<UpdateState> => ipcRenderer.invoke('update:state'),
    check: (): Promise<UpdateState> => ipcRenderer.invoke('update:check'),
    install: (): Promise<InstallResult> => ipcRenderer.invoke('update:install'),
    onChange: (handler: (state: UpdateState) => void): (() => void) =>
      subscribe('update:changed', handler)
  },

  pty: {
    ensure: (spec: PaneSpec, cols: number, rows: number): Promise<EnsureResult> =>
      ipcRenderer.invoke('pty:ensure', spec, cols, rows),
    write: (id: string, data: string): void => ipcRenderer.send('pty:write', id, data),
    resize: (id: string, cols: number, rows: number): void =>
      ipcRenderer.send('pty:resize', id, cols, rows),
    kill: (id: string): void => ipcRenderer.send('pty:kill', id),
    dispose: (id: string): void => ipcRenderer.send('pty:dispose', id),
    status: (id: string): Promise<{ status: PaneStatus; exitCode: number | null } | null> =>
      ipcRenderer.invoke('pty:status', id),
    running: (): Promise<string[]> => ipcRenderer.invoke('pty:running'),
    onData: (handler: (event: PtyDataEvent) => void): (() => void) =>
      subscribe('pty:data', handler),
    onExit: (handler: (event: PtyExitEvent) => void): (() => void) => subscribe('pty:exit', handler),
    onQuiet: (handler: (event: PtyQuietEvent) => void): (() => void) =>
      subscribe('pty:quiet', handler),
    /** The pane's replay buffer as one string — the last ~512 KB it produced. */
    transcript: (id: string): Promise<string> => ipcRenderer.invoke('pty:transcript', id)
  },

  pickDirectory: (current?: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:pickDirectory', current),
  confirm: (options: {
    title: string
    message: string
    detail?: string
    confirmLabel?: string
  }): Promise<boolean> => ipcRenderer.invoke('dialog:confirm', options),

  clipboard: {
    read: (): Promise<string> => ipcRenderer.invoke('clipboard:read'),
    write: (text: string): void => ipcRenderer.send('clipboard:write', text)
  },

  voice: {
    keyState: (provider: VoiceProvider): Promise<VoiceKeyState> =>
      ipcRenderer.invoke('voice:keyState', provider),
    /** Pass null to forget the stored key. */
    setKey: (provider: VoiceProvider, key: string | null): Promise<VoiceKeyState> =>
      ipcRenderer.invoke('voice:setKey', provider, key),
    transcribe: (req: TranscribeRequest): Promise<TranscribeResult> =>
      ipcRenderer.invoke('voice:transcribe', req),
    /** macOS only; elsewhere the OS has no per-app microphone gate. */
    requestMicAccess: (): Promise<boolean> => ipcRenderer.invoke('voice:micAccess')
  },

  window: {
    minimize: (): void => ipcRenderer.send('window:minimize'),
    toggleMaximize: (): void => ipcRenderer.send('window:toggleMaximize'),
    close: (): void => ipcRenderer.send('window:close'),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:isMaximized'),
    onMaximizedChange: (handler: (maximized: boolean) => void): (() => void) =>
      subscribe('window:maximized', handler),
    onFullscreenChange: (handler: (fullscreen: boolean) => void): (() => void) =>
      subscribe('window:fullscreen', handler),
    onFocusChange: (handler: (focused: boolean) => void): (() => void) =>
      subscribe('window:focus', handler)
  },

  openExternal: (url: string): void => ipcRenderer.send('app:openExternal', url),
  openPath: (path: string): void => ipcRenderer.send('app:openPath', path),
  capture: (target: string): Promise<string | null> => ipcRenderer.invoke('app:capture', target)
}

export type HarnessApi = typeof api

contextBridge.exposeInMainWorld('harness', api)
