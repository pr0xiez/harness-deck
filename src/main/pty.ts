import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import * as nodePty from '@lydell/node-pty'
import type { IPty } from '@lydell/node-pty'
import { commandName, quote } from '@shared/remote'
import type { EnsureResult, PaneSpec, PaneStatus } from '@shared/types'
import { shellCommandLine, shellFlavour, type ShellFlavour } from './profiles'
import type { ScrollbackStore } from './scrollback'
import { defaultShell, shellEnv } from './shell-env'

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

  /**
   * The last `lines` non-empty lines the pane produced, stripped of escapes.
   *
   * The cutting happens here rather than in the renderer because the buffer is
   * half a megabyte and the answer is three lines of it: shipping the rest
   * across IPC so the other side could throw it away would cost a thousand
   * times what the question is worth. Blank lines are dropped before the count,
   * so a TUI that pads its frame still yields three lines that say something.
   */
  tail(id: string, lines: number): string[] {
    const session = this.sessions.get(id)
    if (!session || lines <= 0) return []
    return stripAnsi(session.chunks.join(''))
      .split('\n')
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .slice(-lines)
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

/** Launchers whose argv was built to carry the process to another machine. */
const ELSEWHERE = ['wsl', 'ssh', 'docker']

function resolveCommand(spec: PaneSpec): { command: string; args: string[] } {
  const setup = spec.setup?.trim() ?? ''
  // A remote pane's argv is assembled upstream (profiles.ts, shared/remote.ts)
  // and arrives here as `ssh …` — this machine's ssh. A setup line in front of
  // it would install onto this machine rather than the one the agent is on, so
  // wave A leaves those panes alone: a worktree pane is by construction a
  // folder on this machine that this app created. The match is structural, not
  // general: it holds because those launchers' argv is built upstream with
  // `command` set to exactly `ssh`/`docker`/`…\wsl.exe`. A `viaShell` pane
  // carries its whole line in `command`, so a hand-typed `ssh box claude`
  // sails past — PaneDialog hiding "Run first" on non-local panes is what
  // keeps that combination out of reach.
  const here = !ELSEWHERE.includes(commandName(spec.command))

  if (setup && here) {
    const shell = defaultShell()
    const flavour = shellFlavour(shell)
    // A pane spawned straight off an absolute path has no shell to run the `&&`
    // in, so a setup command promotes it to the shell path — and its argv is
    // quoted back into a command line on the way. A `viaShell` pane's line is
    // what the user typed, quotes and all, and re-quoting it would hand the
    // whole thing over as one filename.
    const promoted = !spec.viaShell
    const cmdline = promoted ? quotedLine(spec, flavour) : plainLine(spec)
    return shellCommandLine(withSetup(setup, cmdline, flavour, promoted), { exits: true, shell })
  }
  if (spec.viaShell) return shellCommandLine(plainLine(spec))
  return { command: spec.command, args: spec.args }
}

const plainLine = (spec: PaneSpec): string => [spec.command, ...spec.args].join(' ').trim()

function quotedLine(spec: PaneSpec, flavour: ShellFlavour): string {
  const line = [spec.command, ...spec.args].map((part) => quoteArg(part, flavour)).join(' ')
  // PowerShell reads a quoted first word as a string to print rather than a
  // program to run; the call operator is what makes it a command again.
  return flavour === 'powershell' ? `& ${line}` : line
}

function quoteArg(value: string, flavour: ShellFlavour): string {
  if (flavour === 'posix') return quote(value)
  // Single quotes are PowerShell's literal string — no `$` expansion, no
  // backticks, an embedded quote doubles. Double quotes are its *expanding*
  // form, and would rewrite an arg like `--prompt=$env:USER` before the agent
  // ever saw it.
  if (flavour === 'powershell') return `'${value.split("'").join("''")}'`
  // cmd has no literal form; a doubled double quote is the closest it reads.
  // Paths with quotes in them do not exist, spaces in them always do.
  return `"${value.split('"').join('""')}"`
}

/**
 * `<setup> && <command>` in each shell's own words. The `&&` is the design: a
 * setup that fails leaves an exited pane with the failure still on screen,
 * never a silent fall-through to an agent loose in a half-built tree.
 *
 * `promoted` marks a cmdline that is a single fully-quoted argv — a pane that
 * had no shell until the setup put one there. That is the only shape `exec`
 * may bind to: a `viaShell` line is the user's own, `&&`s and `;`s included,
 * and `exec` binds to the first simple command only — everything after it
 * would silently never run.
 */
function withSetup(
  setup: string,
  cmdline: string,
  flavour: ShellFlavour,
  promoted: boolean
): string {
  switch (flavour) {
    // cmd.exe has no `exec`; the shell stays as the parent either way.
    case 'cmd':
      return `${setup} && ${cmdline}`
    // PowerShell before 7 has no `&&` at all. $LASTEXITCODE starts the session
    // as $null and only native executables ever set it, so it is primed to 0
    // and read alongside $?: a setup ending in a cmdlet (Copy-Item …) must
    // still start the agent, and a failing one — cmdlet or native — must still
    // stop with the failure as the pane's exit code. $? is captured before the
    // first `if` can overwrite it, and the exit code is consulted first: a
    // failed native command sets both, and `exit 1` would throw the real code
    // away. (Verified against powershell.exe 5.1 — see PR #23.)
    case 'powershell':
      return `$LASTEXITCODE = 0; ${setup}; $ok = $?; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; if (-not $ok) { exit 1 }; ${cmdline}`
    // `exec` so the process on the end of the pane is the agent and not a shell
    // holding it — the exit code, a SIGHUP and a restart all want the real one.
    default:
      return promoted ? `${setup} && exec ${cmdline}` : `${setup} && ${cmdline}`
  }
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

  // A pane that runs elsewhere cannot use the cwd we spawned in — that path
  // belongs to this machine. It gets the folder handed over as HD_CWD instead,
  // and the launcher's argv decides what to do with it (see shared/remote.ts).
  // ssh and docker carry it themselves, with SendEnv and -e; wsl.exe needs
  // WSLENV's /p flag, which translates the path on the way through.
  const name = commandName(spec.command)
  if (name === 'wsl' || name === 'ssh' || name === 'docker') {
    env.HD_CWD = cwd
    if (name === 'wsl') {
      const existing = env.WSLENV ? `${env.WSLENV}:` : ''
      if (!/(^|:)HD_CWD\//.test(env.WSLENV || '')) env.WSLENV = `${existing}HD_CWD/p`
    }
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
