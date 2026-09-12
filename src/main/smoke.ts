import { app, type BrowserWindow } from 'electron'
import { execFile, execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { rm } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IPC } from '@shared/ipc'
import type { PaneSpec, PersistedState, WorkspaceTemplate } from '@shared/types'
import { addWorktree, diffRange, info as repoInfo, removeWorktree } from './git'
import { PtyManager } from './pty'
import { detectForge, detectProfiles } from './profiles'
import { removeCustomProfile, saveCustomProfile } from './profiles-store'
import { ScrollbackStore } from './scrollback'
import { loadState, saveState } from './store'
import { currentState } from './updater'

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

/**
 * Written to the state file before the window opens, so the template check has
 * the whole round trip to look at: the renderer has to hydrate it out of a file
 * it did not write, and put it back unchanged the next time anything is saved.
 */
export const SMOKE_TEMPLATE: WorkspaceTemplate = {
  id: 'tpl_smoke',
  name: 'Smoke template',
  accent: '#94a3b8',
  layout: 'grid',
  columns: 2,
  createdAt: '2026-01-01T00:00:00.000Z',
  panes: [{ profileId: 'shell:default', command: 'echo', args: ['ok'], cwd: 'packages/api', name: 'api' }]
}

export function seedSmokeState(): void {
  const existing = loadState()
  if (existing?.templates?.length) return
  // Spread over whatever is already there rather than replacing it: --smoke can
  // be pointed at a real profile with --user-data-dir, and all this run needs is
  // a template on the other side of hydrate(). `settings` is left exactly as
  // found — absent if it was absent, since hydrate() spreads its own defaults
  // underneath whatever it reads.
  const seeded = {
    ...(existing ?? { workspaces: [], activeWorkspaceId: null }),
    templates: [SMOKE_TEMPLATE]
  }
  saveState(seeded as PersistedState)
}

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

/**
 * The value a pane's `env` has to carry through untouched. It has a space and
 * an `=` in it because nothing between the dialog and the process may treat it
 * as a KEY=VALUE line to re-split.
 */
const ENV_VALUE = 'sonnet 4-5=x y'

/** A command that prints one variable out of its own environment. */
function envSpec(id: string): PaneSpec {
  const env = { HD_SMOKE_ENV: ENV_VALUE }
  return process.platform === 'win32'
    ? { id, command: 'cmd.exe', args: ['/c', 'echo %HD_SMOKE_ENV%'], cwd: process.cwd(), env }
    : { id, command: '/bin/sh', args: ['-c', 'printf %s "$HD_SMOKE_ENV"'], cwd: process.cwd(), env }
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

/** A machine without git is not a failing app — there is simply nothing to ask. */
function gitInstalled(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** One commit, one file, so a worktree of it has something to disagree about. */
function seedRepo(root: string): void {
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: root, stdio: 'ignore' })
  }
  mkdirSync(root, { recursive: true })
  git('init')
  git('symbolic-ref', 'HEAD', 'refs/heads/main')
  git('config', 'user.email', 'smoke@harness.deck')
  git('config', 'user.name', 'Harness Deck Smoke')
  git('config', 'core.autocrlf', 'false')
  git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(root, 'shared.txt'), 'base\n')
  git('add', '-A')
  git('commit', '-m', 'init')
}

interface Recorder {
  mgr: PtyManager
  dataFor(id: string): string
  exitsFor(id: string): number
  quietFor(id: string): boolean[]
}

