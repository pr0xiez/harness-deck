import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import * as nodePty from '@lydell/node-pty'
import type { IPty } from '@lydell/node-pty'
import type { EnsureResult, PaneSpec, PaneStatus } from '@shared/types'
import { shellCommandLine } from './profiles'
import type { ScrollbackStore } from './scrollback'
import { shellEnv } from './shell-env'

/** How much output we keep per pane so a reloaded window can be repainted. */
const REPLAY_LIMIT = 512 * 1024
/** Coalesce pty output into one IPC message per tick to keep the UI cheap. */
const FLUSH_MS = 8
/** Silence from a running process before it counts as waiting, absent a setting. */
export const DEFAULT_QUIET_MS = 2500
/** Floor for the setting: a quiet window near zero would fire on every burst. */
const MIN_QUIET_MS = 50
/**
 * How much output a pane may produce before its tail is written to disk again.
 * Quitting flushes every pane, so this is only the ceiling on what a crash or a
 * kill -9 costs you.
 */
const PERSIST_MS = 30_000

interface Session {
  id: string
  proc: IPty | null
  status: PaneStatus
  exitCode: number | null
  cols: number
  rows: number
  chunks: string[]
  chunkLen: number
  pending: string[]
  flushTimer: NodeJS.Timeout | null
  /** When the child last wrote something — the clock the quiet timer runs off. */
  lastDataAt: number
  /** The process is alive but has said nothing for a while: it wants you. */
  quiet: boolean
  quietTimer: NodeJS.Timeout | null
  /** The previous run's tail, while it is still the head of `chunks`. */
  restored: string | null
  persistTimer: NodeJS.Timeout | null
}

type Sender = (channel: string, payload: unknown) => void

/** Injectable so tests can drive a session's lifecycle without a real process. */
export type Spawn = typeof nodePty.spawn

export class PtyManager {
  private sessions = new Map<string, Session>()

  /**
   * `quietMs` is read per timer rather than captured, because the user owns it:
   * it lives in the renderer's settings and can change while panes are running.
   *
   * `scrollback` is optional because only the app knows where user data lives —
   * a manager without one keeps everything in memory, which is what every pane
   * did before panes outlived the process.
   */
  constructor(
    private send: Sender,
    private spawn: Spawn = nodePty.spawn,
    private quietMs: () => number = () => DEFAULT_QUIET_MS,
    private scrollback: ScrollbackStore | null = null
  ) {}

  /**
   * Attaches to a pane's process, spawning it if needed. Safe to call again
   * after a window reload — the caller gets the buffered output back.
   */
  ensure(spec: PaneSpec, cols: number, rows: number): EnsureResult {
    const existing = this.sessions.get(spec.id)
    if (existing) {
      if (existing.proc && (existing.cols !== cols || existing.rows !== rows)) {
        this.resize(spec.id, cols, rows)
      }
      // A fresh window knows nothing of an event sent to the old one, and
      // EnsureResult has no room for it — so let the clock re-announce it.
      if (existing.quiet && existing.status === 'running') {
        existing.quiet = false
        this.armQuiet(existing)
      }
      return {
        created: false,
        status: existing.status,
        pid: existing.proc?.pid,
        exitCode: existing.exitCode,
        replay: existing.chunks.join(''),
        previousSession: existing.restored !== null
      }
    }

    const session: Session = {
      id: spec.id,
      proc: null,
      status: 'idle',
      exitCode: null,
      cols: Math.max(cols, 2),
      rows: Math.max(rows, 2),
      chunks: [],
      chunkLen: 0,
      pending: [],
      flushTimer: null,
      lastDataAt: 0,
      quiet: false,
      quietTimer: null,
      restored: null,
      persistTimer: null
    }
    this.sessions.set(spec.id, session)
    this.seed(session)

    const { command, args } = resolveCommand(spec)
    const cwd = resolveCwd(spec.cwd)
    const env = buildEnv(spec, cwd)

    if (cwd !== spec.cwd) {
      this.appendLocal(session, dim(`Working directory ${spec.cwd} is unavailable — using ${cwd}\r\n`))
    }

    try {
      const proc = this.spawn(command, args, {
        name: 'xterm-256color',
        cols: session.cols,
        rows: session.rows,
        cwd,
        env: env as { [key: string]: string },
        useConptyDll: process.platform === 'win32'
      })
      session.proc = proc
      session.status = 'running'

      proc.onData((data) => this.queue(session, data))
      proc.onExit(({ exitCode, signal }) => {
        session.proc = null
        if (!this.isCurrent(session)) return
        // An exited pane is not waiting for you, it is dead, and pane.status
        // already says so — so the clock stops here rather than firing after.
        this.clearQuiet(session)
        session.status = 'exited'
        session.exitCode = exitCode
        this.flush(session)
        this.appendLocal(
          session,
          dim(`\r\n[process exited${signal ? ` on signal ${signal}` : ` with code ${exitCode}`}]\r\n`)
        )
        this.send('pty:exit', { id: session.id, exitCode, signal })
      })

      return {
        created: true,
        status: 'running',
        pid: proc.pid,
        exitCode: null,
        replay: session.chunks.join(''),
        previousSession: session.restored !== null
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      session.status = 'exited'
      session.exitCode = -1
      this.appendLocal(session, red(`Failed to start: ${command}\r\n${message}\r\n`))
      return {
        created: true,
        status: 'exited',
        exitCode: -1,
        replay: session.chunks.join(''),
        previousSession: session.restored !== null,
        error: message
      }
    }
  }

  write(id: string, data: string): void {
    const session = this.sessions.get(id)
    session?.proc?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id)
    if (!session) return
    session.cols = Math.max(cols, 2)
    session.rows = Math.max(rows, 2)
    try {
      session.proc?.resize(session.cols, session.rows)
    } catch {
      /* the process may be on its way out */
    }
  }

