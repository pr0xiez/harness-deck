import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  Notification,
  safeStorage,
  session,
  shell,
  systemPreferences
} from 'electron'
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  DiffRequest,
  PaneSpec,
  PersistedState,
  RemoteStatus,
  SavedProfile,
  SaveTextRequest,
  SaveTextResult,
  TranscribeRequest,
  UpdateChannel,
  VoiceProvider,
  WorktreeRequest
} from '@shared/types'
import { IPC, type IpcChannel } from '@shared/ipc'
import { addWorktree, diffRange, diffStat, info as repoInfo, removeWorktree } from './git'
import { queryGitHub } from './github'
import { PasteGate } from './paste-gate'
import { resolveWithin } from './paths'
import { decidePermission, originOf, type TrustedPage } from './permissions'
import { WorkBoardService } from './work-board'
import { WorkBoardAccess } from './work-board-access'
import { commandName } from '@shared/remote'
import { shellEnv } from './shell-env'
import { McpManager } from './mcp'
import type { McpMutation, McpTarget } from '@shared/mcp'
import { queryOpencode } from './opencode'
import { openRouterKeyState, setOpenRouterKey, openRouterModels, prepareOpenRouter, personalOpenRouterKey } from './openrouter'
import { PersonalAgent, type PersonalNotifyAction } from './personal-agent'
import { personalSubscriptionStatus } from './personal-subscription'
import { PersonalStore } from './personal-store'
import { PersonalSecrets } from './personal-secrets'
import { PersonalGoogle } from './personal-google'
import { detectForge, detectProfiles } from './profiles'
import { removeCustomProfile, saveCustomProfile } from './profiles-store'
import { DEFAULT_QUIET_MS, PtyManager, stripAnsi } from './pty'
import { ScrollbackStore } from './scrollback'
import { loadState, saveState, stateLocation } from './store'
import { AgentSessions } from './agent-sessions'
import { defaultShell, resolveShellEnv } from './shell-env'
import { keyState, setKey, transcribe } from './voice'
import { checkNow, currentState, disposeUpdater, initUpdater, install, setChannel } from './updater'
import {
  formatReport,
  runSmoke,
  seedSmokeState,
  SMOKE_USER_DATA,
  watchRendererErrors
} from './smoke'

app.setName('Harness Deck')

const isMac = process.platform === 'darwin'
const DEV_APP_ID = 'dev.harnessdeck.app.development'
// Keep local runs out of the installed app's taskbar group (and Electron's).
if (process.platform === 'win32' && !app.isPackaged) app.setAppUserModelId(DEV_APP_ID)

let mainWindow: BrowserWindow | null = null
let ptys: PtyManager | null = null
let workAccess: WorkBoardAccess | undefined
let personalAgent: PersonalAgent | undefined
/** Records the paste chord off real keyboard input; gates `clipboard:read`. */
const pasteGate = new PasteGate()
/** Set when we are quitting to hand over to an installer — skip the pane prompt. */
let quittingForUpdate = false
/**
 * How long a pane may be silent before it counts as waiting. The renderer owns
 * settings, so the value is whatever it last handed over — kept here because
 * the timer runs beside the pty, and re-reading the state file per burst of
 * output would be absurd.
 */
let quietMs = DEFAULT_QUIET_MS

function rememberAttention(state: PersistedState | null): void {
  const value = state?.settings?.attention?.quietMs
  if (typeof value === 'number' && value > 0) quietMs = value
}

/**
 * Panes that went away while the app was not running left their tails behind.
 * A state file we could not read is not evidence that every pane is gone, so
 * that case prunes nothing rather than everything.
 */
function pruneScrollback(store: ScrollbackStore): void {
  const state = loadState()
  if (!state) return
  store.prune(state.workspaces.flatMap((w) => w.panes).map((p) => p.id))
}

/**
 * Smoke-test hooks:
 *   --capture=<file>            render the window to a PNG
 *   --capture-delay=<ms>        wait before capturing (default 2500)
 *   --capture-keys=ctrl+shift+p press these chords first (comma separated)
 *   --capture-quit              exit once the PNG is written
 *   --dump-profiles             print detected harnesses as JSON and exit
 *   --smoke                     boot, assert the app works, print JSON, exit 0/1
 *   --smoke-json=<file>         also write that report to a file
 *   --voice-check[=ms]          record from the mic, transcribe, print JSON, exit
 *   --voice-endpoint=<url>      transcribe against this endpoint for the check
 *   --voice-model=<name>        model to ask that endpoint for
 */