function recordingManager(scrollback: ScrollbackStore | null = null): Recorder {
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
    () => SMOKE_QUIET_MS,
    scrollback
  )
  return {
    mgr,
    dataFor: (id) =>
      messages
        .filter((m) => m.channel === IPC.ptyData && m.payload.id === id)
        .map((m) => m.payload.data ?? '')
        .join(''),
    exitsFor: (id) => messages.filter((m) => m.channel === IPC.ptyExit && m.payload.id === id).length,
    quietFor: (id) =>
      messages
        .filter((m) => m.channel === IPC.ptyQuiet && m.payload.id === id)
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
  templates: document.querySelectorAll('.ws-from-template').length,
  locks: document.querySelectorAll('.pane .pane-lock-btn').length,
  title: document.title
}))()`

interface Probe {
  booting: boolean
  app: boolean
  titlebar: boolean
  deck: boolean
  workspaces: number
  terminals: number
  /** The sidebar only offers this once a template has come out of the state file. */
  templates: number
  locks: number
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

/** Anything that changes persisted state; here to make the renderer save. */
const NEW_WORKSPACE = `(() => {
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'N', ctrlKey: true, shiftKey: true, bubbles: true })
  )
  return true
})()`

/**
 * Alt rewrites the character on macOS, so the app matches this chord on the
 * physical key — which means a synthetic event has to carry `code` as well, or
 * it exercises nothing.
 */
const TOGGLE_FIND_ALL = `(() => {
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'F', code: 'KeyF', ctrlKey: true, shiftKey: true, altKey: true, bubbles: true
    })
  )
  return true
})()`

const OPEN_TEMPLATES = `(() => {
  const button = document.querySelector('.ws-from-template')
  if (button) button.click()
  return !!button
})()`

const TEMPLATE_PROBE = `(() => ({
  open: !!document.querySelector('.tpl-list'),
  names: Array.from(document.querySelectorAll('.tpl-row .tpl-name'), (el) => el.textContent)
}))()`

/** Escape closes every overlay in the app, so one helper serves them all. */
const CLOSE_MODAL = `(() => {
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  return true
})()`

interface TemplateProbe {
  open: boolean
  names: string[]
}

const FIND_ALL_PROBE = `(() => {
  const bar = document.querySelector('.deck-search')
  return {
    open: !!bar,
    box: !!bar && !!bar.querySelector('input'),
    count: bar ? (bar.querySelector('.deck-search-count')?.textContent ?? '') : ''
  }
})()`

/**
 * A string no pane will ever have printed, typed the way React insists on: the
 * point is not the answer but the walk — it makes the scan read every live
 * xterm buffer for real, which is the half of the search a DOM probe can't see.
 */
const FIND_ALL_MISS = 'hd-smoke-nothing-prints-this'

const SEARCH_FIND_ALL = `(() => {
  const input = document.querySelector('.deck-search input')
  if (!input) return false
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  set.call(input, ${JSON.stringify(FIND_ALL_MISS)})
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`

interface FindAllProbe {
  open: boolean
  box: boolean
  count: string
}

/**
 * Opens the harness menu on its shortcut and picks the SSH entry out of it by
 * its label, then reads back the dialog that entry is only useful for. No pane
 * is opened: the point is that the menu still reaches the dialog and the dialog
 * still comes up asking for a host, which is all of the wiring and none of the
 * side effects of actually dialling somewhere.
 */
const OPEN_REMOTE_DIALOG = `(() => {
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'T', ctrlKey: true, shiftKey: true, bubbles: true })
  )
  return true
})()`

const PICK_REMOTE_ENTRY = `(() => {
  const item = [...document.querySelectorAll('.menu-item')].find((b) =>
    (b.textContent || '').includes('Over SSH')
  )
  if (!item) return false
  item.click()
  return true
})()`

const REMOTE_DIALOG_PROBE = `(() => {
  const modal = document.querySelector('.modal')
  const labels = modal ? [...modal.querySelectorAll('.field-label')].map((l) => l.textContent) : []
  const on = modal?.querySelector('.segmented.wide button.on')
  return { open: !!modal, host: labels.includes('Host'), where: on?.textContent ?? '' }
})()`

interface RemoteDialogProbe {
  open: boolean
  host: boolean
  where: string
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

  const picker = async (): Promise<TemplateProbe> =>
    (await win.webContents.executeJavaScript(TEMPLATE_PROBE, true)) as TemplateProbe

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

  await record('MCP configuration crosses IPC and the page preserves terminals', async () => {
    // The main-process manager uses a disposable home in smoke mode. No configured
    // command is launched: this checks inventory and writes, not MCP connectivity.
    const failure = await win.webContents.executeJavaScript(`(async () => {
      const api = window.harness.mcp;
      const target = { harness: 'codex', environment: 'native' };
      const first = await api.list(target);
      const source = first.sources.find(s => s.scope === 'user');
      if (!source || !source.writable) return 'no writable disposable MCP source';
      const saved = await api.mutate({ action: 'add', sourceId: source.id,
        revision: source.revision, server: { name: 'deck-smoke', transport: 'stdio',
          command: 'node', args: ['--version'], env: { TOKEN: 'smoke-secret' } } });
      if (!saved.ok) return saved.error;
      const second = await api.list(target);
      if (!second.entries.some(e => e.name === 'deck-smoke')) return 'saved server absent';
      if (JSON.stringify(second).includes('smoke-secret')) return 'credential leaked across IPC';
      window.__mcpSmokeTerminals = [...document.querySelectorAll('.xterm')];
      document.querySelector('button[title="Manage MCP servers"]').click();
      return null;
    })()`, true) as string | null
    if (failure) return failure
    const shown = await until(async () => Boolean(await win.webContents.executeJavaScript(
      `!!(document.querySelector('.mcp-server') && document.querySelector('.mcp-page'))`, true
    )), 10_000)
    if (!shown) return 'MCP page never displayed its saved server'
    await win.webContents.executeJavaScript(`document.querySelector('.mcp-server').click()`, true)
    const detailsShown = await until(async () => Boolean(await win.webContents.executeJavaScript(`!!document.querySelector('.mcp-details')`, true)), 2_000)
    if (!detailsShown) return 'MCP details did not open'
    await Promise.race([
      win.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`, true),
      wait(250)
    ])
    const screenshot = await win.webContents.capturePage()
    mkdirSync(join(process.cwd(), '.tmp'), { recursive: true })
    writeFileSync(join(process.cwd(), '.tmp', 'mcp-page.png'), screenshot.toPNG())
    const retained = await win.webContents.executeJavaScript(`(() => {
      const before = window.__mcpSmokeTerminals;
      const after = [...document.querySelectorAll('.xterm')];
      const kept = before.length === after.length && before.every((el, i) => el === after[i]);
      const hidden = getComputedStyle(document.querySelector('.deck')).display === 'none';
      [...document.querySelectorAll('.mcp-page button')].find(b => b.textContent === 'Back to workspace').click();
      delete window.__mcpSmokeTerminals;
      return kept && hidden;
    })()`, true) as boolean
    const returned = await until(async () => await win.webContents.executeJavaScript(`!document.querySelector('.mcp-page')`, true) as boolean, 2_000)
    return retained && returned ? null : 'MCP navigation lost terminal mounts or failed to return'
  })

  await record('work board shares persisted cards with the bundled CLI and retains terminals', async () => {
    try {
      const enabled = await win.webContents.executeJavaScript('window.harness.work.setAccess(true)', true)
      if (!enabled.enabled) return enabled.error || 'board access did not enable'
      const client = app.isPackaged ? join(process.resourcesPath, 'hd-work.cjs') : join(app.getAppPath(), 'scripts/hd-work.cjs')
      const cli = async (...args: string[]): Promise<any> => JSON.parse((await promisify(execFile)(process.execPath,
        [client, '--discovery', join(app.getPath('userData'), 'work-board-runtime.json'), ...args],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 10_000 })).stdout)
      if (process.platform === 'win32' && process.env.HD_WORK_WSL_SMOKE === '1') {
        const listed = JSON.parse((await promisify(execFile)('wsl.exe', ['-e', 'sh', '-c',
          'exec "$(wslpath -u "$1")" list', 'hd-work', enabled.wslCommand], { timeout: 20_000 })).stdout)
        if (!listed.ok || !Array.isArray(listed.items)) return 'WSL wrapper could not read the board'
      }
      const created = await cli('create', '--title', 'Smoke board card')
      if (!created.ok) return created.error
      const edited = await cli('edit', created.item.id, '--revision', '1', '--description', 'Edited by the harness CLI')
      if (!edited.ok) return edited.error
      const moved = await cli('move', created.item.id, '--revision', '2', '--status', 'in_progress')
      if (!moved.ok) return moved.error
      await win.webContents.executeJavaScript(`window.__boardTerminals = [...document.querySelectorAll('.xterm')]; document.querySelector('button[title="Work board"]').click()`, true)
      const shown = await until(async () => Boolean(await win.webContents.executeJavaScript(`document.querySelector('.work-in_progress')?.textContent.includes('Smoke board card')`, true)), 5000)
      if (!shown) return 'CLI card did not appear in board'
      await cli('move', created.item.id, '--revision', '3', '--status', 'done')
      const live = await until(async () => Boolean(await win.webContents.executeJavaScript(`document.querySelector('.work-done')?.textContent.includes('Smoke board card')`, true)), 5000)
      if (!live) return 'open board did not receive CLI move'
      const persisted = JSON.parse(readFileSync(join(app.getPath('userData'), 'work-board.json'), 'utf8'))
      if (!persisted.items.some((i: { id: string; status: string }) => i.id === created.item.id && i.status === 'done')) return 'CLI move was not persisted'
      await win.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(resolve))`, true)
      mkdirSync(join(process.cwd(), '.tmp'), { recursive: true })
      writeFileSync(join(process.cwd(), '.tmp', 'work-board.png'), (await win.webContents.capturePage()).toPNG())
      const retained = await win.webContents.executeJavaScript(`(() => {
        const before = window.__boardTerminals;
        const after = [...document.querySelectorAll('.xterm')];
        const kept = before.length === after.length && before.every((el, i) => el === after[i]);
        const hidden = getComputedStyle(document.querySelector('.deck')).display === 'none';
        document.querySelector('.ws-row').click();
        delete window.__boardTerminals;
        return kept && hidden;
      })()`, true)
      return retained ? null : 'board navigation lost terminals'
    } finally {
      await win.webContents.executeJavaScript('window.harness.work.setAccess(false)', true)
    }
  })

  // The lock is only worth having if it is one click away on the pane you are
  // looking at, and the class it hangs on is the one the locked styling keys
  // off — so a header that renders without it is the whole feature missing.
  await record('every pane offers the read-only lock', async () => {
    const p = await probe()
    if (p.terminals < 1) return 'the workspace came up with no panes at all'
    return p.locks === p.terminals
      ? null
      : `${p.locks} lock toggle(s) across ${p.terminals} pane(s)`
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

  /**
   * A template is the one thing in the state file the renderer has to carry
   * across untouched: it is written by something else, read once at hydrate,
   * and rewritten by serialize on the next save. Dropping it there would look
   * like the template only lasting until you did anything else.
   */
  await record('a saved template survives hydrate and serialize', async () => {
    const offered = await until(async () => (await probe()).templates > 0, 15_000)
    if (!offered) return 'the seeded template never reached the sidebar'

    await win.webContents.executeJavaScript(OPEN_TEMPLATES, true)
    let list: TemplateProbe = { open: false, names: [] }
    const opened = await until(async () => {
      list = await picker()
      return list.open
    }, 10_000)
    if (!opened) return 'the picker never opened'
    if (!list.names.includes(SMOKE_TEMPLATE.name)) {
      return `the picker listed ${JSON.stringify(list.names)}`
    }

    await win.webContents.executeJavaScript(CLOSE_MODAL, true)
    const closed = await until(async () => !(await picker()).open, 10_000)
    if (!closed) return 'the picker would not close again'

    const before = loadState()?.workspaces.length ?? 0
    await win.webContents.executeJavaScript(NEW_WORKSPACE, true)
    const written = await until(() => (loadState()?.workspaces.length ?? 0) > before, 15_000)
    if (!written) return 'the renderer never wrote its state back'

    const template = loadState()?.templates?.find((t) => t.id === SMOKE_TEMPLATE.id)
    if (!template) return 'it was dropped on the way back to disk'
    const folder = template.panes[0]?.cwd
    if (folder !== SMOKE_TEMPLATE.panes[0].cwd) {
      return `its pane folder came back as ${JSON.stringify(folder)}`
    }
    return null
  })

  await record('find-across-panes opens, and searches every live pane', async () => {
    const findAll = async (): Promise<FindAllProbe> =>
      (await win.webContents.executeJavaScript(FIND_ALL_PROBE, true)) as FindAllProbe

    await win.webContents.executeJavaScript(TOGGLE_FIND_ALL, true)
    let bar: FindAllProbe = { open: false, box: false, count: '' }
    const opened = await until(async () => {
      bar = await findAll()
      return bar.open
    }, 10_000)
    if (!opened) return 'Ctrl+Shift+Alt+F never put it in the DOM'
    if (!bar.box) return 'it opened without its query box'

    await win.webContents.executeJavaScript(SEARCH_FIND_ALL, true)
    const answered = await until(async () => (await findAll()).count === 'no matches', 10_000)
    if (!answered) return `the scan never reported back (it said ${JSON.stringify((await findAll()).count)})`

    await win.webContents.executeJavaScript(TOGGLE_FIND_ALL, true)
    const closed = await until(async () => !(await findAll()).open, 10_000)
    return closed ? null : 'it would not close again'
  })

  await record('the harness menu offers a pane on another machine', async () => {
    const dialog = async (): Promise<RemoteDialogProbe> =>
      (await win.webContents.executeJavaScript(REMOTE_DIALOG_PROBE, true)) as RemoteDialogProbe

    await win.webContents.executeJavaScript(OPEN_REMOTE_DIALOG, true)
    const picked = await until(
      async () => (await win.webContents.executeJavaScript(PICK_REMOTE_ENTRY, true)) === true,
      10_000
    )
    if (!picked) return 'the harness menu never offered an SSH entry'

    let bar: RemoteDialogProbe = { open: false, host: false, where: '' }
    const opened = await until(async () => {
      bar = await dialog()
      return bar.open
    }, 10_000)
    if (!opened) return 'picking it opened no dialog'
    if (bar.where !== 'SSH host') return `the dialog opened on ${JSON.stringify(bar.where)}`
    if (!bar.host) return 'the dialog opened without asking for a host'

    await win.webContents.executeJavaScript(CLOSE_MODAL, true)
    const closed = await until(async () => !(await dialog()).open, 10_000)
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

  /**
   * The ship dialog opens on this answer, so the only failure that matters is
   * the one a runner can't be made to reproduce: a probe that shells out and
   * waits. Whether this machine has `gh` is not the assertion — that it comes
   * back at PATH-walk speed, with one of the three answers, is. See HD-18.
   */
  await record('a forge probe answers without hanging', async () => {
    const started = Date.now()
    const forge = detectForge()
    const took = Date.now() - started
    if (forge !== null && forge !== 'gh' && forge !== 'glab') {
      return `answered ${JSON.stringify(forge)}, which is not a forge CLI`
    }
    return took < 2000 ? null : `took ${took}ms — that is a spawn, not a PATH lookup`
  })

  // The GitHub channel is opt-in, and a build that reaches for it on its own
  // would only show up as a hang behind a runner's egress rules. This asserts
  // it stayed local, and that the feed it *would* use resolved — which is the
  // half of the wiring that can break without any network at all.
  await record('the updater stays off the network', async () => {
    const state = currentState()
    if (state.channel !== 'local') return `booted on the ${state.channel} channel`
    if (!state.feedUrl.startsWith('https://github.com/')) {
      return `no release feed resolved (${state.feedUrl || 'empty'}) — check "repository" in package.json`
    }
    return state.stage === 'error' ? `the local channel reported: ${state.error}` : null
  })

  /**
   * HD-2 in one assertion: two panes pointed at one repo have to end up writing
   * to different directories, and closing one must never be able to take the
   * main checkout with it. Cheap, and it runs against a real git — which is the
   * only thing that can tell us whether the plumbing commands still mean what
   * `git.ts` thinks they mean.
   */
  await record('two worktrees of one repo are independent checkouts', async () => {
    if (!gitInstalled()) return null
    // Resolved, because macOS hands out a /var symlink for the temp directory
    // and git reports the /private path back.
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'hd-smoke-git-')))
    try {
      const root = join(base, 'repo')
      seedRepo(root)
      const at = (branch: string): string =>
        join(base, '.harness-deck', 'repo', ...branch.split('/'))

      const a = await addWorktree({ repo: root, branch: 'hd/smoke-a', path: at('hd/smoke-a') })
      if (!a.ok || !a.path) return `the first worktree was refused: ${a.error}`
      const b = await addWorktree({ repo: root, branch: 'hd/smoke-b', path: at('hd/smoke-b') })
      if (!b.ok || !b.path) return `the second worktree was refused: ${b.error}`
      if (a.path === b.path) return 'both panes were handed the same directory'

      const shared = (dir: string): string => join(dir, 'shared.txt')
      writeFileSync(shared(a.path), 'agent a\n')
      writeFileSync(shared(b.path), 'agent b\n')
      if (readFileSync(shared(a.path), 'utf8') === readFileSync(shared(b.path), 'utf8')) {
        return 'one agent overwrote the other'
      }
      if (readFileSync(shared(root), 'utf8') !== 'base\n') return 'the main checkout was written to'

      const repo = await repoInfo(a.path)
      if (repo?.worktreeOf !== root) {
        return `the worktree does not point back at its repo (${repo?.worktreeOf ?? 'nothing'})`
      }
      if (repo.branch !== 'hd/smoke-a') return `it is on ${repo.branch}`
      if (repo.dirty !== 1) return `it reports ${repo.dirty} uncommitted change(s), expected 1`

      const refused = await removeWorktree(root)
      if (refused.ok) return 'the main working tree was removable'
      if (!existsSync(shared(root))) return 'the main checkout was deleted'

      const removed = await removeWorktree(a.path)
      if (!removed.ok) return `removing a worktree failed: ${removed.error}`
      if (existsSync(a.path)) return 'the worktree directory is still there'

      return (await repoInfo(base)) === null ? null : 'a folder that is not a repo reported one'
    } finally {
      // A failed assertion above must not leave a repo in the temp directory.
      await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })

  /**
   * HD-3 in one assertion, and it is about the two things a plain `git diff`
   * gets wrong for an agent: work it committed, and files it created without
   * telling git. Both have to reach the column, and a diff nobody would read
   * has to be cut before it is handed to a renderer.
   */
  await record('a worktree diff covers committed and brand-new work, and is capped', async () => {
    if (!gitInstalled()) return null
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'hd-smoke-diff-')))
    try {
      const root = join(base, 'repo')
      seedRepo(root)
      const path = join(base, '.harness-deck', 'repo', 'hd', 'smoke-diff')
      const made = await addWorktree({ repo: root, branch: 'hd/smoke-diff', path })
      if (!made.ok || !made.path) return `the worktree was refused: ${made.error}`

      const clean = await diffRange({ dir: made.path })
      if (clean.stat) return `an untouched worktree reported ${JSON.stringify(clean.stat)}`
      if (clean.baseRef !== 'main') return `it measured against ${clean.baseRef}`

      writeFileSync(join(made.path, 'shared.txt'), 'the agent rewrote this\n')
      execFileSync('git', ['add', '-A'], { cwd: made.path, stdio: 'ignore' })
      execFileSync('git', ['commit', '-m', 'agent work'], { cwd: made.path, stdio: 'ignore' })
      writeFileSync(join(made.path, 'notes.md'), Array(4000).fill('a new line').join('\n'))

      const diff = await diffRange({ dir: made.path, limit: 120 })
      if (!diff.stat.includes('shared.txt')) return 'the committed change never reached the summary'
      if (!diff.stat.includes('notes.md')) return 'the new file never reached the summary'
      if (diff.untracked !== 1) return `it counted ${diff.untracked} new files`
      if (!diff.patch.includes('+the agent rewrote this')) return 'the patch is missing the edit'

      const lines = diff.patch.split('\n').length
      if (lines > 120) return `${lines} lines came back for a cap of 120`
      if (!diff.truncated) return 'a 4,000-line diff came back marked complete'
      return diff.patchLines > 4000 ? null : `it reported only ${diff.patchLines} lines in full`
    } finally {
      // A failed assertion above must not leave a repo in the temp directory.
      await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
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
   * The one case the replay buffer never covered: it lives inside a
   * PtyManager, and a real quit takes the whole process with it. A second
   * manager over the same directory is as close as one run gets to relaunching
   * the app, and it is the whole of what the feature promises.
   */
  await record('a pane tail survives the manager that produced it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hd-smoke-scrollback-'))
    const id = 'smoke-scrollback'
    try {
      const store = new ScrollbackStore(dir)
      const before = recordingManager(store)
      const started = before.mgr.ensure(echoSpec(id, 'HD_SCROLLBACK_OK'), 80, 24)
      if (started.error) return `spawn failed: ${started.error}`
      if (!(await until(() => before.mgr.status(id)?.status === 'exited', 20_000))) {
        return 'process never exited'
      }
      before.mgr.disposeAll() // the quit

      const after = recordingManager(store)
      const restored = after.mgr.ensure(idleSpec(id), 80, 24)
      try {
        if (!restored.previousSession) return 'the replay came back unmarked'
        if (!restored.replay.includes('HD_SCROLLBACK_OK')) {
          return `the tail did not come back (got ${JSON.stringify(restored.replay.slice(0, 120))})`
        }
        // What is on screen is history; the process under it is the new one.
        if (restored.status !== 'running') return `a restored pane reported ${restored.status}`
      } finally {
        after.mgr.dispose(id)
      }
      return store.read(id) === '' ? null : 'closing the pane left its log on disk'
    } finally {
      // A failed assertion must not leave a temp directory behind either.
      rmSync(dir, { recursive: true, force: true })
    }
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

  await record("a pane's environment reaches its process intact", async () => {
    const id = 'smoke-env'
    const result = mgr.ensure(envSpec(id), 80, 24)
    if (result.error) return `spawn failed: ${result.error}`

    const exited = await until(() => mgr.status(id)?.status === 'exited', 20_000)
    if (!exited) return 'process never exited'
    if (!dataFor(id).includes(ENV_VALUE)) {
      return `the variable never arrived (got ${JSON.stringify(dataFor(id).slice(0, 120))})`
    }
    return null
  })

  await record('a saved launcher joins the detected list', async () => {
    const id = 'custom:smoke'
    try {
      saveCustomProfile({
        id,
        name: 'Smoke launcher',
        command: 'echo',
        args: ['ok'],
        env: { HD_SMOKE_ENV: ENV_VALUE },
        icon: 'SL',
        accent: '#94a3b8',
        viaShell: true
      })
      const found = (await detectProfiles()).find((p) => p.id === id)
      if (!found) return 'saveCustom() wrote it but detectProfiles() did not return it'
      if (found.kind !== 'custom') return `it came back as kind ${found.kind}`
      if (found.env?.HD_SMOKE_ENV !== ENV_VALUE) return 'its environment did not survive the round trip'
      removeCustomProfile(id)
      if ((await detectProfiles()).some((p) => p.id === id)) return 'removeCustom() left it behind'
      return null
    } finally {
      // A failed assertion must not leave the launcher in the next run's list.
      removeCustomProfile(id)
    }
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
