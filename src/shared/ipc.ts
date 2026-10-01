/**
 * Every IPC channel name, once. The main process registers handlers with these
 * and the preload invokes with them, so a rename is a one-line change that both
 * sides see — a channel string that exists on only one side can no longer
 * compile. The values are the wire format and must not change casually: a
 * running renderer from an older build may still be sending them.
 *
 * Grouped by domain prefix; the `main → renderer` entries are event channels
 * pushed over `webContents.send` rather than handled invokes.
 */
export const IPC = {
  // app
  appInfo: 'app:info',
  appOpenExternal: 'app:openExternal',
  appOpenPath: 'app:openPath',
  appSetBadge: 'app:setBadge',
  appCapture: 'app:capture',

  workSnapshot: 'work:snapshot',
  workMutate: 'work:mutate',
  workChanged: 'work:changed',
  workAccess: 'work:access',
  workSetAccess: 'work:setAccess',

  personalSnapshot: 'personal:snapshot',
  personalMutate: 'personal:mutate',
  personalChat: 'personal:chat',
  personalStop: 'personal:stop',
  personalApprove: 'personal:approve',
  personalChanged: 'personal:changed',
  personalOpen: 'personal:open',
  personalGoogleConfigure: 'personal:googleConfigure',
  personalGoogleConnect: 'personal:googleConnect',
  personalGoogleCancelConnect: 'personal:googleCancelConnect',
  personalGoogleDisconnect: 'personal:googleDisconnect',
  personalGoogleSync: 'personal:googleSync',

  // persisted state
  stateLoad: 'state:load',
  stateSave: 'state:save',
  stateLocation: 'state:location',

  // harness profiles
  profilesList: 'profiles:list',
  profilesSaveCustom: 'profiles:saveCustom',
  profilesRemoveCustom: 'profiles:removeCustom',

  // MCP configuration management
  mcpList: 'mcp:list',
  mcpMutate: 'mcp:mutate',

  // opencode — the lists the pane dialog picks from
  opencodeQuery: 'opencode:query',
  openRouterKeyState: 'openrouter:keyState',
  openRouterSetKey: 'openrouter:setKey',
  openRouterModels: 'openrouter:models',

  githubQuery: 'github:query',

  // git
  gitInfo: 'git:info',
  gitAddWorktree: 'git:addWorktree',
  gitRemoveWorktree: 'git:removeWorktree',
  gitDiffStat: 'git:diffStat',
  gitDiffRange: 'git:diffRange',
  gitForge: 'git:forge',
  gitCheckpoint: 'git:checkpoint',
  gitCheckpoints: 'git:checkpoints',
  gitRestoreCheckpoint: 'git:restoreCheckpoint',
  gitDropCheckpoints: 'git:dropCheckpoints',
  gitDeleteBranch: 'git:deleteBranch',

  // updater
  updateState: 'update:state',
  updateCheck: 'update:check',
  updateSetChannel: 'update:setChannel',
  updateInstall: 'update:install',
  /** main → renderer: the updater's state changed behind the UI's back. */
  updateChanged: 'update:changed',

  // pty sessions
  ptyEnsure: 'pty:ensure',
  ptyWrite: 'pty:write',
  ptyAcknowledge: 'pty:acknowledge',
  ptyResize: 'pty:resize',
  ptyKill: 'pty:kill',
  ptyDispose: 'pty:dispose',
  ptyStatus: 'pty:status',
  ptyRunning: 'pty:running',
  ptyTranscript: 'pty:transcript',
  ptyTail: 'pty:tail',
  /** main → renderer: a burst of terminal output. */
  ptyData: 'pty:data',
  /** main → renderer: the pane's process ended. */
  ptyExit: 'pty:exit',
  /** main → renderer: the pane went quiet, or spoke again. */
  ptyAgentActivity: 'pty:agentActivity',
  ptyQuiet: 'pty:quiet',

  // Deck Remote — `remoteStatus` doubles as the main → renderer event channel.
  remoteStatus: 'remote:status',
  remoteSetEnabled: 'remote:setEnabled',
  remoteSetLan: 'remote:setLan',
  remoteSetAllowTyping: 'remote:setAllowTyping',

  // filesystem
  fsMissingDirs: 'fs:missingDirs',

  // native dialogs
  dialogPickDirectory: 'dialog:pickDirectory',
  dialogConfirm: 'dialog:confirm',
  dialogSaveText: 'dialog:saveText',

  // voice
  voiceKeyState: 'voice:keyState',
  voiceSetKey: 'voice:setKey',
  voiceTranscribe: 'voice:transcribe',
  voiceMicAccess: 'voice:micAccess',

  // clipboard
  clipboardRead: 'clipboard:read',
  clipboardWrite: 'clipboard:write',

  // window chrome
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggleMaximize',
  windowClose: 'window:close',
  windowIsMaximized: 'window:isMaximized',
  /** main → renderer: the window was maximized or restored. */
  windowMaximized: 'window:maximized',
  /** main → renderer: the window entered or left fullscreen. */
  windowFullscreen: 'window:fullscreen',
  /** main → renderer: the window gained or lost focus. */
  windowFocus: 'window:focus'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
