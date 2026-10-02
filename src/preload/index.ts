import { contextBridge, ipcRenderer } from 'electron'
import type {
  AgentActivityEvent,
  AppInfo,
  CheckpointInfo,
  DiffRequest,
  DiffResult,
  EnsureResult,
  ForgeCli,
  InstallResult,
  OpencodeInfo,
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
import type { GitHubSnapshot } from '@shared/github'
import type { OpenRouterModels } from '@shared/openrouter'
import type { McpInventory, McpMutation, McpMutationResult, McpTarget } from '@shared/mcp'
import type { WorkAccess, WorkBoard, WorkMutation, WorkResult } from '@shared/work-board'
import type { DeckSignals, PersonalCliEnvironment, PersonalCommand, PersonalSnapshot, PersonalSubscriptionStatus, GoogleSnapshot } from '@shared/personal-agent'
import { IPC, type IpcChannel } from '@shared/ipc'

function subscribe<T>(channel: IpcChannel, handler: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  info: (): Promise<AppInfo> => ipcRenderer.invoke(IPC.appInfo),

  personal: {
    snapshot: (): Promise<PersonalSnapshot> => ipcRenderer.invoke(IPC.personalSnapshot),
    mutate: (change: PersonalCommand, revision: number): Promise<PersonalSnapshot> => ipcRenderer.invoke(IPC.personalMutate, change, revision),
    chat: (text: string): Promise<PersonalSnapshot> => ipcRenderer.invoke(IPC.personalChat, text),
    stop: (): Promise<PersonalSnapshot> => ipcRenderer.invoke(IPC.personalStop),
    approve: (id: string): Promise<PersonalSnapshot> => ipcRenderer.invoke(IPC.personalApprove, id),
    subscriptionStatus: (provider: 'chatgpt' | 'claude', environment: PersonalCliEnvironment): Promise<PersonalSubscriptionStatus> => ipcRenderer.invoke(IPC.personalSubscriptionStatus, provider, environment),
    onChanged: (handler: (snapshot: PersonalSnapshot) => void) => subscribe(IPC.personalChanged, handler),
    onOpen: (handler: () => void) => subscribe(IPC.personalOpen, handler),
    /** Status-only Deck signals (waiting agents, GitHub attention); never terminal content. */
    reportSignals: (signals: DeckSignals): Promise<void> => ipcRenderer.invoke(IPC.personalSignals, signals),
    google: {
      configure: (client: { clientId: string; clientSecret: string }): Promise<GoogleSnapshot> => ipcRenderer.invoke(IPC.personalGoogleConfigure, client),
      connect: (): Promise<GoogleSnapshot> => ipcRenderer.invoke(IPC.personalGoogleConnect),
      cancelConnect: (): Promise<GoogleSnapshot> => ipcRenderer.invoke(IPC.personalGoogleCancelConnect),
      disconnect: (): Promise<GoogleSnapshot> => ipcRenderer.invoke(IPC.personalGoogleDisconnect),
      sync: (): Promise<GoogleSnapshot> => ipcRenderer.invoke(IPC.personalGoogleSync)
    }
  },

  work: {
    snapshot: (): Promise<WorkResult> => ipcRenderer.invoke(IPC.workSnapshot),
    mutate: (change: WorkMutation): Promise<WorkResult> => ipcRenderer.invoke(IPC.workMutate, change),
    onChanged: (handler: (board: WorkBoard) => void) => subscribe(IPC.workChanged, handler),
    access: (): Promise<WorkAccess> => ipcRenderer.invoke(IPC.workAccess),
    setAccess: (enabled: boolean): Promise<WorkAccess> => ipcRenderer.invoke(IPC.workSetAccess, enabled)
  },

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

  /** The lists the opencode pane dialog picks from — models, agents, sessions. */
  mcp: {
    list: (target: McpTarget): Promise<McpInventory> => ipcRenderer.invoke(IPC.mcpList, target),
    mutate: (change: McpMutation): Promise<McpMutationResult> => ipcRenderer.invoke(IPC.mcpMutate, change)
  },

  opencode: {
    query: (profileId: string, cwd?: string): Promise<OpencodeInfo> =>
      ipcRenderer.invoke(IPC.opencodeQuery, profileId, cwd)
  },
  openRouter: {
    keyState: (): Promise<VoiceKeyState> => ipcRenderer.invoke(IPC.openRouterKeyState),
    setKey: (key: string | null): Promise<VoiceKeyState> => ipcRenderer.invoke(IPC.openRouterSetKey, key),
    models: (): Promise<OpenRouterModels> => ipcRenderer.invoke(IPC.openRouterModels)
  },

  github: {
    query: (cwd: string): Promise<GitHubSnapshot> => ipcRenderer.invoke(IPC.githubQuery, cwd)
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
    ensure: (spec: PaneSpec, cols: number, rows: number, workspaceId?: string): Promise<EnsureResult> =>
      ipcRenderer.invoke(IPC.ptyEnsure, spec, cols, rows, workspaceId),
    write: (id: string, data: string): void => ipcRenderer.send(IPC.ptyWrite, id, data),
    acknowledge: (id: string, flowId: number, offset: number): void =>
      ipcRenderer.send(IPC.ptyAcknowledge, id, flowId, offset),
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
    onAgentActivity: (handler: (event: AgentActivityEvent) => void): (() => void) =>
      subscribe(IPC.ptyAgentActivity, handler),
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
    write: (text: string): Promise<boolean> => ipcRenderer.invoke(IPC.clipboardWrite, text)
  },

  voice: {
    keyState: (provider: VoiceProvider, baseUrl?: string): Promise<VoiceKeyState> =>
      ipcRenderer.invoke(IPC.voiceKeyState, provider, baseUrl),
    /** Pass null to forget the stored key. */
    setKey: (provider: VoiceProvider, key: string | null, baseUrl?: string): Promise<VoiceKeyState> =>
      ipcRenderer.invoke(IPC.voiceSetKey, provider, key, baseUrl),
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
