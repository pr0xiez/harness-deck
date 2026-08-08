import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  session,
  shell,
  systemPreferences
} from 'electron'
import type { NativeImage } from 'electron'
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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
import { addWorktree, diffRange, diffStat, info as repoInfo, removeWorktree } from './git'
import { navigationAllowed } from './nav-guard'
import { detectForge, detectProfiles } from './profiles'
import { removeCustomProfile, saveCustomProfile } from './profiles-store'
import { DEFAULT_QUIET_MS, PtyManager, stripAnsi } from './pty'
import { ScrollbackStore } from './scrollback'
import { loadState, saveState, stateLocation } from './store'
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

let mainWindow: BrowserWindow | null = null
let ptys: PtyManager | null = null
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

function send(channel: string, payload: unknown): void {
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
 * build/icon.icns, .ico and .png — but a dev run shows Electron's own default.
 * Point that at the same artwork so the dock is right while working on the app.
 * build/ is deliberately outside `files`, hence the isPackaged guard.
 */
function devIcon(): NativeImage | undefined {
  if (app.isPackaged) return undefined
  const image = nativeImage.createFromPath(join(app.getAppPath(), 'build', 'icon.png'))
  return image.isEmpty() ? undefined : image
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
      sandbox: true,
      contextIsolation: true,
      spellcheck: false
    }
  })

  win.on('ready-to-show', () => win.show())

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
  win.on('maximize', () => send('window:maximized', true))
  win.on('unmaximize', () => send('window:maximized', false))
  win.on('enter-full-screen', () => send('window:fullscreen', true))
  win.on('leave-full-screen', () => send('window:fullscreen', false))
  win.on('focus', () => send('window:focus', true))
  win.on('blur', () => send('window:focus', false))

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  // The window only ever shows the app's own page — the dev server in
  // development, the bundled file otherwise. Navigating anywhere else would
  // swap the document out while `window.harness` stays exposed to whatever
  // loads next, so it is denied; http(s) links go to the browser instead,
  // mirroring the window-open handler above.
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  const devOrigin = devUrl ? new URL(devUrl).origin : null
  win.webContents.on('will-navigate', (event, url) => {
    if (navigationAllowed(url, devOrigin)) return
    event.preventDefault()
    if (/^https?:/.test(url)) shell.openExternal(url)
  })
  // A redirect is never user-initiated, so nothing opens externally here.
  win.webContents.on('will-redirect', (event, url) => {
    if (!navigationAllowed(url, devOrigin)) event.preventDefault()
  })

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
 * Electron hands out every permission by default. Dictation needs the
 * microphone and the pane bell needs notifications; nothing else has a reason
 * to ask, so the rest are refused.
 */
function restrictPermissions(): void {
  const allowed = new Set([
    'media',
    'audioCapture',
    'notifications',
    'clipboard-sanitized-write'
  ])
  const decide = (permission: string): boolean => {
    const ok = allowed.has(permission)
    if (!ok) console.warn(`[permissions] denied ${permission}`)
    return ok
  }
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) =>
    callback(decide(permission))
  )
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => decide(permission))
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