const smoke = process.argv.includes('--smoke')
const smokeJson = argValue('--smoke-json')
const captureTarget = argValue('--capture')
const captureDelay = Number(argValue('--capture-delay') ?? 2500)
const captureKeys = argValue('--capture-keys')
const captureKeysDelay = Number(argValue('--capture-keys-delay') ?? 800)
const captureQuit = process.argv.includes('--capture-quit')
const voiceCheck = process.argv.includes('--voice-check') || argValue('--voice-check') !== undefined
const voiceCheckMs = Number(argValue('--voice-check') || 2500)
const voiceOverride = {
  baseUrl: argValue('--voice-endpoint'),
  model: argValue('--voice-model')
}

function argValue(flag: string): string | undefined {
  const match = process.argv.find((a) => a.startsWith(`${flag}=`))
  return match?.slice(flag.length + 1)
}

// A smoke run gets its own state directory, so it can neither read nor damage a
// real session's layout — and its single-instance lock is separate too, which
// means it can run while the app is open. Wiped on the way in: the directory
// outlives interrupted runs, and a stale state file makes later runs assert
// against a session nobody seeded. Only the throwaway default is wiped — a run
// pointed at a directory by hand gets to keep what is in it.
if (smoke && !process.argv.some((a) => a.startsWith('--user-data-dir'))) {
  rmSync(SMOKE_USER_DATA, { recursive: true, force: true })
  app.setPath('userData', SMOKE_USER_DATA)
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Presses each chord in turn, pausing between them so the UI can react. */
async function sendChords(win: BrowserWindow, chords: string, gap: number): Promise<void> {
  const list = chords.split(',')
  for (const [index, chord] of list.entries()) {
    if (index) await wait(gap)
    const parts = chord.split('+').map((part) => part.trim())
    const key = parts.pop()
    if (!key) continue
    const modifiers = parts.map((part) => {
      const name = part.toLowerCase()
      if (name === 'ctrl') return 'control'
      if (name === 'cmd' || name === 'command') return 'meta'
      return name
    })
    const keyCode = key.length === 1 ? key.toUpperCase() : key
    for (const type of ['keyDown', 'keyUp'] as const) {
      win.webContents.sendInputEvent({ type, keyCode, modifiers } as Electron.KeyboardInputEvent)
    }
  }
}

/**
 * Everywhere but macOS the titlebar is entirely ours and there is no menu. On
 * macOS the menu bar *is* the shortcut table: without it there is no Cmd+Q, no
 * Cmd+W, and no clipboard in any text field. Copy is the one exception — it is
 * listed for discoverability but its accelerator is left unregistered, because
 * a terminal's selection lives inside xterm and never reaches the DOM, so the
 * renderer has to service Cmd+C itself (see App.tsx).
 */
function installMenu(): void {
  if (!isMac) {
    Menu.setApplicationMenu(null)
    return
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy', accelerator: 'Cmd+C', registerAccelerator: false },
          { role: 'paste' },
          { role: 'selectAll' }
        ]
      },
      { label: 'View', submenu: [{ role: 'togglefullscreen' }, { role: 'toggleDevTools' }] },
      { role: 'windowMenu' }
    ])
  )
}

/**
 * How many panes are waiting, shown where the platform puts it: a dock badge on
 * macOS and Linux, and a flashing taskbar button on Windows, which has no badge
 * of its own without an overlay icon to draw the number onto.
 */
function setBadge(count: number): void {
  const value = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0
  if (process.platform === 'win32') {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) {
      mainWindow.flashFrame(value > 0)
    }
    return
  }
  app.setBadgeCount(value)
}

/** Where a save dialog opens. Downloads is not guaranteed to resolve on Linux. */
function saveDir(): string {
  try {
    return app.getPath('downloads')
  } catch {
    return homedir()
  }
}

