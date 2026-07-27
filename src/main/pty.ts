import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import * as nodePty from '@lydell/node-pty'
import type { IPty } from '@lydell/node-pty'
import type { EnsureResult, PaneSpec, PaneStatus } from '@shared/types'
import { shellCommandLine } from './profiles'
import { shellEnv } from './shell-env'

/** How much output we keep per pane so a reloaded window can be repainted. */
const REPLAY_LIMIT = 512 * 1024
/** Coalesce pty output into one IPC message per tick to keep the UI cheap. */
const FLUSH_MS = 8

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
}

type Sender = (channel: string, payload: unknown) => void

/** Injectable so tests can drive a session's lifecycle without a real process. */
export type Spawn = typeof nodePty.spawn

export class PtyManager {
  private sessions = new Map<string, Session>()

  constructor(
    private send: Sender,
    private spawn: Spawn = nodePty.spawn
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
      return {
        created: false,
        status: existing.status,
        pid: existing.proc?.pid,
        exitCode: existing.exitCode,
        replay: existing.chunks.join('')
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
      flushTimer: null
    }
    this.sessions.set(spec.id, session)

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
        session.status = 'exited'
        session.exitCode = exitCode
        this.flush(session)
        this.appendLocal(
          session,
          dim(`\r\n[process exited${signal ? ` on signal ${signal}` : ` with code ${exitCode}`}]\r\n`)
        )
        this.send('pty:exit', { id: session.id, exitCode, signal })
      })

      return { created: true, status: 'running', pid: proc.pid, exitCode: null, replay: session.chunks.join('') }
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

  /** Kills the process and forgets its scrollback. */
  dispose(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    if (session.flushTimer) clearTimeout(session.flushTimer)
    session.flushTimer = null
    // Unregister before killing. The process dies from our SIGHUP a few
    // milliseconds later, and a restart has already claimed the id by then —
    // whatever it reports on the way out is no longer this pane's news.
    this.sessions.delete(id)
    const proc = session.proc
    session.proc = null
    try {
      proc?.kill()
    } catch {
      /* already gone */
    }
  }

  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) this.dispose(id)
  }

  status(id: string): { status: PaneStatus; exitCode: number | null } | null {
    const session = this.sessions.get(id)
    return session ? { status: session.status, exitCode: session.exitCode } : null
  }

  /** Ids of every live process, used to warn before quitting. */
  runningIds(): string[] {
    return [...this.sessions.values()].filter((s) => s.status === 'running').map((s) => s.id)
  }

  /** A disposed session keeps running its callbacks — it just no longer speaks for the pane. */
  private isCurrent(session: Session): boolean {
    return this.sessions.get(session.id) === session
  }

  private queue(session: Session, data: string): void {
    if (!this.isCurrent(session)) return
    session.pending.push(data)
    this.record(session, data)
    if (session.flushTimer) return
    session.flushTimer = setTimeout(() => this.flush(session), FLUSH_MS)
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
      session.chunkLen -= session.chunks.shift()!.length
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

const dim = (text: string): string => `\x1b[2m${text}\x1b[0m`
const red = (text: string): string => `\x1b[31m${text}\x1b[0m`