  kill(id: string): void {
    const session = this.sessions.get(id)
    if (!session?.proc) return
    try {
      session.proc.kill()
    } catch {
      /* already gone */
    }
  }

  /** Kills the process and forgets its scrollback, on disk as well as in memory. */
  dispose(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    // The pane is being closed or restarted. Either way the next thing to hold
    // this id is not owed the last one's output, and nobody is coming back for
    // a log whose pane no longer exists.
    this.scrollback?.remove(id)
    this.teardown(session)
  }

  /**
   * Shutting down rather than closing up: every pane here is in the state file
   * and will be asked for again next launch, so its tail goes to disk on the
   * way out. That is the one thing this deliberately does not share with
   * `dispose`, which is called when a pane is *gone*.
   */
  disposeAll(): void {
    for (const session of [...this.sessions.values()]) {
      this.persist(session)
      this.teardown(session)
    }
  }

  private teardown(session: Session): void {
    if (session.flushTimer) clearTimeout(session.flushTimer)
    session.flushTimer = null
    this.clearQuiet(session)
    this.clearPersist(session)
    // Unregister before killing. The process dies from our SIGHUP a few
    // milliseconds later, and a restart has already claimed the id by then —
    // whatever it reports on the way out is no longer this pane's news.
    this.sessions.delete(session.id)
    const proc = session.proc
    session.proc = null
    try {
      proc?.kill()
    } catch {
      /* already gone */
    }
  }

  status(id: string): { status: PaneStatus; exitCode: number | null } | null {
    const session = this.sessions.get(id)
    return session ? { status: session.status, exitCode: session.exitCode } : null
  }

  /**
   * Everything the pane has produced that we still hold — the same buffer a
   * reloaded window replays, so it is capped at REPLAY_LIMIT. A pane that never
   * started has nothing to say rather than being an error: the caller is a menu
   * command, and refusing to run on an idle pane would be the surprise.
   */
  transcript(id: string): string {
    return this.sessions.get(id)?.chunks.join('') ?? ''
  }

  /** Ids of every live process, used to warn before quitting. */
  runningIds(): string[] {
    return [...this.sessions.values()].filter((s) => s.status === 'running').map((s) => s.id)
  }

  /** A disposed session keeps running its callbacks — it just no longer speaks for the pane. */
  private isCurrent(session: Session): boolean {
    return this.sessions.get(session.id) === session
  }

  /**
   * Puts the last thing this pane said back on screen. It is history and only
   * that: `status`, `pid` and `exitCode` all belong to the process spawned
   * below it, so a pane whose agent died overnight comes back showing what it
   * did and reporting itself exited, not running.
   */
  private seed(session: Session): void {
    const previous = this.scrollback?.read(session.id)
    if (!previous) return
    // A tail is cut wherever the limit fell, so it rarely ends on a line
    // boundary — and the new session should not start halfway through the old
    // one's last line.
    const restored = previous.endsWith('\n') ? previous : `${previous}\r\n`
    session.restored = restored
    this.record(session, restored)
  }

  private queue(session: Session, data: string): void {
    if (!this.isCurrent(session)) return
    session.lastDataAt = Date.now()
    if (session.quiet) {
      session.quiet = false
      this.send('pty:quiet', { id: session.id, quiet: false })
    }
    this.armQuiet(session)
    this.armPersist(session)
    session.pending.push(data)
    this.record(session, data)
    if (session.flushTimer) return
    session.flushTimer = setTimeout(() => this.flush(session), FLUSH_MS)
  }

  /**
   * Restarts the silence clock. Only output from the child arms it: our own
   * notices (see appendLocal) are not the process saying anything, and a pane
   * that has never written a byte has not "stopped" producing output.
   */
  private armQuiet(session: Session): void {
    if (session.quietTimer) clearTimeout(session.quietTimer)
    session.quietTimer = setTimeout(
      () => {
        session.quietTimer = null
        if (!this.isCurrent(session) || session.status !== 'running' || session.quiet) return
        session.quiet = true
        this.send('pty:quiet', { id: session.id, quiet: true })
      },
      Math.max(MIN_QUIET_MS, this.quietMs())
    )
  }

