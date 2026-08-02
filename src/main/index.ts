import { app, BrowserWindow, dialog, Menu, nativeImage, session, shell } from 'electron'
import type { NativeImage } from 'electron'
import { join } from 'node:path'
import type { PersistedState } from '@shared/types'
import { captureTarget, installDebugHooks, smoke, voiceCheck } from './debug'
import { registerAppIpc } from './ipc/app'
import { registerDialogIpc } from './ipc/dialogs'
import { registerGitIpc } from './ipc/git'
import { registerProfilesIpc } from './ipc/profiles'
import { registerPtyIpc } from './ipc/pty'
import { registerStateIpc } from './ipc/state'
import { registerUpdateIpc } from './ipc/updates'
import { registerVoiceIpc } from './ipc/voice'
import { registerWindowIpc } from './ipc/window'
import { detectProfiles } from './profiles'
import { DEFAULT_QUIET_MS, PtyManager } from './pty'
import { ScrollbackStore } from './scrollback'
import { loadState } from './store'
import { resolveShellEnv } from './shell-env'
import { seedSmokeState } from './smoke'
import { disposeUpdater, initUpdater } from './updater'

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
      sandbox: false,
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

  // DevTools without an application menu. macOS has one (see installMenu), and
  // its View item owns Cmd+Alt+I — handling it here too would toggle twice.
  win.webContents.on('before-input-event', (_event, input) => {
    if (isMac) return
    const devtools =
      input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')
    if (input.type === 'keyDown' && devtools) win.webContents.toggleDevTools()
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    win.loadURL(devUrl)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

/** The window itself, plus whichever debug hooks the command line asked for. */
function openWindow(): BrowserWindow {
  const win = createWindow()
  installDebugHooks(win, { disposePtys: () => ptys?.disposeAll() })
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
 * Every channel the renderer can reach, grouped by domain under ./ipc. The
 * window goes over as a getter because registration happens before the window
 * exists — and on macOS the window can be rebuilt under the same handlers.
 */
function registerIpc(): void {
  const getWindow = (): BrowserWindow | null => mainWindow
  registerAppIpc({ getWindow })
  registerStateIpc({ rememberAttention })
  registerProfilesIpc()
  registerGitIpc()
  registerUpdateIpc()
  registerPtyIpc(ptys!)
  registerDialogIpc({ getWindow })
  registerVoiceIpc()
  registerWindowIpc({ getWindow })
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
    // --user-data-dir switch and the smoke override in debug.ts have been applied.
    const scrollback = new ScrollbackStore(app.getPath('userData'))
    pruneScrollback(scrollback)
    ptys = new PtyManager(send, undefined, () => quietMs, scrollback)
    registerIpc()
    // Before the window, so the renderer hydrates a state file it did not write.
    if (smoke) seedSmokeState()
    mainWindow = openWindow()

    initUpdater({
      publish: (state) => send('update:changed', state),
      beforeInstallQuit: () => {
        quittingForUpdate = true
      }
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = openWindow()
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