function registerIpc(): void {
  ipcMain.handle('app:info', () => ({
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

  ipcMain.handle('state:load', () => {
    const state = loadState()
    rememberAttention(state)
    return state
  })
  ipcMain.on('state:save', (_e, state: PersistedState) => {
    rememberAttention(state)
    saveState(state)
  })
  ipcMain.handle('state:location', () => stateLocation())

  ipcMain.handle('profiles:list', () => detectProfiles())
  // Both hand back the whole merged list: the renderer keeps one array of
  // profiles, so a save that returned only the saved ones would leave it to
  // re-merge what detectProfiles() has already done.
  ipcMain.handle('profiles:saveCustom', (_e, profile: SavedProfile) => {
    saveCustomProfile(profile)
    return detectProfiles()
  })
  ipcMain.handle('profiles:removeCustom', (_e, id: string) => {
    removeCustomProfile(id)
    return detectProfiles()
  })

  ipcMain.handle('git:info', (_e, dir: string) => repoInfo(dir))
  ipcMain.handle('git:addWorktree', (_e, req: WorktreeRequest) => addWorktree(req))
  ipcMain.handle('git:removeWorktree', (_e, path: string) => removeWorktree(path))
  ipcMain.handle('git:diffStat', (_e, dir: string) => diffStat(dir))
  ipcMain.handle('git:diffRange', (_e, req: DiffRequest) => diffRange(req))
  ipcMain.handle('git:forge', () => detectForge())
  // Stubs the later items replace — registered now so four parallel branches
  // build on a settled surface instead of each adding its own. See HD-14.
  ipcMain.handle('git:checkpoint', () => undefined)
  ipcMain.handle('git:checkpoints', () => [])
  ipcMain.handle('git:restoreCheckpoint', () => ({ ok: false, error: 'not implemented' }))
  ipcMain.handle('git:dropCheckpoints', () => undefined)
  ipcMain.handle('git:deleteBranch', () => ({ ok: false, error: 'not implemented' }))

  ipcMain.handle('update:state', () => currentState())
  ipcMain.handle('update:check', () => checkNow())
  ipcMain.handle('update:setChannel', (_e, channel: UpdateChannel) => setChannel(channel))
  ipcMain.handle('update:install', () => install())

  ipcMain.handle('pty:ensure', (_e, spec: PaneSpec, cols: number, rows: number) =>
    ptys!.ensure(spec, cols, rows)
  )
  ipcMain.on('pty:write', (_e, id: string, data: string) => ptys!.write(id, data))
  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) =>
    ptys!.resize(id, cols, rows)
  )
  ipcMain.on('pty:kill', (_e, id: string) => ptys!.kill(id))
  ipcMain.on('pty:dispose', (_e, id: string) => ptys!.dispose(id))
  ipcMain.handle('pty:status', (_e, id: string) => ptys!.status(id))
  ipcMain.handle('pty:running', () => ptys!.runningIds())
  ipcMain.handle('pty:transcript', (_e, id: string, strip?: boolean) => {
    const text = ptys!.transcript(id)
    return strip ? stripAnsi(text) : text
  })
  ipcMain.handle('pty:tail', (_e, id: string, lines: number) => ptys!.tail(id, lines))

  ipcMain.handle('remote:status', () => REMOTE_OFF)
  ipcMain.handle('remote:setEnabled', () => REMOTE_OFF)
  ipcMain.handle('remote:setLan', () => REMOTE_OFF)
  ipcMain.handle('remote:setAllowTyping', () => REMOTE_OFF)

  ipcMain.handle('fs:missingDirs', (_e, paths: string[]) =>
    (paths ?? []).filter((path) => {
      try {
        return !path || !statSync(path).isDirectory()
      } catch {
        // Unreadable is as good as gone for anything about to spawn there.
        return true
      }
    })
  )

  ipcMain.handle('dialog:pickDirectory', async (_e, current?: string) => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a working directory',
      defaultPath: current || homedir(),
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('dialog:confirm', async (_e, options: { title: string; message: string; detail?: string; confirmLabel?: string }) => {
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

  ipcMain.handle('dialog:saveText', async (_e, req: SaveTextRequest): Promise<SaveTextResult> => {
    if (!mainWindow) return { ok: false, error: 'No window to hang the dialog off.' }
    try {
      const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
        title: 'Save transcript',
        defaultPath: join(saveDir(), req.defaultName),
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

  ipcMain.handle('voice:keyState', (_e, provider: VoiceProvider) => keyState(provider))
  ipcMain.handle('voice:setKey', (_e, provider: VoiceProvider, key: string | null) =>
    setKey(provider, key)
  )
  ipcMain.handle('voice:transcribe', (_e, req: TranscribeRequest) => transcribe(req))
  ipcMain.handle('voice:micAccess', async () => {
    if (process.platform !== 'darwin') return true
    if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') return true
    return systemPreferences.askForMediaAccess('microphone')
  })

  ipcMain.handle('clipboard:read', () => clipboard.readText())
  ipcMain.on('clipboard:write', (_e, text: string) => clipboard.writeText(text))

  ipcMain.on('window:minimize', () => mainWindow?.minimize())
  ipcMain.on('window:toggleMaximize', () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.on('window:close', () => mainWindow?.close())
  ipcMain.handle('window:isMaximized', () => mainWindow?.isMaximized() ?? false)

  // `ms-settings:` is allowed so the app can send the user to the Windows
  // microphone privacy page when capture is blocked there.
  ipcMain.on('app:openExternal', (_e, url: string) => {
    if (/^(https?|ms-settings):/.test(url)) shell.openExternal(url)
  })
  ipcMain.on('app:openPath', (_e, path: string) => shell.openPath(path))
  ipcMain.on('app:setBadge', (_e, count: number) => setBadge(count))

  ipcMain.handle('app:capture', async (_e, target: string) => {
    if (!mainWindow) return null
    const image = await mainWindow.webContents.capturePage()
    const file = resolve(target)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, image.toPNG())
    return file
  })
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
    ptys = new PtyManager(send, undefined, () => quietMs, scrollback)
    registerIpc()
    // Before the window, so the renderer hydrates a state file it did not write.
    if (smoke) seedSmokeState()
    mainWindow = createWindow()

    initUpdater({
      publish: (state) => send('update:changed', state),
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
    disposeUpdater()
    ptys?.disposeAll()
  })
}