  private clearQuiet(session: Session): void {
    if (session.quietTimer) clearTimeout(session.quietTimer)
    session.quietTimer = null
    session.quiet = false
  }

  /**
   * Output is what makes a tail worth keeping, so the clock only runs while a
   * pane is producing some: one write per PERSIST_MS of activity, and none at
   * all for a pane sitting at a prompt. Unreferenced because a pane's
   * scrollback is never a reason to hold the process open for half a minute.
   */
  private armPersist(session: Session): void {
    if (session.persistTimer || !this.scrollback) return
    session.persistTimer = setTimeout(() => {
      session.persistTimer = null
      // A disposed pane's log has already been deleted; writing here would put
      // a closed pane's output back on disk with nobody left to clear it.
      if (!this.isCurrent(session)) return
      this.persist(session)
    }, PERSIST_MS)
    session.persistTimer.unref?.()
  }

  private clearPersist(session: Session): void {
    if (session.persistTimer) clearTimeout(session.persistTimer)
    session.persistTimer = null
  }

  private persist(session: Session): void {
    if (!session.chunkLen) return
    this.scrollback?.write(session.id, session.chunks.join(''))
  }

  private flush(session: Session): void {
    if (session.flushTimer) {
      clearTimeout(session.flushTimer)
      session.flushTimer = null
    }
    if (!session.pending.length || !this.isCurrent(session)) return
    const data = session.pending.join('')
    session.pending = []
    this.send('pty:data', { id: session.id, data })
  }

  /** Writes a message that came from us (not the child) into the pane. */
  private appendLocal(session: Session, text: string): void {
    if (!this.isCurrent(session)) return
    this.record(session, text)
    this.send('pty:data', { id: session.id, data: text })
  }

  private record(session: Session, data: string): void {
    session.chunks.push(data)
    session.chunkLen += data.length
    while (session.chunkLen > REPLAY_LIMIT && session.chunks.length > 1) {
      const dropped = session.chunks.shift()!
      session.chunkLen -= dropped.length
      // Once this run has produced enough to push the old one out of the
      // buffer there is no previous session left on screen to rule off.
      if (dropped === session.restored) session.restored = null
    }
  }
}

function resolveCommand(spec: PaneSpec): { command: string; args: string[] } {
  if (spec.viaShell) {
    const cmdline = [spec.command, ...spec.args].join(' ').trim()
    return shellCommandLine(cmdline)
  }
  return { command: spec.command, args: spec.args }
}

function resolveCwd(cwd: string): string {
  try {
    if (cwd && existsSync(cwd) && statSync(cwd).isDirectory()) return cwd
  } catch {
    /* fall through */
  }
  return homedir()
}

function buildEnv(spec: PaneSpec, cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...shellEnv(), ...spec.env }
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.TERM_PROGRAM = 'harness-deck'
  delete env.ELECTRON_RUN_AS_NODE

  // Panes that run through wsl.exe get the pane's directory handed over as a
  // translated unix path (WSLENV's /p flag does the conversion for us).
  if (/(^|[\\/])wsl(\.exe)?$/i.test(spec.command)) {
    env.HD_CWD = cwd
    const existing = env.WSLENV ? `${env.WSLENV}:` : ''
    if (!/(^|:)HD_CWD\//.test(env.WSLENV || '')) env.WSLENV = `${existing}HD_CWD/p`
  }
  return env
}

/**
 * Turns a transcript into something worth pasting into an issue. A terminal
 * stream is mostly instructions — colour, cursor moves, title sets — and only
 * incidentally text; a bug report wants the text. The raw stream stays
 * available through `transcript()` for anyone replaying it into a terminal.
 *
 * Hand-rolled rather than pulled in: the grammar is four shapes wide and this
 * app ships no runtime dependency it can avoid.
 */
export function stripAnsi(text: string): string {
  return (
    text
      // OSC, DCS, SOS, PM, APC — an introducer and a string that runs to BEL or
      // ST. `$` closes the last one because a 512 KB window can be cut mid-escape.
      .replace(/\x1b[\]PX^_][\s\S]*?(?:\x07|\x1b\\|$)/g, '')
      // CSI: parameter bytes, then intermediates, then a final byte in @-~.
      .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '')
      // What is left: an escape with intermediates (charset selects) or without
      // (keypad modes, RI, a stranded ST).
      .replace(/\x1b(?:[ -\/]+[0-~]|[0-~])/g, '')
      // A pty ends lines with CRLF and redraws one with a bare CR. Both become
      // newlines: gluing a redrawn line onto the line it replaced reads as
      // garbage, and losing the frames entirely hides that a redraw happened.
      .replace(/\r\n?/g, '\n')
      // What is left of the C0 set — bells, backspaces, the odd stray NUL.
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
  )
}

const dim = (text: string): string => `\x1b[2m${text}\x1b[0m`
const red = (text: string): string => `\x1b[31m${text}\x1b[0m`
