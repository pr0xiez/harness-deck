import type { BrowserWindow } from 'electron'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PaneSpec } from '@shared/types'
import { PtyManager } from './pty'
import { detectProfiles } from './profiles'

/**
 * `--smoke` support: boots the app for real and asserts it works, so a build
 * that packages cleanly but can't actually run is caught before it ships.
 *
 * Typecheck and a successful `electron-builder` run say nothing about whether
 * the native pty binding loaded, whether the renderer mounted, or whether a
 * pane can start a process — which is exactly the set of things that breaks
 * when a prebuild goes missing or an import turns out to be main-process-only.
 *
 * Everything here uses its own PtyManager and a throwaway user-data directory,
 * so a smoke run never touches the panes or layout of a real session.
 */

export interface Check {
  name: string
  ok: boolean
  detail?: string
}

export interface SmokeReport {
  ok: boolean
  platform: string
  durationMs: number
  checks: Check[]
  rendererErrors: string[]
}

/** Where a smoke run keeps its state, so it can never clobber a real profile. */
export const SMOKE_USER_DATA = join(tmpdir(), 'harness-deck-smoke')

const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

/** Polls until `test` passes or the deadline expires. */
async function until(test: () => boolean | Promise<boolean>, ms: number, step = 100): Promise<boolean> {
  const deadline = Date.now() + ms
  for (;;) {
    if (await test()) return true
    if (Date.now() > deadline) return false
    await wait(step)
  }
}

/** A command that prints `text` and exits, on whichever platform we're on. */
function echoSpec(id: string, text: string): PaneSpec {
  return process.platform === 'win32'
    ? { id, command: 'cmd.exe', args: ['/c', `echo ${text}`], cwd: process.cwd() }
    : { id, command: '/bin/sh', args: ['-c', `echo ${text}`], cwd: process.cwd() }
}

/** A command that stays up long enough to be restarted out from under. */
function idleSpec(id: string): PaneSpec {
  return process.platform === 'win32'
    ? { id, command: 'cmd.exe', args: ['/c', 'ping -n 60 127.0.0.1 >NUL'], cwd: process.cwd() }
    : { id, command: '/bin/sh', args: ['-c', 'sleep 60'], cwd: process.cwd() }
}

/** Talks, falls silent for well over SMOKE_QUIET_MS, talks again, then waits. */
function chattySpec(id: string): PaneSpec {
  return process.platform === 'win32'
    ? {
        id,
        command: 'cmd.exe',
        args: [
          '/c',
          'echo HD_QUIET_1 & ping -n 3 127.0.0.1 >NUL & echo HD_QUIET_2 & ping -n 60 127.0.0.1 >NUL'
        ],
        cwd: process.cwd()
      }
    : {
        id,
        command: '/bin/sh',
        args: ['-c', 'echo HD_QUIET_1; sleep 2; echo HD_QUIET_2; sleep 60'],
        cwd: process.cwd()
      }
}

/** Short enough that one smoke run can watch a pane go quiet and come back. */
const SMOKE_QUIET_MS = 250

interface Recorder {
  mgr: PtyManager
  dataFor(id: string): string
  exitsFor(id: string): number
  quietFor(id: string): boolean[]
}

function recordingManager(): Recorder {
  const messages: Array<{
    channel: string
    payload: { id?: string; data?: string; quiet?: boolean }
  }> = []
  const mgr = new PtyManager(
    (channel, payload) =>
      messages.push({
        channel,
        payload: payload as { id?: string; data?: string; quiet?: boolean }
      }),
    undefined,
    () => SMOKE_QUIET_MS
  )
  return {
    mgr,
    dataFor: (id) =>
      messages
        .filter((m) => m.channel === 'pty:data' && m.payload.id === id)
        .map((m) => m.payload.data ?? '')
        .join(''),
    exitsFor: (id) => messages.filter((m) => m.channel === 'pty:exit' && m.payload.id === id).length,
    quietFor: (id) =>
      messages
        .filter((m) => m.channel === 'pty:quiet' && m.payload.id === id)
        .map((m) => Boolean(m.payload.quiet))
  }
}

/** DOM facts the renderer can report without any test-only code shipped in it. */
const PROBE = `(() => ({
  booting: !!document.querySelector('.boot'),
  app: !!document.querySelector('.app'),
  titlebar: !!document.querySelector('.wordmark'),
  deck: !!document.querySelector('.deck-panes'),
  workspaces: document.querySelectorAll('.ws-row').length,
  terminals: document.querySelectorAll('.xterm').length,
  title: document.title
}))()`

interface Probe {
  booting: boolean
  app: boolean
  titlebar: boolean
  deck: boolean
  workspaces: number
  terminals: number
  title: string
}

/**
 * The broadcast bar is only in the DOM while it is open, so nothing else here
 * would ever mount it. Driving it through the real shortcut exercises the
 * global key handler on the way past.
 */