function send(channel: IpcChannel, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

/** Nothing is running, or the user has switched the warning off. */
function skipStopPrompt(): boolean {
  if (!ptys?.runningIds().length) return true
  return loadState()?.settings?.confirmCloseRunning === false
}

/** The "N panes are still running" prompt. True when the user said go ahead. */
function askStopRunning(win: BrowserWindow | null): boolean {
  const running = ptys?.runningIds().length ?? 0
  const options: Electron.MessageBoxSyncOptions = {
    type: 'question',
    buttons: ['Quit anyway', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Quit Harness Deck',
    message: `${running} pane${running === 1 ? ' is' : 's are'} still running.`,
    detail: 'Their processes will be terminated.',
    noLink: true
  }
  const response =
    win && !win.isDestroyed()
      ? dialog.showMessageBoxSync(win, options)
      : dialog.showMessageBoxSync(options)
  return response === 0
}

/**
 * A packaged app takes its icon from the bundle — electron-builder picks up
 * build/icon.icns, .ico and .png. Local runs use the blue DEV artwork instead.
 * Pass the ICO path on Windows so it can select the right size for the taskbar.
 * build/ is deliberately outside `files`, hence the isPackaged guard.
 */
function devIcon(): string | undefined {
  if (app.isPackaged) return undefined
  const file = join(app.getAppPath(), 'build', process.platform === 'win32' ? 'icon-dev.ico' : 'icon-dev.png')
  return existsSync(file) ? file : undefined
}

function createWindow(): BrowserWindow {
  // macOS takes its dock icon from the app, not the window; the others read it
  // off the window, so it goes in the constructor there.
  const icon = devIcon()
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 860,
    minHeight: 560,
    show: false,
    ...(icon && !isMac ? { icon } : {}),
    // A frameless window on macOS has no traffic lights at all, so there we
    // only hide the titlebar and place the lights inside our own 34px bar.
    ...(isMac
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 13, y: 11 } }
      : { frame: false }),
    backgroundColor: '#0b0e13',
    title: 'Harness Deck',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      spellcheck: false
    }
  })

  if (process.platform === 'win32' && icon) {
    win.setAppDetails({ appId: DEV_APP_ID, appIconPath: icon })
  }

  win.on('ready-to-show', () => win.show())
  win.webContents.on('render-process-gone', () => ptys?.detachAll())
  win.on('closed', () => {
    ptys?.detachAll()
    if (mainWindow === win) mainWindow = null
  })

  // Closing the window kills every agent, so check first — except on macOS,
  // where the sessions outlive the window and the warning moves to quit.
  let closeConfirmed = false
  win.on('close', (event) => {
    if (closeConfirmed || captureTarget || voiceCheck || smoke || quittingForUpdate || isMac) return
    if (skipStopPrompt()) return
    event.preventDefault()
    if (askStopRunning(win)) {
      closeConfirmed = true
      win.close()
    }
  })
  win.on('maximize', () => send(IPC.windowMaximized, true))
  win.on('unmaximize', () => send(IPC.windowMaximized, false))
  win.on('enter-full-screen', () => send(IPC.windowFullscreen, true))
  win.on('leave-full-screen', () => send(IPC.windowFullscreen, false))
  win.on('focus', () => send(IPC.windowFocus, true))
  win.on('blur', () => send(IPC.windowFocus, false))

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  // The preload re-runs on every document load, so navigating anywhere but our
  // own content would hand window.harness to whatever loaded — a file dropped
  // on the window is enough to trigger it. Only the app's own URL may load;
  // everything else is blocked. The renderer also cancels drag-and-drop at the
  // document (see main.tsx), but this guard is the one that cannot be bypassed.
  // A packaged build never follows the dev-server variable (#51), so the guard
  // and the load below read the same gated value.
  const devUrl = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL']
  const appUrl = pathToFileURL(join(__dirname, '../renderer/index.html')).href
  const isAllowedNavigation = (url: string): boolean =>
    devUrl ? new URL(url).origin === new URL(devUrl).origin : url === appUrl
  win.webContents.on('did-start-navigation', (event) => {
    // Blocked navigation and fragment changes leave the current terminal alive.
    if (event.isMainFrame && !event.isSameDocument && isAllowedNavigation(event.url)) {
      ptys?.detachAll()
    }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url)) event.preventDefault()
  })
  // will-navigate only covers the main frame; this catches subframes too.
  win.webContents.on('will-frame-navigate', (event) => {
    if (!isAllowedNavigation(event.url)) event.preventDefault()
  })

  // The renderer's paste path (Ctrl/Cmd+Shift+V, see shortcuts.ts) asks the
  // main process for the clipboard over IPC. The chord is recorded here, off
  // keyboard input the renderer cannot forge, and `clipboard:read` only
  // answers within a moment of it — see registerIpc and paste-gate.ts.
  win.webContents.on('before-input-event', (_event, input) => pasteGate.observe(input))

  // DevTools without an application menu. macOS has one (see installMenu), and
  // its View item owns Cmd+Alt+I — handling it here too would toggle twice.
  win.webContents.on('before-input-event', (_event, input) => {
    if (isMac) return
    const devtools =
      input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')
    if (input.type === 'keyDown' && devtools) win.webContents.toggleDevTools()
  })

  if (devUrl) {
    win.loadURL(devUrl)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Boots the app, checks it actually works, and sets the exit code. The error
  // watcher is attached before the page loads so a failure during startup is
  // caught rather than missed.
  if (smoke) {
    const rendererErrors = watchRendererErrors(win)
    // A page that never loads would otherwise hang a CI job until it is killed
    // with no output at all.
    const watchdog = setTimeout(() => {
      console.error('[smoke] timed out after 180s')
      console.error(rendererErrors.join('\n') || '(the renderer reported nothing)')
      app.exit(1)
    }, 180_000)
    watchdog.unref()

    win.webContents.once('did-finish-load', () => {
      void (async () => {
        let code = 1
        try {
          const report = await runSmoke(win, rendererErrors)
          console.log(JSON.stringify(report, null, 2))
          console.log(formatReport(report))
          if (smokeJson) {
            const target = resolve(smokeJson)
            mkdirSync(dirname(target), { recursive: true })
            writeFileSync(target, JSON.stringify(report, null, 2))
          }
          code = report.ok ? 0 : 1
        } catch (err) {
          console.error('[smoke] the run itself failed:', err)
        }
        ptys?.disposeAll()
        // exit, not quit — quit would let a handler swallow the status.
        app.exit(code)
      })()
    })
  }

  if (captureTarget) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          if (captureKeys) {
            await sendChords(win, captureKeys, captureKeysDelay)
            await wait(captureKeysDelay)
          }
          const image = await win.webContents.capturePage()
          const target = resolve(captureTarget)
          mkdirSync(dirname(target), { recursive: true })
          writeFileSync(target, image.toPNG())
          console.log(`[capture] wrote ${target}`)
        } catch (err) {
          console.error('[capture] failed:', err)
        }
        if (captureQuit) app.quit()
      }, captureDelay)
    })
  }

  // Mic capture can only be exercised from the renderer, so ask it to run the
  // round trip and print what came back.
  if (voiceCheck) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const result = await win.webContents.executeJavaScript(
            `window.__deckVoiceCheck(${Number.isFinite(voiceCheckMs) ? voiceCheckMs : 2500}, ${JSON.stringify(voiceOverride)})`,
            true
          )
          console.log(JSON.stringify(result, null, 2))
        } catch (err) {
          console.error('[voice-check] failed:', err)
        }
        app.quit()
      }, 2000)
    })
  }

  return win
}

