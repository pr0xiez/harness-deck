import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  session,
  shell,
  systemPreferences
} from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type {
  PaneSpec,
  PersistedState,
  TranscribeRequest,
  VoiceProvider
} from '@shared/types'
import { detectProfiles } from './profiles'
import { PtyManager } from './pty'
import { loadState, saveState, stateLocation } from './store'
import { defaultShell, resolveShellEnv } from './shell-env'
import { keyState, setKey, transcribe } from './voice'
import { checkNow, currentState, disposeUpdater, initUpdater, install } from './updater'

app.setName('Harness Deck')

let mainWindow: BrowserWindow | null = null
let ptys: PtyManager | null = null
/** Set when we are quitting to hand over to an installer — skip the pane prompt. */
let quittingForUpdate = false

/**
 * Smoke-test hooks:
 *   --capture=<file>            render the window to a PNG
 *   --capture-delay=<ms>        wait before capturing (default 2500)
 *   --capture-keys=ctrl+shift+p press these chords first (comma separated)
 *   --capture-quit              exit once the PNG is written
 *   --dump-profiles             print detected harnesses as JSON and exit
 *   --voice-check[=ms]          record from the mic, transcribe, print JSON, exit
 *   --voice-endpoint=<url>      transcribe against this endpoint for the check
 *   --voice-model=<name>        model to ask that endpoint for
 */
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

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Presses each chord in turn, pausing between them so the UI can react. */
async function sendChords(win: BrowserWindow, chords: string, gap: number): Promise<void> {
  const list = chords.split(',')
  for (const [index, chord] of list.entries()) {
    if (index) await wait(gap)
    const parts = chord.split('+').map((part) => part.trim())
    const key = parts.pop()
    if (!key) continue
    const modifiers = parts.map((part) =>
      part.toLowerCase() === 'ctrl' ? 'control' : part.toLowerCase()
    )
    const keyCode = key.length === 1 ? key.toUpperCase() : key
    for (const type of ['keyDown', 'keyUp'] as const) {
      win.webContents.sendInputEvent({ type, keyCode, modifiers } as Electron.KeyboardInputEvent)
    }
  }
}

function send(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 860,
    minHeight: 560,
    show: false,
    frame: false,
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

  // Closing the window kills every agent, so check first.
  let closeConfirmed = false
  win.on('close', (event) => {
    if (closeConfirmed || captureTarget || voiceCheck || quittingForUpdate) return
    const running = ptys?.runningIds().length ?? 0
    if (!running) return
    if (loadState()?.settings?.confirmCloseRunning === false) return
    event.preventDefault()
    const response = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Quit anyway', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Quit Harness Deck',
      message: `${running} pane${running === 1 ? ' is' : 's are'} still running.`,
      detail: 'Their processes will be terminated.',
      noLink: true
    })
    if (response === 0) {
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

  // DevTools without an application menu.
  win.webContents.on('before-input-event', (_event, input) => {
    const devtools =
      input.key === 'F12' ||
      (input.control && input.shift && input.key.toLowerCase() === 'i') ||
      (input.meta && input.alt && input.key.toLowerCase() === 'i')
    if (input.type === 'keyDown' && devtools) win.webContents.toggleDevTools()
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    win.loadURL(devUrl)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
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

  ipcMain.handle('state:load', () => loadState())
  ipcMain.on('state:save', (_e, state: PersistedState) => saveState(state))
  ipcMain.handle('state:location', () => stateLocation())

  ipcMain.handle('profiles:list', () => detectProfiles())

  ipcMain.handle('update:state', () => currentState())
  ipcMain.handle('update:check', () => checkNow())
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
    Menu.setApplicationMenu(null)
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
    ptys = new PtyManager(send)
    registerIpc()
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
    ptys?.disposeAll()
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    disposeUpdater()
    ptys?.disposeAll()
  })
}