const TOGGLE_BROADCAST = `(() => {
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'B', ctrlKey: true, shiftKey: true, bubbles: true })
  )
  return true
})()`

const BROADCAST_PROBE = `(() => {
  const bar = document.querySelector('.broadcast')
  return {
    open: !!bar,
    box: !!bar && !!bar.querySelector('textarea'),
    snippets: !!bar && !!bar.querySelector('.snippet-btn'),
    send: !!bar && !!bar.querySelector('.btn.primary')
  }
})()`

interface BroadcastProbe {
  open: boolean
  box: boolean
  snippets: boolean
  send: boolean
}

/** Collects anything the renderer complained about, from before the page loads. */
export function watchRendererErrors(win: BrowserWindow): string[] {
  const errors: string[] = []
  const push = (text: string): void => {
    if (errors.length < 50) errors.push(text)
  }

  // The console-message payload changed shape across Electron majors, so read
  // it defensively rather than pinning to one signature.
  win.webContents.on('console-message', (...args: unknown[]) => {
    const first = args[0] as { level?: unknown; message?: unknown; sourceId?: unknown } | undefined
    const level = first?.level ?? args[1]
    const message = first?.message ?? args[2]
    const isError = level === 'error' || level === 3
    if (isError && message) push(`console: ${String(message)}`)
  })

  win.webContents.on('render-process-gone', (_e, details) =>
    push(`render process gone: ${details.reason}`)
  )
  win.webContents.on('preload-error', (_e, path, error) =>
    push(`preload ${path}: ${error.message}`)
  )
  win.webContents.on('did-fail-load', (_e, code, description) =>
    push(`did-fail-load ${code}: ${description}`)
  )

  return errors
}