/**
 * Electron hands out every permission by default, and grants from these
 * handlers show no Chromium consent prompt. The policy itself lives in
 * permissions.ts: an allow-listed permission, asked for by the app's own page
 * — the bundled index.html, or the dev server when one is loaded (mirroring
 * createWindow). Anything else in the session is denied, so a page that
 * arrives through navigation or a dropped file gets nothing.
 */
function restrictPermissions(): void {
  const trust: TrustedPage = {
    bundledPage: pathToFileURL(join(__dirname, '../renderer/index.html')).href,
    devOrigin: originOf(process.env['ELECTRON_RENDERER_URL'])
  }
  const decide = (
    contents: Electron.WebContents | null,
    permission: string,
    requestingUrl: string | undefined
  ): boolean => {
    // The frame's own URL when Electron provides it; the top-level URL is
    // close enough for the fallback, since the app never embeds frames.
    const pageUrl = requestingUrl || contents?.getURL()
    const ok = decidePermission(permission, pageUrl, trust)
    if (!ok) console.warn(`[permissions] denied ${permission} for ${pageUrl || 'unknown page'}`)
    return ok
  }
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) =>
    callback(decide(contents, permission, details.requestingUrl))
  )
  session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) =>
    decide(contents, permission, details.requestingUrl)
  )
}

/**
 * Deck Remote is stubs until HD-21 builds the server. Off is the whole truth:
 * no socket exists — the README's nothing-reaches-the-network promise extends
 * to listening.
 */
const REMOTE_OFF: RemoteStatus = {
  enabled: false,
  url: null,
  lan: false,
  allowTyping: false,
  clients: 0
}

