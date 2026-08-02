import { app } from 'electron'
import type { BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { formatReport, runSmoke, SMOKE_USER_DATA, watchRendererErrors } from './smoke'

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
export const smoke = process.argv.includes('--smoke')
const smokeJson = argValue('--smoke-json')
export const captureTarget = argValue('--capture')
const captureDelay = Number(argValue('--capture-delay') ?? 2500)
const captureKeys = argValue('--capture-keys')
const captureKeysDelay = Number(argValue('--capture-keys-delay') ?? 800)
const captureQuit = process.argv.includes('--capture-quit')
export const voiceCheck =
  process.argv.includes('--voice-check') || argValue('--voice-check') !== undefined
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
// means it can run while the app is open.
if (smoke && !process.argv.some((a) => a.startsWith('--user-data-dir'))) {
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

interface DebugDeps {
  /** A smoke run sets the exit code itself, so it has to kill the panes too. */
  disposePtys: () => void
}

/** Attaches whichever of the hooks above the command line asked for. */
export function installDebugHooks(win: BrowserWindow, deps: DebugDeps): void {
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
        deps.disposePtys()
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
}