export async function runSmoke(win: BrowserWindow, rendererErrors: string[]): Promise<SmokeReport> {
  const started = Date.now()
  const checks: Check[] = []
  const record = async (name: string, run: () => Promise<string | null>): Promise<void> => {
    try {
      const failure = await run()
      checks.push({ name, ok: !failure, ...(failure ? { detail: failure } : {}) })
    } catch (err) {
      checks.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) })
    }
  }

  const probe = async (): Promise<Probe> =>
    (await win.webContents.executeJavaScript(PROBE, true)) as Probe

  const broadcast = async (): Promise<BroadcastProbe> =>
    (await win.webContents.executeJavaScript(BROADCAST_PROBE, true)) as BroadcastProbe

  // Harness detection runs a login shell, which is slow on a cold CI runner —
  // the renderer shows `.boot` until it finishes.
  await record('renderer mounts', async () => {
    const mounted = await until(async () => (await probe()).app, 60_000)
    if (mounted) return null
    const last = await probe()
    return last.booting
      ? 'still on the boot screen after 60s — harness detection never finished'
      : `no .app in the DOM (title ${JSON.stringify(last.title)})`
  })

  await record('window is visible', async () => {
    if (win.isDestroyed()) return 'the window was destroyed'
    const { width, height } = win.getBounds()
    if (width < 100 || height < 100) return `window is ${width}x${height}`
    return win.isVisible() ? null : 'window never showed'
  })

  await record('chrome is rendered', async () => {
    const p = await probe()
    const missing = [
      !p.titlebar && 'titlebar',
      !p.deck && 'pane area',
      p.workspaces < 1 && 'workspace list'
    ].filter(Boolean)
    return missing.length ? `missing ${missing.join(', ')}` : null
  })

  await record('the broadcast bar opens on its shortcut', async () => {
    await win.webContents.executeJavaScript(TOGGLE_BROADCAST, true)
    let bar: BroadcastProbe = { open: false, box: false, snippets: false, send: false }
    const opened = await until(async () => {
      bar = await broadcast()
      return bar.open
    }, 10_000)
    if (!opened) return 'Ctrl+Shift+B never put it in the DOM'

    const missing = [
      !bar.box && 'the prompt box',
      !bar.snippets && 'the snippet menu',
      !bar.send && 'the send button'
    ].filter(Boolean)
    if (missing.length) return `it opened without ${missing.join(', ')}`

    await win.webContents.executeJavaScript(TOGGLE_BROADCAST, true)
    const closed = await until(async () => !(await broadcast()).open, 10_000)
    return closed ? null : 'it would not close again'
  })

  await record('harnesses are detected', async () => {
    const profiles = await detectProfiles()
    if (!profiles.length) return 'detectProfiles() returned nothing'
    const available = profiles.filter((p) => p.available)
    // A runner has no agent CLIs installed, so only the shell is guaranteed —
    // an empty list at all, though, means detection itself is broken.
    return available.length ? null : `none of ${profiles.length} profiles resolved to a binary`
  })

  // Everything below drives node-pty directly. If the native prebuild didn't
  // survive packaging, this is where it shows up.
  const { mgr, dataFor, exitsFor, quietFor } = recordingManager()

  await record('a pane runs a process to completion', async () => {
    const spec = echoSpec('smoke-echo', 'HD_SMOKE_OK')
    const result = mgr.ensure(spec, 80, 24)
    if (result.error) return `spawn failed: ${result.error}`
    if (result.status !== 'running') return `spawned with status ${result.status}`

    const exited = await until(() => mgr.status('smoke-echo')?.status === 'exited', 20_000)
    if (!exited) return 'process never exited'

    const status = mgr.status('smoke-echo')
    if (status?.exitCode !== 0) return `exit code ${status?.exitCode}`
    if (!dataFor('smoke-echo').includes('HD_SMOKE_OK')) {
      return `sentinel never reached the pane (got ${JSON.stringify(dataFor('smoke-echo').slice(0, 120))})`
    }
    return null
  })

  // Reads the same buffer the pane above just filled, so a transcript export
  // that comes back empty is caught here rather than in a save dialog.
  await record('a pane that has run something has a transcript', async () => {
    const text = mgr.transcript('smoke-echo')
    if (!text.includes('HD_SMOKE_OK')) {
      return `transcript is missing the sentinel (got ${JSON.stringify(text.slice(0, 120))})`
    }
    if (mgr.transcript('smoke-never-existed') !== '') return 'an unknown pane returned a transcript'
    return null
  })

  /**
   * The regression this exists for: dispose() kills the old process, but the
   * signal takes a few milliseconds to land — by which time the restart has
   * already claimed the id. The old process's exit used to mark the new pane
   * dead. Here it is with a real process rather than a stub.
   */
  await record('a restarted pane survives the old process dying', async () => {
    const id = 'smoke-restart'
    const first = mgr.ensure(idleSpec(id), 80, 24)
    if (first.status !== 'running') return `first start reported ${first.status}`
    await wait(300)

    mgr.dispose(id)
    const second = mgr.ensure(idleSpec(id), 80, 24)
    if (second.status !== 'running') return `restart reported ${second.status}`
    if (second.replay !== '') return 'restart inherited the old scrollback'

    // Give the first process's SIGHUP time to land and its exit to fire.
    await wait(1500)

    const status = mgr.status(id)
    if (status?.status !== 'running') {
      return `pane went ${status?.status} after the old process died (code ${status?.exitCode})`
    }
    if (exitsFor(id)) return `${exitsFor(id)} exit event(s) reported for a running pane`
    mgr.dispose(id)
    return null
  })

  /**
   * Attention routing rests on a timer that only a live process can exercise:
   * a stub pty proves the bookkeeping, but not that real output ever reaches
   * the clock that arms it.
   */
  await record('a pane that falls silent is reported waiting, and busy again', async () => {
    const id = 'smoke-quiet'
    const result = mgr.ensure(chattySpec(id), 80, 24)
    if (result.error) return `spawn failed: ${result.error}`

    const wentQuiet = await until(() => quietFor(id).includes(true), 15_000)
    if (!wentQuiet) return 'the pane never reported going quiet'

    const cameBack = await until(() => quietFor(id).includes(false), 15_000)
    mgr.dispose(id)
    if (!cameBack) return 'the second burst of output never cleared the quiet flag'

    const [first, second] = quietFor(id)
    return first === true && second === false
      ? null
      : `unexpected sequence ${JSON.stringify(quietFor(id).slice(0, 4))}`
  })

  await record('a failed command is reported, not thrown', async () => {
    const result = mgr.ensure(
      { id: 'smoke-missing', command: 'hd-definitely-not-a-real-binary', args: [], cwd: process.cwd() },
      80,
      24
    )
    // Windows' ConPTY resolves the command lazily, so it may start and then
    // exit rather than failing outright. Either is a correct report.
    if (result.status === 'exited') return null
    const exited = await until(() => mgr.status('smoke-missing')?.status === 'exited', 10_000)
    return exited ? null : 'a missing binary neither failed to spawn nor exited'
  })

  mgr.disposeAll()

  await record('the renderer logged no errors', async () =>
    rendererErrors.length ? rendererErrors.join(' | ') : null
  )

  return {
    ok: checks.every((c) => c.ok),
    platform: process.platform,
    durationMs: Date.now() - started,
    checks,
    rendererErrors
  }
}

/** Human-readable summary for a CI log, alongside the JSON. */
export function formatReport(report: SmokeReport): string {
  const lines = report.checks.map(
    (c) => `  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `\n          ${c.detail}` : ''}`
  )
  const failed = report.checks.filter((c) => !c.ok).length
  lines.push(
    `\n[smoke] ${report.checks.length - failed}/${report.checks.length} checks passed on ${report.platform} in ${report.durationMs}ms`
  )
  return lines.join('\n')
}