async function registerIpc(): Promise<void> {
  const work = new WorkBoardService(app.getPath('userData'), board => send(IPC.workChanged, board))
  workAccess = new WorkBoardAccess(app.getPath('userData'), work, process.execPath, app.isPackaged ? join(process.resourcesPath, 'hd-work.cjs') : join(app.getAppPath(), 'scripts/hd-work.cjs'))
  if (!smoke) await workAccess.restore()
  ipcMain.handle(IPC.workSnapshot, () => work.snapshot())
  ipcMain.handle(IPC.workMutate, (_e, change: unknown) => work.mutate(change))
  ipcMain.handle(IPC.workAccess, () => workAccess!.status())
  ipcMain.handle(IPC.workSetAccess, (_e, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw Error('Expected an access toggle')
    return workAccess!.setEnabled(enabled)
  })
  const personalStore = new PersonalStore(app.getPath('userData'), () => personalAgent?.publish())
  // Live notifications stay referenced so their click/action handlers aren't garbage-collected; bounded because 'close' isn't guaranteed.
  const personalNotifications = new Set<Notification>()
  const personalNotify = (title: string, body: string, actions: PersonalNotifyAction[] = []): void => {
    if (!Notification.isSupported()) return
    const buttons = actions.slice(0, 2)
    // Notification buttons exist on Windows and macOS only.
    const notification = new Notification({ title, body, ...(buttons.length && process.platform !== 'linux' ? { actions: buttons.map(a => ({ type: 'button' as const, text: a.label })) } : {}) })
    const release = (): void => { personalNotifications.delete(notification) }
    personalNotifications.add(notification)
    for (const stale of personalNotifications) { if (personalNotifications.size <= 20) break; personalNotifications.delete(stale) }
    notification.on('click', () => {
      release()
      if (!mainWindow) { mainWindow = createWindow(); mainWindow.webContents.once('did-finish-load', () => send(IPC.personalOpen, null)) }
      else { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); send(IPC.personalOpen, null) }
    })
    notification.on('action', details => {
      release()
      try { buttons[details.actionIndex]?.run() } catch { /* The agent reports action failures on its page. */ }
    })
    notification.on('close', release)
    notification.on('failed', release)
    notification.show()
  }
  const google = new PersonalGoogle(new PersonalSecrets(app.getPath('userData'), {
    available: () => safeStorage.isEncryptionAvailable() && !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text'),
    encrypt: text => safeStorage.encryptString(text), decrypt: data => safeStorage.decryptString(data)
  }), url => shell.openExternal(url), () => personalAgent?.publish(), fetch,
  account => personalNotify('Google sign-in expired', `Reconnect Gmail & Calendar for ${account} in the personal agent's settings.`))
  personalAgent = new PersonalAgent({ store: personalStore, google, work, key: personalOpenRouterKey,
    changed: snapshot => send(IPC.personalChanged, snapshot), notify: personalNotify
  })
  const personalHandle = (channel: IpcChannel, handler: (...args: unknown[]) => unknown): void => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) throw Error('Personal agent is available only to the Deck window.')
      return handler(...args)
    })
  }
  personalHandle(IPC.personalSnapshot, () => personalAgent!.snapshot())
  personalHandle(IPC.personalMutate, (change, revision) => personalAgent!.mutate(change, revision))
  personalHandle(IPC.personalChat, text => personalAgent!.chat(text))
  personalHandle(IPC.personalStop, () => personalAgent!.stop())
  personalHandle(IPC.personalApprove, id => personalAgent!.approve(id))
  personalHandle(IPC.personalSignals, signals => personalAgent!.reportSignals(signals))
  personalHandle(IPC.personalSubscriptionStatus, (provider, environment) => personalSubscriptionStatus(provider, environment))
  personalHandle(IPC.personalGoogleConfigure, client => google.configure(client))
  personalHandle(IPC.personalGoogleConnect, () => google.connect())
  personalHandle(IPC.personalGoogleCancelConnect, () => google.cancelConnect())
  personalHandle(IPC.personalGoogleDisconnect, () => google.disconnect())
  personalHandle(IPC.personalGoogleSync, () => google.sync())
  if (!smoke && !captureTarget && !voiceCheck) personalAgent.start()
  ipcMain.handle(IPC.appInfo, () => ({
    platform: process.platform,
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      app: app.getVersion()
    },
    homeDir: homedir(),
    defaultShell: defaultShell(),
    defaultCwd: process.env.HD_DEFAULT_CWD || homedir()
  }))

  ipcMain.handle(IPC.stateLoad, () => {
    const state = loadState()
    rememberAttention(state)
    return state
  })
  // handle/invoke rather than on/send, so a write that failed makes it back to
  // the renderer instead of dying as a console line here. See issue #26.
  ipcMain.handle(IPC.stateSave, (_e, state: PersistedState) => {
    rememberAttention(state)
    return saveState(state)
  })
  ipcMain.handle(IPC.stateLocation, () => stateLocation())

  ipcMain.handle(IPC.profilesList, () => detectProfiles())
  // Both hand back the whole merged list: the renderer keeps one array of
  // profiles, so a save that returned only the saved ones would leave it to
  // re-merge what detectProfiles() has already done.
  ipcMain.handle(IPC.profilesSaveCustom, (_e, profile: SavedProfile) => {
    saveCustomProfile(profile)
    return detectProfiles()
  })
  ipcMain.handle(IPC.profilesRemoveCustom, (_e, id: string) => {
    removeCustomProfile(id)
    return detectProfiles()
  })

  const mcps = new McpManager(smoke ? { home: join(app.getPath('userData'), 'mcp-home'), env: () => ({}) } : {})
  ipcMain.handle(IPC.mcpList, (_e, target: McpTarget) =>
    mcps.list(smoke ? { ...target, cwd: undefined } : target)
  )
  ipcMain.handle(IPC.mcpMutate, (_e, change: McpMutation) => mcps.mutate(change))

  ipcMain.handle(IPC.opencodeQuery, (_e, profileId: string, cwd?: string) =>
    queryOpencode(profileId, cwd)
  )
  ipcMain.handle(IPC.openRouterKeyState, () => openRouterKeyState())
  ipcMain.handle(IPC.openRouterSetKey, (_e, key: string | null) => setOpenRouterKey(key))
  ipcMain.handle(IPC.openRouterModels, () => openRouterModels())

  ipcMain.handle(IPC.githubQuery, (_e, cwd: unknown) => queryGitHub(cwd))

  ipcMain.handle(IPC.gitInfo, (_e, dir: string) => repoInfo(dir))
  ipcMain.handle(IPC.gitAddWorktree, (_e, req: WorktreeRequest) => addWorktree(req))
  ipcMain.handle(IPC.gitRemoveWorktree, (_e, path: string) => removeWorktree(path))
  ipcMain.handle(IPC.gitDiffStat, (_e, dir: string) => diffStat(dir))
  ipcMain.handle(IPC.gitDiffRange, (_e, req: DiffRequest) => diffRange(req))
  ipcMain.handle(IPC.gitForge, () => detectForge())
  // Stubs the later items replace — registered now so four parallel branches
  // build on a settled surface instead of each adding its own. See HD-14.
  ipcMain.handle(IPC.gitCheckpoint, () => undefined)
  ipcMain.handle(IPC.gitCheckpoints, () => [])
  ipcMain.handle(IPC.gitRestoreCheckpoint, () => ({ ok: false, error: 'not implemented' }))
  ipcMain.handle(IPC.gitDropCheckpoints, () => undefined)
  ipcMain.handle(IPC.gitDeleteBranch, () => ({ ok: false, error: 'not implemented' }))

  ipcMain.handle(IPC.updateState, () => currentState())
  ipcMain.handle(IPC.updateCheck, () => checkNow())
  ipcMain.handle(IPC.updateSetChannel, (_e, channel: UpdateChannel) => setChannel(channel))
  ipcMain.handle(IPC.updateInstall, () => install())

  ipcMain.handle(IPC.ptyEnsure, (_e, spec: PaneSpec, cols: number, rows: number, workspaceId?: string) => {
    const name = commandName(spec.command)
    const env = { ...spec.env }
    // Runtime connection details are never written into persisted Pane.env.
    for (const key of ['HD_WORK_BIN', 'HD_WORK_DISCOVERY', 'HD_WORK_WORKSPACE']) env[key] = ''
    if (workAccess && !['ssh', 'docker'].includes(name)) {
      env.HD_WORK_BIN = workAccess.bin
      env.HD_WORK_DISCOVERY = workAccess.discovery
      if (typeof workspaceId === 'string') env.HD_WORK_WORKSPACE = workspaceId
      if (name === 'wsl') {
        env.WSLENV = `${env.WSLENV || shellEnv().WSLENV || ''}:HD_WORK_BIN/p:HD_WORK_DISCOVERY/p:HD_WORK_WORKSPACE`
      } else {
        env.PATH = `${workAccess.bin}${process.platform === 'win32' ? ';' : ':'}${env.PATH || env.Path || shellEnv().PATH || ''}`
        if (process.platform === 'win32') env.Path = env.PATH
      }
    }
    return ptys!.ensure({ ...spec, env }, cols, rows)
  })
  ipcMain.on(IPC.ptyWrite, (_e, id: string, data: string) => ptys!.write(id, data))
  ipcMain.on(IPC.ptyAcknowledge, (event, id: string, flowId: number, offset: number) => {
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) return
    ptys!.acknowledge(id, flowId, offset)
  })
  ipcMain.on(IPC.ptyResize, (_e, id: string, cols: number, rows: number) =>
    ptys!.resize(id, cols, rows)
  )
  ipcMain.on(IPC.ptyKill, (_e, id: string) => ptys!.kill(id))
  ipcMain.on(IPC.ptyDispose, (_e, id: string) => ptys!.dispose(id))
  ipcMain.handle(IPC.ptyStatus, (_e, id: string) => ptys!.status(id))
  ipcMain.handle(IPC.ptyRunning, () => ptys!.runningIds())
  ipcMain.handle(IPC.ptyTranscript, (_e, id: string, strip?: boolean) => {
    const text = ptys!.transcript(id)
    return strip ? stripAnsi(text) : text
  })
  ipcMain.handle(IPC.ptyTail, (_e, id: string, lines: number) => ptys!.tail(id, lines))

  ipcMain.handle(IPC.remoteStatus, () => REMOTE_OFF)
  ipcMain.handle(IPC.remoteSetEnabled, () => REMOTE_OFF)
  ipcMain.handle(IPC.remoteSetLan, () => REMOTE_OFF)
  ipcMain.handle(IPC.remoteSetAllowTyping, () => REMOTE_OFF)

  ipcMain.handle(IPC.fsMissingDirs, (_e, paths: string[]) =>
    (paths ?? []).filter((path) => {
      try {
        return !path || !statSync(path).isDirectory()
      } catch {
        // Unreadable is as good as gone for anything about to spawn there.
        return true
      }
    })
  )

  ipcMain.handle(IPC.dialogPickDirectory, async (_e, current?: string) => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a working directory',
      defaultPath: current || homedir(),
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle(IPC.dialogConfirm, async (_e, options: { title: string; message: string; detail?: string; confirmLabel?: string }) => {
    if (!mainWindow) return false
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: [options.confirmLabel || 'Confirm', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: options.title,
      message: options.message,
      detail: options.detail,
      noLink: true
    })
    return response === 0
  })

  ipcMain.handle(IPC.dialogSaveText, async (_e, req: SaveTextRequest): Promise<SaveTextResult> => {
    if (!mainWindow) return { ok: false, error: 'No window to hang the dialog off.' }
    try {
      const safeName = basename(req.defaultName ?? '')
      const fileName = safeName && safeName !== '.' && safeName !== '..' ? safeName : 'transcript.txt'
      const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
        title: 'Save transcript',
        defaultPath: join(saveDir(), fileName),
        filters: [
          { name: 'Text', extensions: ['txt'] },
          { name: 'All files', extensions: ['*'] }
        ]
      })
      if (canceled || !filePath) return { ok: false, canceled: true }
      // An empty string is a legitimate transcript — a pane that never ran.
      writeFileSync(filePath, req.text ?? '', 'utf8')
      return { ok: true, path: filePath }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IPC.voiceKeyState, (_e, provider: VoiceProvider, baseUrl?: string) =>
    keyState(provider, baseUrl)
  )
  ipcMain.handle(IPC.voiceSetKey, (_e, provider: VoiceProvider, key: string | null, baseUrl?: string) =>
    setKey(provider, key, baseUrl)
  )
  ipcMain.handle(IPC.voiceTranscribe, (_e, req: TranscribeRequest) => transcribe(req))
  ipcMain.handle(IPC.voiceMicAccess, async () => {
    if (process.platform !== 'darwin') return true
    if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') return true
    return systemPreferences.askForMediaAccess('microphone')
  })

  // Only within a moment of a real paste chord (see createWindow). The
  // permission handler already refuses the web clipboard-read permission; a
  // channel that answered unconditionally was a side door around it. An
  // unprompted caller gets an empty string, not what the user last copied.
  ipcMain.handle(IPC.clipboardRead, () => (pasteGate.allows() ? clipboard.readText() : ''))
  ipcMain.handle(IPC.clipboardWrite, async (_e, text: string) => {
    try {
      await clipboard.writeText(text)
      return true
    } catch (err) {
      console.error('clipboard write failed', err)
      return false
    }
  })

  ipcMain.on(IPC.windowMinimize, () => mainWindow?.minimize())
  ipcMain.on(IPC.windowToggleMaximize, () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.on(IPC.windowClose, () => mainWindow?.close())
  ipcMain.handle(IPC.windowIsMaximized, () => mainWindow?.isMaximized() ?? false)

  // `ms-settings:` is allowed so the app can send the user to the Windows
  // microphone privacy page when capture is blocked there.
  ipcMain.on(IPC.appOpenExternal, (_e, url: string) => {
    if (/^(https?|ms-settings):/.test(url)) shell.openExternal(url)
  })
  ipcMain.on(IPC.appOpenPath, (_e, path: string) => shell.openPath(path))
  ipcMain.on(IPC.appSetBadge, (_e, count: number) => setBadge(count))

  // The channel exists solely for the --capture dev flow (see the flag table
  // above), so in a normal run it is never registered and a renderer that
  // calls it gets a rejection, not a file. Even in a capture run the renderer
  // only names a file inside the directory the CLI flag already chose — its
  // string used to be resolved and written verbatim, which let any code in
  // the renderer overwrite whatever the OS user could (issue #29).
  if (captureTarget) {
    const captureDir = dirname(resolve(captureTarget))
    ipcMain.handle(IPC.appCapture, async (_e, target: string) => {
      if (!mainWindow) return null
      const file = resolveWithin(captureDir, target)
      if (!file) {
        console.warn(`[capture] refused a path outside ${captureDir}: ${target}`)
        return null
      }
      const image = await mainWindow.webContents.capturePage()
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, image.toPNG())
      return file
    })
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(async () => {
    installMenu()
    await resolveShellEnv()

    // `--dump-profiles` prints what the app can find and exits — useful when a
    // harness is installed but not showing up.
    if (process.argv.includes('--dump-profiles')) {
      const profiles = await detectProfiles()
      console.log(JSON.stringify(profiles, null, 2))
      app.quit()
      return
    }

    restrictPermissions()
    if (isMac) {
      const icon = devIcon()
      if (icon) app.dock?.setIcon(icon)
    }
    // Built here rather than at module scope: `userData` is not final until the
    // --user-data-dir switch and the smoke override above have been applied.
    const scrollback = new ScrollbackStore(app.getPath('userData'))
    pruneScrollback(scrollback)
    ptys = new PtyManager(send, undefined, () => quietMs, scrollback, new AgentSessions(app.getPath('userData')), prepareOpenRouter)
    await registerIpc()
    // Before the window, so the renderer hydrates a state file it did not write.
    if (smoke) seedSmokeState()
    mainWindow = createWindow()

    initUpdater({
      publish: (state) => send(IPC.updateChanged, state),
      beforeInstallQuit: () => {
        quittingForUpdate = true
      }
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
    })
  })

  app.on('window-all-closed', () => {
    // Closing the window is routine on macOS and the app stays in the dock, so
    // the agents keep running: `activate` rebuilds the window and every pane
    // re-attaches to its session from the replay buffer. Killing them here
    // would make Cmd+W a silent "quit every agent".
    if (isMac) return
    ptys?.disposeAll()
    app.quit()
  })

  // On macOS this is the only moment that actually stops the agents, so it is
  // where the warning lives — the window can be closed and reopened freely.
  // Handing over to an installer is not the moment to ask.
  let quitConfirmed = false
  app.on('before-quit', (event) => {
    const ask =
      isMac && !quitConfirmed && !captureTarget && !voiceCheck && !smoke && !quittingForUpdate
    if (ask && !skipStopPrompt() && !askStopRunning(mainWindow)) {
      event.preventDefault()
      return
    }
    quitConfirmed = true
    void workAccess?.stop()
    personalAgent?.dispose()
    disposeUpdater()
    ptys?.disposeAll()
  })
}
