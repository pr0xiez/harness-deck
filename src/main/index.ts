import { app, BrowserWindow, dialog, Menu, nativeImage, session, shell } from 'electron'
import type { NativeImage } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PersistedState } from '@shared/types'
import { IPC, type IpcChannel } from '@shared/ipc'
import { captureTarget, installDebugHooks, smoke, voiceCheck } from './debug'
import { registerAppIpc } from './ipc/app'
import { registerDialogIpc } from './ipc/dialogs'
import { registerGitIpc } from './ipc/git'
import { registerProfilesIpc } from './ipc/profiles'
import { registerPtyIpc } from './ipc/pty'
import { registerRemoteIpc } from './ipc/remote'
import { registerStateIpc } from './ipc/state'
import { registerUpdateIpc } from './ipc/updates'
import { registerVoiceIpc } from './ipc/voice'
import { registerWindowIpc } from './ipc/window'
import { decidePermission, originOf, type TrustedPage } from './permissions'
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
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url)) event.preventDefault()
  })
  // will-navigate only covers the main frame; this catches subframes too.
  win.webContents.on('will-frame-navigate', (event) => {
    if (!isAllowedNavigation(event.url)) event.preventDefault()
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

  return win
}

/** The window itself, plus whichever debug hooks the command line asked for. */
function openWindow(): BrowserWindow {
  const win = createWindow()
  installDebugHooks(win, { disposePtys: () => ptys?.disposeAll() })
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
 * Every channel the renderer can reach, grouped by domain under ./ipc. The
 * window and the pty manager go over as getters because registration happens
 * before either exists — and on macOS the window can be rebuilt under the same
 * handlers.
 */
function registerIpc(): void {
  const getWindow = (): BrowserWindow | null => mainWindow
  registerAppIpc({ getWindow })
  registerStateIpc({ rememberAttention })
  registerProfilesIpc()
  registerGitIpc()
  registerUpdateIpc()
  registerPtyIpc({ getPtys: () => ptys! })
  registerRemoteIpc()
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
      publish: (state) => send(IPC.updateChanged, state),
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
