import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppInfo,
  CheckpointInfo,
  DiffRequest,
  DiffResult,
  EnsureResult,
  ForgeCli,
  InstallResult,
  PaneSpec,
  PaneStatus,
  PersistedState,
  Profile,
  PtyDataEvent,
  PtyExitEvent,
  PtyQuietEvent,
  RemoteStatus,
  RepoInfo,
  SavedProfile,
  SaveStateResult,
  SaveTextRequest,
  SaveTextResult,
  TranscribeRequest,
  TranscribeResult,
  UpdateChannel,
  UpdateState,
  VoiceKeyState,
  VoiceProvider,
  WorktreeRequest,
  WorktreeResult
} from '@shared/types'
import { IPC, type IpcChannel } from '@shared/ipc'

function subscribe<T>(channel: IpcChannel, handler: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  info: (): Promise<AppInfo> => ipcRenderer.invoke(IPC.appInfo),

  loadState: (): Promise<PersistedState | null> => ipcRenderer.invoke(IPC.stateLoad),
  /** Resolves with what became of the write, so the renderer can say when it failed. */
  saveState: (state: PersistedState): Promise<SaveStateResult> =>
    ipcRenderer.invoke(IPC.stateSave, state),
  stateLocation: (): Promise<string> => ipcRenderer.invoke(IPC.stateLocation),

  /** @deprecated Use `profiles.list`. Kept so older call sites keep compiling. */
  listProfiles: (): Promise<Profile[]> => ipcRenderer.invoke(IPC.profilesList),

  profiles: {
    list: (): Promise<Profile[]> => ipcRenderer.invoke(IPC.profilesList),
    /** Returns the full detected + saved list, so callers can drop the result straight into state. */
    saveCustom: (profile: SavedProfile): Promise<Profile[]> =>
      ipcRenderer.invoke(IPC.profilesSaveCustom, profile),
    removeCustom: (id: string): Promise<Profile[]> =>
      ipcRenderer.invoke(IPC.profilesRemoveCustom, id)
  },

  git: {
    info: (dir: string): Promise<RepoInfo | null> => ipcRenderer.invoke(IPC.gitInfo, dir),
    addWorktree: (req: WorktreeRequest): Promise<WorktreeResult> =>
      ipcRenderer.invoke(IPC.gitAddWorktree, req),
    removeWorktree: (path: string): Promise<WorktreeResult> =>
      ipcRenderer.invoke(IPC.gitRemoveWorktree, path),
    diffStat: (dir: string): Promise<string> => ipcRenderer.invoke(IPC.gitDiffStat, dir),
    /** What a pane changed since its branch left the trunk, already capped. See HD-3. */
    diffRange: (req: DiffRequest): Promise<DiffResult> => ipcRenderer.invoke(IPC.gitDiffRange, req),
    /** Quiet-burst snapshots of a worktree, hidden refs only. See HD-20. */
    checkpoint: (dir: string): Promise<void> => ipcRenderer.invoke(IPC.gitCheckpoint, dir),
    checkpoints: (dir: string): Promise<CheckpointInfo[]> =>
      ipcRenderer.invoke(IPC.gitCheckpoints, dir),
    restoreCheckpoint: (dir: string, ref: string): Promise<WorktreeResult> =>
      ipcRenderer.invoke(IPC.gitRestoreCheckpoint, dir, ref),
    dropCheckpoints: (repoRoot: string, paneId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.gitDropCheckpoints, repoRoot, paneId),
    deleteBranch: (repoRoot: string, branch: string): Promise<WorktreeResult> =>
      ipcRenderer.invoke(IPC.gitDeleteBranch, repoRoot, branch),
    forge: (): Promise<ForgeCli | null> => ipcRenderer.invoke(IPC.gitForge)
  },

  attention: {
    setBadge: (count: number): void => ipcRenderer.send(IPC.appSetBadge, count)
  },

  fs: {
    /**
     * Which of these folders are not there. The renderer has no filesystem of
     * its own, and instantiating a template has to know before it makes panes
     * that would silently spawn in `homedir()` instead.
     */
    missingDirs: (paths: string[]): Promise<string[]> =>
      ipcRenderer.invoke(IPC.fsMissingDirs, paths)
  },

  update: {
    state: (): Promise<UpdateState> => ipcRenderer.invoke(IPC.updateState),
    check: (): Promise<UpdateState> => ipcRenderer.invoke(IPC.updateCheck),
    /** The main process starts on `local` and only polls elsewhere once told to. */
    setChannel: (channel: UpdateChannel): Promise<UpdateState> =>
      ipcRenderer.invoke(IPC.updateSetChannel, channel),
    install: (): Promise<InstallResult> => ipcRenderer.invoke(IPC.updateInstall),
    onChange: (handler: (state: UpdateState) => void): (() => void) =>
      subscribe(IPC.updateChanged, handler)
  },

  pty: {
    ensure: (spec: PaneSpec, cols: number, rows: number): Promise<EnsureResult> =>
      ipcRenderer.invoke(IPC.ptyEnsure, spec, cols, rows),
    write: (id: string, data: string): void => ipcRenderer.send(IPC.ptyWrite, id, data),
    resize: (id: string, cols: number, rows: number): void =>
      ipcRenderer.send(IPC.ptyResize, id, cols, rows),
    kill: (id: string): void => ipcRenderer.send(IPC.ptyKill, id),
    dispose: (id: string): void => ipcRenderer.send(IPC.ptyDispose, id),
    status: (id: string): Promise<{ status: PaneStatus; exitCode: number | null } | null> =>
      ipcRenderer.invoke(IPC.ptyStatus, id),
    running: (): Promise<string[]> => ipcRenderer.invoke(IPC.ptyRunning),
    onData: (handler: (event: PtyDataEvent) => void): (() => void) =>
      subscribe(IPC.ptyData, handler),
    onExit: (handler: (event: PtyExitEvent) => void): (() => void) => subscribe(IPC.ptyExit, handler),
    onQuiet: (handler: (event: PtyQuietEvent) => void): (() => void) =>
      subscribe(IPC.ptyQuiet, handler),
    /**
     * The pane's replay buffer as one string — the last ~512 KB it produced.
     * `strip` takes the escape sequences out, for somewhere that is not a
     * terminal; leave it off to get a stream that replays.
     */
    transcript: (id: string, strip = false): Promise<string> =>
      ipcRenderer.invoke(IPC.ptyTranscript, id, strip),
    /** Last `lines` non-empty lines, ANSI-stripped in main (`stripAnsi` lives there). */
    tail: (id: string, lines: number): Promise<string[]> =>
      ipcRenderer.invoke(IPC.ptyTail, id, lines)
  },

  pickDirectory: (current?: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.dialogPickDirectory, current),
  confirm: (options: {
    title: string
    message: string
    detail?: string
    confirmLabel?: string
  }): Promise<boolean> => ipcRenderer.invoke(IPC.dialogConfirm, options),
  /** Save-as dialog and the write behind it, so the renderer never holds a handle. */
  saveText: (req: SaveTextRequest): Promise<SaveTextResult> =>
    ipcRenderer.invoke(IPC.dialogSaveText, req),

  clipboard: {
    /** Empty unless invoked within a moment of the paste chord (paste-gate.ts). */
    read: (): Promise<string> => ipcRenderer.invoke(IPC.clipboardRead),
    write: (text: string): void => ipcRenderer.send(IPC.clipboardWrite, text)
  },

  voice: {
    keyState: (provider: VoiceProvider): Promise<VoiceKeyState> =>
      ipcRenderer.invoke(IPC.voiceKeyState, provider),
    /** Pass null to forget the stored key. */
    setKey: (provider: VoiceProvider, key: string | null): Promise<VoiceKeyState> =>
      ipcRenderer.invoke(IPC.voiceSetKey, provider, key),
    transcribe: (req: TranscribeRequest): Promise<TranscribeResult> =>
      ipcRenderer.invoke(IPC.voiceTranscribe, req),
    /** macOS only; elsewhere the OS has no per-app microphone gate. */
    requestMicAccess: (): Promise<boolean> => ipcRenderer.invoke(IPC.voiceMicAccess)
  },

  /** Deck Remote — the watch-from-elsewhere page. All stubs until HD-21. */
  remote: {
    status: (): Promise<RemoteStatus> => ipcRenderer.invoke(IPC.remoteStatus),
    setEnabled: (on: boolean): Promise<RemoteStatus> => ipcRenderer.invoke(IPC.remoteSetEnabled, on),
    setLan: (on: boolean): Promise<RemoteStatus> => ipcRenderer.invoke(IPC.remoteSetLan, on),
    setAllowTyping: (on: boolean): Promise<RemoteStatus> =>
      ipcRenderer.invoke(IPC.remoteSetAllowTyping, on),
    onStatus: (handler: (status: RemoteStatus) => void): (() => void) =>
      subscribe(IPC.remoteStatus, handler)
  },

  window: {
    minimize: (): void => ipcRenderer.send(IPC.windowMinimize),
    toggleMaximize: (): void => ipcRenderer.send(IPC.windowToggleMaximize),
    close: (): void => ipcRenderer.send(IPC.windowClose),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke(IPC.windowIsMaximized),
    onMaximizedChange: (handler: (maximized: boolean) => void): (() => void) =>
      subscribe(IPC.windowMaximized, handler),
    onFullscreenChange: (handler: (fullscreen: boolean) => void): (() => void) =>
      subscribe(IPC.windowFullscreen, handler),
    onFocusChange: (handler: (focused: boolean) => void): (() => void) =>
      subscribe(IPC.windowFocus, handler)
  },

  openExternal: (url: string): void => ipcRenderer.send(IPC.appOpenExternal, url),
  openPath: (path: string): void => ipcRenderer.send(IPC.appOpenPath, path),
  /**
   * Dev-only: the channel is registered only when the app was launched with
   * `--capture=` (rejects otherwise), and the target must stay inside that
   * flag's directory — anything else comes back null. See issue #29.
   */
  capture: (target: string): Promise<string | null> => ipcRenderer.invoke(IPC.appCapture, target)
}

export type HarnessApi = typeof api

contextBridge.exposeInMainWorld('harness', api)
