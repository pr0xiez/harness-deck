import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IPty } from '@lydell/node-pty'
import { homedir } from 'node:os'
import type { PaneSpec } from '@shared/types'
import { OUTPUT_HIGH_WATER, OUTPUT_LOW_WATER, PtyManager, stripAnsi, type Spawn } from './pty'
import { ScrollbackStore, SCROLLBACK_LIMIT } from './scrollback'
import { AgentSessions } from './agent-sessions'

/** Matches FLUSH_MS in pty.ts — output is coalesced into one message per tick. */
const FLUSH_MS = 8
/** Matches REPLAY_LIMIT in pty.ts. */
const REPLAY_LIMIT = 512 * 1024
/** Matches DEFAULT_QUIET_MS in pty.ts. */
const QUIET_MS = 2500
/** Matches PERSIST_MS in pty.ts. */
const PERSIST_MS = 30_000

let pidSeq = 1000

/**
 * A pty that never starts a process. The lifecycle bugs worth testing here are
 * all about *when* a callback fires relative to a dispose, which a real process
 * won't reproduce on demand — so the test drives onData/onExit itself.
 */
class FakePty {
  pid = ++pidSeq
  cols = 80
  rows = 24
  process = 'fake'
  killed = false
  pause = vi.fn()
  resume = vi.fn()
  written: string[] = []
  resized: Array<[number, number]> = []

  private dataCbs: Array<(data: string) => void> = []
  private exitCbs: Array<(e: { exitCode: number; signal?: number }) => void> = []

  onData = (cb: (data: string) => void): { dispose(): void } => {
    this.dataCbs.push(cb)
    return { dispose: () => {} }
  }
  onExit = (cb: (e: { exitCode: number; signal?: number }) => void): { dispose(): void } => {
    this.exitCbs.push(cb)
    return { dispose: () => {} }
  }
  write = (data: string): void => {
    this.written.push(data)
  }
  resize = (cols: number, rows: number): void => {
    this.resized.push([cols, rows])
  }
  kill = (): void => {
    this.killed = true
  }

  /** Test driver: the child wrote something. */
  emit(data: string): void {
    for (const cb of [...this.dataCbs]) cb(data)
  }
  /** Test driver: the child went away. */
  exit(exitCode = 0, signal?: number): void {
    for (const cb of [...this.exitCbs]) cb({ exitCode, signal })
  }
}

interface Harness {
  mgr: PtyManager
  sent: Array<{ channel: string; payload: Record<string, unknown> }>
  spawned: FakePty[]
  /** What the manager asked the pty layer for, in order. */
  calls: Array<{ command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }>
  /** Every `pty:data` payload for an id, concatenated. */
  dataFor(id: string): string
  /** The `quiet` flag of every `pty:quiet` event for an id, in order. */
  quietFor(id: string): boolean[]
}

function harness(
  spawnImpl?: () => never,
  quietMs = QUIET_MS,
  scrollback: ScrollbackStore | null = null,
  agentSessions: AgentSessions | null = null
): Harness {
  const sent: Harness['sent'] = []
  const spawned: FakePty[] = []
  const calls: Harness['calls'] = []
  const spawn: Spawn = (command, args, options) => {
    if (spawnImpl) spawnImpl()
    calls.push({
      command,
      args: Array.isArray(args) ? [...args] : [String(args)],
      cwd: String(options?.cwd ?? ''),
      env: (options?.env ?? {}) as NodeJS.ProcessEnv
    })
    const proc = new FakePty()
    spawned.push(proc)
    return proc as unknown as IPty
  }
  const mgr = new PtyManager(
    (channel, payload) => sent.push({ channel, payload: payload as Record<string, unknown> }),
    spawn,
    () => quietMs,
    scrollback,
    agentSessions
  )
  return {
    mgr,
    sent,
    spawned,
    calls,
    dataFor: (id) =>
      sent
        .filter((m) => m.channel === 'pty:data' && m.payload.id === id)
        .map((m) => String(m.payload.data))
        .join(''),
    quietFor: (id) =>
      sent
        .filter((m) => m.channel === 'pty:quiet' && m.payload.id === id)
        .map((m) => Boolean(m.payload.quiet))
  }
}

const spec = (id: string, over: Partial<PaneSpec> = {}): PaneSpec => ({
  id,
  command: 'fake-agent',
  args: [],
  // A real directory, so ensure() doesn't prepend its "unavailable" notice.
  cwd: process.cwd(),
  ...over
})

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ensure', () => {
  it('reattaches without replacing the agent session record, then resumes after restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hd-pty-agent-'))
    const id = '550e8400-e29b-41d4-a716-446655440000'
    const h = harness(undefined, QUIET_MS, null, new AgentSessions(dir))
    const launch = spec('agent', { command: 'codex' })
    try {
      h.mgr.ensure(launch, 80, 24)
      const record = h.calls[0].env.HD_SESSION_FILE!
      writeFileSync(record, JSON.stringify({ session_id: id }))
      expect(h.mgr.ensure(launch, 90, 30).created).toBe(false)
      expect(h.calls).toHaveLength(1)
      h.mgr.dispose('agent')
      expect(h.mgr.ensure(launch, 80, 24).status).toBe('running')
      expect(h.calls[1].args.slice(0, 2)).toEqual(['resume', id])
      h.mgr.disposeAll()
      const nextApp = harness(undefined, QUIET_MS, null, new AgentSessions(dir))
      nextApp.mgr.ensure(launch, 80, 24)
      expect(nextApp.calls[0].args.slice(0, 2)).toEqual(['resume', id])
      nextApp.mgr.disposeAll()
    } finally {
      h.mgr.disposeAll()
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('spawns a process and reports it running', () => {
    const { mgr, spawned } = harness()
    const result = mgr.ensure(spec('a'), 100, 40)

    expect(result).toMatchObject({ created: true, status: 'running', exitCode: null, replay: '' })
    expect(spawned).toHaveLength(1)
    expect(result.pid).toBe(spawned[0].pid)
    expect(mgr.status('a')).toEqual({ status: 'running', exitCode: null })
  })

  it('re-attaches to a live session instead of spawning a second one', () => {
    const { mgr, spawned } = harness()
    mgr.ensure(spec('a'), 100, 40)
    spawned[0].emit('hello ')
    spawned[0].emit('world')

    const again = mgr.ensure(spec('a'), 100, 40)

    expect(spawned).toHaveLength(1)
    expect(again).toMatchObject({ created: false, status: 'running' })
    expect(again.replay).toBe('hello world')
  })

  it('resizes an existing session when the terminal came back a different size', () => {
    const { mgr, spawned } = harness()
    mgr.ensure(spec('a'), 100, 40)
    mgr.ensure(spec('a'), 120, 50)

    expect(spawned[0].resized).toEqual([[120, 50]])
  })

  it('reports a spawn failure in-band rather than throwing', () => {
    const { mgr } = harness(() => {
      throw new Error('ENOENT: no such file')
    })
    const result = mgr.ensure(spec('a'), 100, 40)

    expect(result).toMatchObject({ created: true, status: 'exited', exitCode: -1 })
    expect(result.error).toContain('ENOENT')
    expect(result.replay).toContain('Failed to start: fake-agent')
    expect(mgr.status('a')).toEqual({ status: 'exited', exitCode: -1 })
  })
})

describe('output', () => {
  it('coalesces a burst into one message per tick', () => {
    const { mgr, spawned, sent } = harness()
    mgr.ensure(spec('a'), 100, 40)
    spawned[0].emit('one ')
    spawned[0].emit('two ')
    spawned[0].emit('three')

    expect(sent.filter((m) => m.channel === 'pty:data')).toHaveLength(0)
    vi.advanceTimersByTime(FLUSH_MS)

    const messages = sent.filter((m) => m.channel === 'pty:data')
    expect(messages).toHaveLength(1)
    expect(messages[0].payload).toEqual({ id: 'a', data: 'one two three', flowId: 1, offset: 13 })
  })

  it('caps the replay buffer but keeps the newest output', () => {
    const { mgr, spawned } = harness()
    mgr.ensure(spec('a'), 100, 40)
    const chunk = 'x'.repeat(64 * 1024)
    for (let i = 0; i < 20; i++) spawned[0].emit(chunk)
    spawned[0].emit('LATEST')

    const { replay } = mgr.ensure(spec('a'), 100, 40)
    expect(replay.length).toBeLessThanOrEqual(REPLAY_LIMIT)
    expect(replay.endsWith('LATEST')).toBe(true)
  })
})

describe('output backpressure', () => {
  function flowing() {
    const h = harness()
    h.mgr.ensure(spec('a'), 80, 24)
    return h
  }

  it('pauses before IPC flush and resumes only after parsing below the low watermark', () => {
    const { mgr, spawned, sent } = flowing()
    const proc = spawned[0]
    proc.emit('x'.repeat(OUTPUT_HIGH_WATER))
    expect(proc.pause).toHaveBeenCalledTimes(1)
    expect(proc.resume).not.toHaveBeenCalled()
    vi.advanceTimersByTime(FLUSH_MS)
    const { flowId, offset } = sent.find((e) => e.channel === 'pty:data')!.payload
    expect(offset).toBe(OUTPUT_HIGH_WATER)
    mgr.acknowledge('a', Number(flowId), OUTPUT_HIGH_WATER - OUTPUT_LOW_WATER - 1)
    expect(proc.resume).not.toHaveBeenCalled()
    mgr.acknowledge('a', Number(flowId), OUTPUT_HIGH_WATER - OUTPUT_LOW_WATER)
    expect(proc.resume).toHaveBeenCalledTimes(1)
    proc.emit('y'.repeat(OUTPUT_HIGH_WATER))
    expect(proc.pause).toHaveBeenCalledTimes(2)
  })

  it('counts UTF-8 bytes, including output already sent but not parsed', () => {
    const { mgr, spawned, sent } = flowing()
    spawned[0].emit('é'.repeat(OUTPUT_HIGH_WATER / 4))
    vi.advanceTimersByTime(FLUSH_MS)
    spawned[0].emit('é'.repeat(OUTPUT_HIGH_WATER / 4))
    expect(spawned[0].pause).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(FLUSH_MS)
    const last = sent.filter((e) => e.channel === 'pty:data').at(-1)!.payload
    expect(last.offset).toBe(OUTPUT_HIGH_WATER)
    mgr.acknowledge('a', Number(last.flowId), Number(last.offset))
    expect(spawned[0].resume).toHaveBeenCalledTimes(1)
  })

  it('ignores invalid, duplicated, and stale acknowledgements', () => {
    const { mgr, spawned } = flowing()
    spawned[0].emit('x'.repeat(OUTPUT_HIGH_WATER))
    vi.advanceTimersByTime(FLUSH_MS)
    for (const offset of [NaN, Infinity, -1, 1.5, OUTPUT_HIGH_WATER + 1]) mgr.acknowledge('a', 1, offset)
    mgr.acknowledge('a', 999, OUTPUT_HIGH_WATER)
    mgr.acknowledge('missing', 1, OUTPUT_HIGH_WATER)
    expect(spawned[0].resume).not.toHaveBeenCalled()
    mgr.acknowledge('a', 1, OUTPUT_HIGH_WATER)
    spawned[0].emit('x'.repeat(OUTPUT_HIGH_WATER))
    vi.advanceTimersByTime(FLUSH_MS)
    mgr.acknowledge('a', 1, OUTPUT_HIGH_WATER)
    expect(spawned[0].resume).toHaveBeenCalledTimes(1)
  })

  it('resumes on detach and keeps only replay while the window is absent', () => {
    const { mgr, spawned, sent } = flowing()
    spawned[0].emit('x'.repeat(OUTPUT_HIGH_WATER))
    mgr.detachAll()
    expect(spawned[0].resume).toHaveBeenCalledTimes(1)
    for (let n = 0; n < 8; n++) spawned[0].emit('y'.repeat(OUTPUT_HIGH_WATER))
    vi.advanceTimersByTime(FLUSH_MS)
    expect(sent.filter((e) => e.channel === 'pty:data')).toHaveLength(0)
    expect(mgr.transcript('a').length).toBeLessThanOrEqual(REPLAY_LIMIT)
    mgr.ensure(spec('a'), 80, 24)
    spawned[0].emit('z'.repeat(OUTPUT_HIGH_WATER))
    vi.advanceTimersByTime(FLUSH_MS)
    mgr.acknowledge('a', 1, OUTPUT_HIGH_WATER)
    expect(spawned[0].resume).toHaveBeenCalledTimes(1)
    mgr.acknowledge('a', 2, OUTPUT_HIGH_WATER)
    expect(spawned[0].resume).toHaveBeenCalledTimes(2)
  })

  it('reattaches with pending output in replay only, and a fresh acknowledgement generation', () => {
    const { mgr, spawned, sent } = flowing()
    spawned[0].emit('pending')
    expect(mgr.ensure(spec('a'), 80, 24).replay).toBe('pending')
    vi.advanceTimersByTime(FLUSH_MS)
    expect(sent.filter((e) => e.channel === 'pty:data')).toHaveLength(0)
    spawned[0].emit('x'.repeat(OUTPUT_HIGH_WATER))
    vi.advanceTimersByTime(FLUSH_MS)
    mgr.acknowledge('a', 1, OUTPUT_HIGH_WATER)
    expect(spawned[0].resume).not.toHaveBeenCalled()
    mgr.acknowledge('a', 2, OUTPUT_HIGH_WATER)
    expect(spawned[0].resume).toHaveBeenCalledTimes(1)
  })

  it('does not apply callbacks from a killed session to its replacement', () => {
    const { mgr, spawned } = flowing()
    spawned[0].emit('x'.repeat(OUTPUT_HIGH_WATER))
    vi.advanceTimersByTime(FLUSH_MS)
    mgr.dispose('a')
    mgr.ensure(spec('a'), 80, 24)
    spawned[1].emit('x'.repeat(OUTPUT_HIGH_WATER))
    vi.advanceTimersByTime(FLUSH_MS)
    mgr.acknowledge('a', 1, OUTPUT_HIGH_WATER)
    expect(spawned[1].resume).not.toHaveBeenCalled()
    mgr.acknowledge('a', 2, OUTPUT_HIGH_WATER)
    expect(spawned[1].resume).toHaveBeenCalledTimes(1)
  })

  it('does not announce a throttled producer as waiting for user input', () => {
    const { mgr, spawned, quietFor } = flowing()
    spawned[0].emit('x'.repeat(OUTPUT_HIGH_WATER))
    vi.advanceTimersByTime(QUIET_MS * 2)
    expect(quietFor('a')).toEqual([])
    mgr.acknowledge('a', 1, OUTPUT_HIGH_WATER)
    vi.advanceTimersByTime(QUIET_MS)
    expect(quietFor('a')).toEqual([true])
  })

  it('caps replay even when one callback exceeds the limit', () => {
    const { mgr, spawned } = flowing()
    spawned[0].emit('x'.repeat(REPLAY_LIMIT * 2) + 'end')
    expect(mgr.transcript('a').length).toBe(REPLAY_LIMIT)
    expect(mgr.transcript('a').endsWith('end')).toBe(true)
  })
})

/**
 * The signal here is the inverse of the obvious one: output *stopping* while
 * the process is still alive is what means "an agent is at a prompt". Every
 * test below is about the edges of that — silence that is really a dead
 * process, or a timer outliving the session that armed it.
 */
describe('quiet', () => {
  it('announces a running pane that has stopped producing output', () => {
    const { mgr, spawned, quietFor } = harness()
    mgr.ensure(spec('a'), 100, 40)
    spawned[0].emit('thinking…')

    vi.advanceTimersByTime(QUIET_MS - 1)
    expect(quietFor('a')).toEqual([])

    vi.advanceTimersByTime(1)
    expect(quietFor('a')).toEqual([true])
  })

  it('says it once, however long the silence lasts', () => {
    const { mgr, spawned, quietFor } = harness()
    mgr.ensure(spec('a'), 100, 40)
    spawned[0].emit('thinking…')
    vi.advanceTimersByTime(QUIET_MS * 10)

    expect(quietFor('a')).toEqual([true])
  })

  it('takes the window from the injected setting, not a constant', () => {
    const { mgr, spawned, quietFor } = harness(undefined, 400)
    mgr.ensure(spec('a'), 100, 40)
    spawned[0].emit('thinking…')

    vi.advanceTimersByTime(399)
    expect(quietFor('a')).toEqual([])
    vi.advanceTimersByTime(1)
    expect(quietFor('a')).toEqual([true])
  })

  it('reports the pane busy again on the first byte after the silence', () => {
    const { mgr, spawned, quietFor } = harness()
    mgr.ensure(spec('a'), 100, 40)
    spawned[0].emit('thinking…')
    vi.advanceTimersByTime(QUIET_MS)

    spawned[0].emit('and back')
    expect(quietFor('a')).toEqual([true, false])

    vi.advanceTimersByTime(QUIET_MS)
    expect(quietFor('a')).toEqual([true, false, true])
  })

  it('stays silent about a pane that only ever went on producing output', () => {
    const { mgr, spawned, quietFor } = harness()
    mgr.ensure(spec('a'), 100, 40)
    for (let i = 0; i < 10; i++) {
      spawned[0].emit(`line ${i}\r\n`)
      vi.advanceTimersByTime(QUIET_MS - 10)
    }

    expect(quietFor('a')).toEqual([])
  })

  it('says nothing about a pane whose process exited mid-silence', () => {
    const { mgr, spawned, quietFor } = harness()
    mgr.ensure(spec('a'), 100, 40)
    spawned[0].emit('nearly done')

    vi.advanceTimersByTime(QUIET_MS - 10)
    spawned[0].exit(0)
    vi.advanceTimersByTime(QUIET_MS * 2)

    expect(quietFor('a')).toEqual([])
    expect(mgr.status('a')).toEqual({ status: 'exited', exitCode: 0 })
  })

  it('says nothing more once a pane that was already waiting exits', () => {
    const { mgr, spawned, quietFor } = harness()
    mgr.ensure(spec('a'), 100, 40)
    spawned[0].emit('waiting for you')
    vi.advanceTimersByTime(QUIET_MS)
    expect(quietFor('a')).toEqual([true])

    spawned[0].exit(0)
    vi.advanceTimersByTime(QUIET_MS * 2)

    expect(quietFor('a')).toEqual([true])
  })

  /** Same disposal race as the restart tests below: a stale timer must not speak. */
  it('drops the pending timer when the pane is disposed', () => {
    const { mgr, spawned, quietFor } = harness()
    mgr.ensure(spec('a'), 100, 40)
    spawned[0].emit('half a thought')

    mgr.dispose('a')
    vi.advanceTimersByTime(QUIET_MS * 2)

    expect(quietFor('a')).toEqual([])
  })

  it('does not let a replaced session report quiet for the pane that took its id', () => {
    const { mgr, spawned, quietFor } = harness()
    mgr.ensure(spec('a'), 100, 40)
    const old = spawned[0]
    old.emit('output from the first run')

    mgr.dispose('a')
    mgr.ensure(spec('a'), 100, 40)
    old.emit('stale output from the process being replaced')
    vi.advanceTimersByTime(QUIET_MS * 2)

    expect(quietFor('a')).toEqual([])
  })

  it('re-announces a quiet pane to a window that reattached', () => {
    const { mgr, spawned, quietFor } = harness()
    mgr.ensure(spec('a'), 100, 40)
    spawned[0].emit('waiting for you')
    vi.advanceTimersByTime(QUIET_MS)
    expect(quietFor('a')).toEqual([true])

    // A reloaded window never heard the first event.
    mgr.ensure(spec('a'), 100, 40)
    vi.advanceTimersByTime(QUIET_MS)

    expect(quietFor('a')).toEqual([true, true])
  })
})

describe('transcript', () => {
  it('hands back everything the pane has produced, unflushed output included', () => {
    const { mgr, spawned } = harness()
    mgr.ensure(spec('a'), 100, 40)
    spawned[0].emit('first ')
    spawned[0].emit('second')

    expect(mgr.transcript('a')).toBe('first second')
  })

  it('keeps the tail once the pane has scrolled past the replay limit', () => {
    const { mgr, spawned } = harness()
    mgr.ensure(spec('a'), 100, 40)
    const chunk = 'x'.repeat(64 * 1024)
    for (let i = 0; i < 20; i++) spawned[0].emit(chunk)
    spawned[0].emit('LATEST')

    const text = mgr.transcript('a')
    expect(text.length).toBeLessThanOrEqual(REPLAY_LIMIT)
    expect(text.endsWith('LATEST')).toBe(true)
  })

  it('is empty for a pane that never started, rather than an error', () => {
    const { mgr } = harness()

    expect(mgr.transcript('ghost')).toBe('')
  })

  it('is empty again after the pane is disposed', () => {
    const { mgr, spawned } = harness()
    mgr.ensure(spec('a'), 100, 40)
    spawned[0].emit('output from the first run')
    mgr.dispose('a')

    expect(mgr.transcript('a')).toBe('')
  })
})

/**
 * The waiting queue's answer to "why is this pane waiting" is the last thing it
 * said, so the cut has to happen here: the buffer is half a megabyte and the
 * question is three lines wide.
 */
describe('tail', () => {
  it('hands back the last lines, stripped of the escapes that drew them', () => {
    const { mgr, spawned } = harness()
    mgr.ensure(spec('a'), 100, 40)
    spawned[0].emit('\x1b[32mRunning tests\x1b[0m\r\n')
    spawned[0].emit('\x1b[2m14 passed\x1b[0m\r\n')
    spawned[0].emit('Apply this patch? \x1b[1m(y/n)\x1b[0m')

    expect(mgr.tail('a', 3)).toEqual(['Running tests', '14 passed', 'Apply this patch? (y/n)'])
  })

  it('skips the blank lines a redrawn frame leaves behind', () => {
    const { mgr, spawned } = harness()
    mgr.ensure(spec('a'), 100, 40)
    spawned[0].emit('first\r\n\r\n   \r\nsecond\r\n\r\n')

    expect(mgr.tail('a', 3)).toEqual(['first', 'second'])
  })

  it('reads the tail of a pane that has scrolled past the replay limit without shipping it', () => {
    const { mgr, spawned } = harness()
    mgr.ensure(spec('a'), 100, 40)
    const chunk = `${'x'.repeat(64 * 1024)}\r\n`
    for (let i = 0; i < 20; i++) spawned[0].emit(chunk)
    spawned[0].emit('Waiting for your approval\r\n')

    const tail = mgr.tail('a', 3)
    expect(tail[tail.length - 1]).toBe('Waiting for your approval')
    // The whole point: the caller gets three lines, not the 512 KB they came
    // out of. Two of these are still the last of the giant chunks.
    expect(tail).toHaveLength(3)
    expect(mgr.transcript('a').length).toBeGreaterThan(REPLAY_LIMIT / 2)
  })

  it('is empty for a pane that never started, rather than an error', () => {
    const { mgr } = harness()

    expect(mgr.tail('ghost', 3)).toEqual([])
  })

  it('is empty when nothing was asked for', () => {
    const { mgr, spawned } = harness()
    mgr.ensure(spec('a'), 100, 40)
    spawned[0].emit('something\r\n')

    expect(mgr.tail('a', 0)).toEqual([])
  })
})

/**
 * Quitting the app used to be indistinguishable from deleting every pane's
 * output. These are the edges of no longer doing that: a tail that keeps its
 * own size down, a restored one that never claims to be a live process, and a
 * write that must not land for a pane that has since been closed.
 */
describe('scrollback', () => {
  let dir: string
  let store: ScrollbackStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hd-scrollback-'))
    store = new ScrollbackStore(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const logFile = (id: string): string => join(dir, 'scrollback', `${id}.log`)
  const saving = (spawnImpl?: () => never): Harness => harness(spawnImpl, QUIET_MS, store)

  it('writes a pane tail to disk while the pane is producing output', () => {
    const { mgr, spawned } = saving()
    mgr.ensure(spec('a'), 100, 40)
    spawned[0].emit('work in progress')

    vi.advanceTimersByTime(PERSIST_MS - 1)
    expect(existsSync(logFile('a'))).toBe(false)

    vi.advanceTimersByTime(1)
    expect(readFileSync(logFile('a'), 'utf8')).toBe('work in progress')
  })

  it('writes again as the pane goes on producing output', () => {
    const { mgr, spawned } = saving()
    mgr.ensure(spec('a'), 100, 40)
    spawned[0].emit('first ')
    vi.advanceTimersByTime(PERSIST_MS)
    spawned[0].emit('second')
    vi.advanceTimersByTime(PERSIST_MS)

    expect(readFileSync(logFile('a'), 'utf8')).toBe('first second')
  })

  it('leaves nothing on disk for a pane that never said anything', () => {
    const { mgr } = saving()
    mgr.ensure(spec('a'), 100, 40)
    vi.advanceTimersByTime(PERSIST_MS * 5)

    expect(existsSync(logFile('a'))).toBe(false)
  })

  it('keeps what it writes bounded, however long the pane has run', () => {
    const { mgr, spawned } = saving()
    mgr.ensure(spec('a'), 100, 40)
    const chunk = 'x'.repeat(64 * 1024)
    for (let i = 0; i < 6; i++) spawned[0].emit(chunk)
    spawned[0].emit('LATEST')
    vi.advanceTimersByTime(PERSIST_MS)

    const written = readFileSync(logFile('a'), 'utf8')
    expect(written.length).toBeLessThanOrEqual(SCROLLBACK_LIMIT)
    // Smaller than what a reloaded window replays — orientation, not forensics.
    expect(written.length).toBeLessThan(mgr.transcript('a').length)
    expect(written.endsWith('LATEST')).toBe(true)
  })

  it('writes every live pane on the way out', () => {
    const { mgr, spawned } = saving()
    mgr.ensure(spec('a'), 100, 40)
    mgr.ensure(spec('b'), 100, 40)
    spawned[0].emit('from a')
    spawned[1].emit('from b')

    mgr.disposeAll()

    expect(readFileSync(logFile('a'), 'utf8')).toBe('from a')
    expect(readFileSync(logFile('b'), 'utf8')).toBe('from b')
  })

  it('seeds a pane the app has seen before, and says the replay is history', () => {
    const first = saving()
    first.mgr.ensure(spec('a'), 100, 40)
    first.spawned[0].emit('what it was doing')
    first.mgr.disposeAll()

    const { mgr, spawned } = saving()
    const result = mgr.ensure(spec('a'), 100, 40)

    expect(result.replay).toContain('what it was doing')
    expect(result.previousSession).toBe(true)
    // The status belongs to the process that just started, not to the one that
    // wrote the file — a tail on disk never makes a pane look alive.
    expect(result).toMatchObject({ created: true, status: 'running', exitCode: null })
    expect(result.pid).toBe(spawned[0].pid)
    expect(spawned).toHaveLength(1)
  })

  it('reports a restored pane that will not start as exited, not running', () => {
    store.write('a', 'what it was doing')
    const { mgr } = saving(() => {
      throw new Error('ENOENT: no such file')
    })
    const result = mgr.ensure(spec('a'), 100, 40)

    expect(result).toMatchObject({ status: 'exited', exitCode: -1, previousSession: true })
    expect(result.replay).toContain('what it was doing')
    expect(mgr.status('a')).toEqual({ status: 'exited', exitCode: -1 })
    expect(mgr.runningIds()).toEqual([])
  })

  it('starts the new session on a line of its own', () => {
    store.write('a', 'a tail cut mid-line')
    const { mgr } = saving()

    expect(mgr.ensure(spec('a'), 100, 40).replay).toBe('a tail cut mid-line\r\n')
  })

  it('still rules off the restored tail for a window that reloaded', () => {
    store.write('a', 'what it was doing')
    const { mgr, spawned } = saving()
    mgr.ensure(spec('a'), 100, 40)
    spawned[0].emit('and what it is doing now')

    const again = mgr.ensure(spec('a'), 100, 40)

    expect(again).toMatchObject({ created: false, previousSession: true })
    expect(again.replay).toContain('what it was doing')
  })

  it('stops calling it a previous session once this run has scrolled past it', () => {
    store.write('a', 'what it was doing')
    const { mgr, spawned } = saving()
    expect(mgr.ensure(spec('a'), 100, 40).previousSession).toBe(true)

    const chunk = 'x'.repeat(64 * 1024)
    for (let i = 0; i < 9; i++) spawned[0].emit(chunk)

    const again = mgr.ensure(spec('a'), 100, 40)
    expect(again.previousSession).toBe(false)
    expect(again.replay).not.toContain('what it was doing')
  })

  it('deletes the log of a pane that was closed', () => {
    const { mgr, spawned } = saving()
    mgr.ensure(spec('a'), 100, 40)
    spawned[0].emit('output from the first run')
    vi.advanceTimersByTime(PERSIST_MS)
    expect(existsSync(logFile('a'))).toBe(true)

    mgr.dispose('a')

    expect(existsSync(logFile('a'))).toBe(false)
  })

  it('does not bring the old run back when a pane is restarted', () => {
    const { mgr, spawned } = saving()
    mgr.ensure(spec('a'), 100, 40)
    spawned[0].emit('output from the first run')
    vi.advanceTimersByTime(PERSIST_MS)

    mgr.dispose('a')
    const restarted = mgr.ensure(spec('a'), 100, 40)

    expect(restarted.replay).toBe('')
    expect(restarted.previousSession).toBe(false)
  })

  /** Same disposal race as the quiet timer: a stale timer must not write. */
  it('does not write for a pane that was disposed before the timer landed', () => {
    const { mgr, spawned } = saving()
    mgr.ensure(spec('a'), 100, 40)
    spawned[0].emit('half a thought')

    mgr.dispose('a')
    vi.advanceTimersByTime(PERSIST_MS * 2)

    expect(existsSync(logFile('a'))).toBe(false)
  })

  it('does not let a replaced session write over the pane that took its id', () => {
    const { mgr, spawned } = saving()
    mgr.ensure(spec('a'), 100, 40)
    const old = spawned[0]
    old.emit('output from the first run')

    mgr.dispose('a')
    mgr.ensure(spec('a'), 100, 40)
    spawned[1].emit('fresh')
    old.emit('stale output from the process being replaced')
    vi.advanceTimersByTime(PERSIST_MS)

    expect(readFileSync(logFile('a'), 'utf8')).toBe('fresh')
  })

  it('keeps everything in memory when there is nowhere to write', () => {
    const { mgr, spawned } = harness()
    mgr.ensure(spec('a'), 100, 40)
    spawned[0].emit('nowhere to go')
    vi.advanceTimersByTime(PERSIST_MS * 2)

    expect(mgr.transcript('a')).toBe('nowhere to go')
    expect(mgr.ensure(spec('a'), 100, 40).previousSession).toBe(false)
  })
})

describe('the scrollback store', () => {
  let dir: string
  let store: ScrollbackStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hd-scrollback-'))
    store = new ScrollbackStore(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('has nothing to say about a pane it has never seen', () => {
    expect(store.read('ghost')).toBe('')
  })

  it('writes no more than the tail it promises', () => {
    store.write('a', `${'x'.repeat(SCROLLBACK_LIMIT * 2)}LATEST`)

    const text = store.read('a')
    expect(text.length).toBe(SCROLLBACK_LIMIT)
    expect(text.endsWith('LATEST')).toBe(true)
  })

  it('forgets a pane rather than leaving a stale log when its output is empty', () => {
    store.write('a', 'something')
    store.write('a', '')

    expect(store.read('a')).toBe('')
  })

  it('drops the logs of panes the state file no longer has', () => {
    store.write('kept', 'still open')
    store.write('gone', 'closed while the app was not running')

    store.prune(['kept'])

    expect(store.read('kept')).toBe('still open')
    expect(store.read('gone')).toBe('')
  })

  it('leaves files that are not its own alone', () => {
    mkdirSync(join(dir, 'scrollback'), { recursive: true })
    writeFileSync(join(dir, 'scrollback', 'notes.txt'), 'not mine', 'utf8')

    store.prune([])

    expect(existsSync(join(dir, 'scrollback', 'notes.txt'))).toBe(true)
  })

  it('prunes nothing before anything has been written', () => {
    expect(() => store.prune(['a'])).not.toThrow()
  })

  it('keeps a hand-edited pane id inside its own directory', () => {
    store.write('../../escaped', 'nowhere but here')

    expect(existsSync(join(dir, 'scrollback', '.._.._escaped.log'))).toBe(true)
    expect(store.read('../../escaped')).toBe('nowhere but here')
  })
})

describe('stripAnsi', () => {
  it('leaves text that was never a terminal stream alone', () => {
    expect(stripAnsi('plain\nlines\there')).toBe('plain\nlines\there')
  })

  it('takes out colour without touching what it coloured', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m and \x1b[1;32mbold green\x1b[0m')).toBe(
      'red and bold green'
    )
  })

  it('takes out cursor moves and screen clears', () => {
    expect(stripAnsi('\x1b[2J\x1b[H\x1b[10;5Hhere\x1b[K')).toBe('here')
  })

  it('takes out an OSC title and stops at its terminator', () => {
    expect(stripAnsi('\x1b]0;claude — /repo\x07prompt> ')).toBe('prompt> ')
    expect(stripAnsi('\x1b]0;title\x1b\\after')).toBe('after')
  })

  it('drops an escape the 512 KB window cut in half', () => {
    expect(stripAnsi('done\x1b]0;a title with no terminator')).toBe('done')
  })

  it('turns a pty line ending into a newline, and a redraw into its own line', () => {
    expect(stripAnsi('one\r\ntwo\r\n')).toBe('one\ntwo\n')
    expect(stripAnsi('50%\r100%')).toBe('50%\n100%')
  })

  it('drops the bell rather than leaving a control byte in a pasted transcript', () => {
    expect(stripAnsi('ding\x07 done')).toBe('ding done')
  })

  it('survives a stream that is nothing but escapes', () => {
    expect(stripAnsi('\x1b[?2004h\x1b[?25l\x1b(B\x1b[m')).toBe('')
  })
})

describe('exit', () => {
  it('marks the pane exited and announces it once', () => {
    const { mgr, spawned, sent, dataFor } = harness()
    mgr.ensure(spec('a'), 100, 40)
    spawned[0].exit(3)

    expect(mgr.status('a')).toEqual({ status: 'exited', exitCode: 3 })
    expect(sent.filter((m) => m.channel === 'pty:exit')).toEqual([
      { channel: 'pty:exit', payload: { id: 'a', exitCode: 3, signal: undefined } }
    ])
    expect(dataFor('a')).toContain('[process exited with code 3]')
  })

  it('names the signal when one killed the process', () => {
    const { mgr, spawned, dataFor } = harness()
    mgr.ensure(spec('a'), 100, 40)
    spawned[0].exit(0, 9)

    expect(dataFor('a')).toContain('[process exited on signal 9]')
  })

  it('drops an exited session out of runningIds', () => {
    const { mgr, spawned } = harness()
    mgr.ensure(spec('a'), 100, 40)
    mgr.ensure(spec('b'), 100, 40)
    expect(mgr.runningIds().sort()).toEqual(['a', 'b'])

    spawned[0].exit(0)
    expect(mgr.runningIds()).toEqual(['b'])
  })
})

describe('restart', () => {
  /**
   * The bug this guards: dispose() kills the old process, but it doesn't die
   * until our SIGHUP lands a few milliseconds later — by which time a restart
   * has already claimed the id. Its exit event used to mark the *new* pane dead.
   */
  it('ignores the old process exiting after a restart claimed the id', () => {
    const { mgr, spawned, sent } = harness()
    mgr.ensure(spec('a'), 100, 40)
    const old = spawned[0]

    mgr.dispose('a')
    const restarted = mgr.ensure(spec('a'), 100, 40)
    expect(restarted).toMatchObject({ created: true, status: 'running' })

    old.exit(1) // the SIGHUP finally lands

    expect(mgr.status('a')).toEqual({ status: 'running', exitCode: null })
    expect(mgr.runningIds()).toEqual(['a'])
    expect(sent.filter((m) => m.channel === 'pty:exit')).toHaveLength(0)
  })

  it('ignores output the old process wrote on its way out', () => {
    const { mgr, spawned, dataFor } = harness()
    mgr.ensure(spec('a'), 100, 40)
    const old = spawned[0]

    mgr.dispose('a')
    mgr.ensure(spec('a'), 100, 40)

    old.emit('stale output from the process being replaced')
    spawned[1].emit('fresh')
    vi.advanceTimersByTime(FLUSH_MS)

    expect(dataFor('a')).toBe('fresh')
  })

  it('kills the old process and forgets its scrollback', () => {
    const { mgr, spawned } = harness()
    mgr.ensure(spec('a'), 100, 40)
    spawned[0].emit('output from the first run')

    mgr.dispose('a')
    expect(spawned[0].killed).toBe(true)

    const restarted = mgr.ensure(spec('a'), 100, 40)
    expect(restarted.replay).toBe('')
  })

  it('does not flush a pending burst that dispose interrupted', () => {
    const { mgr, spawned, sent } = harness()
    mgr.ensure(spec('a'), 100, 40)
    spawned[0].emit('half-written line')

    mgr.dispose('a')
    vi.advanceTimersByTime(FLUSH_MS)

    expect(sent.filter((m) => m.channel === 'pty:data')).toHaveLength(0)
  })
})

describe('addressing a pane that has gone', () => {
  it('treats write, resize, kill and status on an unknown id as no-ops', () => {
    const { mgr } = harness()

    expect(() => mgr.write('ghost', 'hi')).not.toThrow()
    expect(() => mgr.resize('ghost', 80, 24)).not.toThrow()
    expect(() => mgr.kill('ghost')).not.toThrow()
    expect(() => mgr.dispose('ghost')).not.toThrow()
    expect(mgr.status('ghost')).toBeNull()
  })

  it('stops forwarding writes once the pane is disposed', () => {
    const { mgr, spawned } = harness()
    mgr.ensure(spec('a'), 100, 40)
    mgr.write('a', 'before')
    mgr.dispose('a')
    mgr.write('a', 'after')

    expect(spawned[0].written).toEqual(['before'])
  })
})

describe('resize', () => {
  it('clamps to a size a pty will accept', () => {
    const { mgr, spawned } = harness()
    mgr.ensure(spec('a'), 100, 40)
    mgr.resize('a', 0, -5)

    expect(spawned[0].resized).toEqual([[2, 2]])
  })

  it('survives a resize racing the process going away', () => {
    const { mgr, spawned } = harness()
    mgr.ensure(spec('a'), 100, 40)
    spawned[0].resize = () => {
      throw new Error('ioctl failed')
    }

    expect(() => mgr.resize('a', 90, 30)).not.toThrow()
  })
})

describe('a pane that runs elsewhere', () => {
  const envFor = (command: string, cwd?: string): NodeJS.ProcessEnv => {
    const { mgr, calls } = harness()
    mgr.ensure(spec('a', { command, ...(cwd === undefined ? {} : { cwd }) }), 80, 24)
    return calls[0].env
  }

  it('hands the pane folder over as HD_CWD', () => {
    expect(envFor('ssh').HD_CWD).toBe(process.cwd())
    expect(envFor('docker').HD_CWD).toBe(process.cwd())
    expect(envFor('C:\\Windows\\System32\\wsl.exe').HD_CWD).toBe(process.cwd())
  })

  // The folder the process actually got, not the one the pane asked for —
  // otherwise a remote pane is told to cd somewhere this machine gave up on.
  it('hands over the folder it fell back to, not the one that was gone', () => {
    expect(envFor('ssh', '/harness-deck/no/such/folder').HD_CWD).toBe(homedir())
  })

  // WSL translates the path on the way through; ssh and docker carry it as it
  // stands, and a stray WSLENV on either would be noise a remote shell inherits.
  it('asks for the path translation on the WSL route only', () => {
    expect(envFor('wsl.exe').WSLENV).toContain('HD_CWD/p')
    expect(envFor('ssh').WSLENV).toBeUndefined()
    expect(envFor('docker').WSLENV).toBeUndefined()
  })

  it('leaves a pane that runs here alone', () => {
    expect(envFor('fake-agent').HD_CWD).toBeUndefined()
    // `sshuttle` and `dockerize` are not ssh and docker.
    expect(envFor('/usr/bin/sshuttle').HD_CWD).toBeUndefined()
    expect(envFor('dockerize').HD_CWD).toBeUndefined()
  })
})

/**
 * A workspace's setup command runs in the same pane, ahead of the agent, which
 * means composing it onto the command line of whichever shell this platform
 * has. Every branch below is a shell that says "and then" differently — and the
 * first test is the promise that a workspace without one changed nothing.
 */
describe('a pane with a setup command', () => {
  const HOST = process.platform
  let dir = ''

  /** `process.platform` is read-only; this is the only way to ask the other ones. */
  const onPlatform = (value: NodeJS.Platform): void => {
    Object.defineProperty(process, 'platform', { value, configurable: true })
  }

  /** Where Windows looks for a shell, pointed at a directory a test fills in. */
  const windowsShellsIn = (root: string): void => {
    vi.stubEnv('SystemRoot', root)
    vi.stubEnv('ProgramFiles', root)
    vi.stubEnv('LOCALAPPDATA', root)
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hd-pty-shell-'))
  })

  afterEach(() => {
    onPlatform(HOST)
    vi.unstubAllEnvs()
    rmSync(dir, { recursive: true, force: true })
  })

  const argvFor = (over: Partial<PaneSpec>): { command: string; args: string[] } => {
    const { mgr, calls } = harness()
    mgr.ensure(spec('a', over), 80, 24)
    return { command: calls[0].command, args: calls[0].args }
  }

  it('spawns byte-identical commands for a workspace that set neither field', () => {
    onPlatform('linux')
    vi.stubEnv('SHELL', '/bin/bash')

    expect(argvFor({})).toEqual({ command: 'fake-agent', args: [] })
    expect(argvFor({ setup: '' })).toEqual({ command: 'fake-agent', args: [] })
    expect(argvFor({ command: '/opt/hd/claude', args: ['--resume'] })).toEqual({
      command: '/opt/hd/claude',
      args: ['--resume']
    })
    expect(argvFor({ command: 'npm run dev', viaShell: true })).toEqual({
      command: '/bin/bash',
      args: ['-l', '-i', '-c', 'npm run dev']
    })
  })

  it('runs the setup first, and the command only if it passed', () => {
    onPlatform('linux')
    vi.stubEnv('SHELL', '/bin/bash')

    expect(argvFor({ setup: ' npm ci ', command: 'npm run dev', viaShell: true })).toEqual({
      command: '/bin/bash',
      args: ['-l', '-i', '-c', 'npm ci && npm run dev']
    })
  })

  /**
   * No `exec` on a `viaShell` line: it is the user's own, `&&`s and `;`s
   * included, and `exec` binds to the first simple command only — `npm ci &&
   * exec npm run build && npm run dev` runs the build and silently never the
   * dev server. The shell staying as the parent is also what a `viaShell` pane
   * did before it had a setup.
   */
  it('leaves a compound viaShell line whole rather than handing it to exec', () => {
    onPlatform('linux')
    vi.stubEnv('SHELL', '/bin/bash')

    expect(
      argvFor({ setup: 'npm ci', command: 'npm run build && npm run dev', viaShell: true })
    ).toEqual({
      command: '/bin/bash',
      args: ['-l', '-i', '-c', 'npm ci && npm run build && npm run dev']
    })
  })

  /**
   * The common case: an agent spawned straight off the absolute path
   * `findExecutable` returned, with no shell anywhere in the picture — so there
   * is nothing for `&&` to run in until the setup command puts one there.
   */
  it('promotes a pane that had no shell, quoting its argv back into a line', () => {
    onPlatform('darwin')
    vi.stubEnv('SHELL', '/bin/zsh')

    expect(
      argvFor({ setup: 'npm ci', command: '/Users/a b/bin/claude', args: ['--model', 'opus'] })
    ).toEqual({
      command: '/bin/zsh',
      args: ['-l', '-i', '-c', "npm ci && exec '/Users/a b/bin/claude' '--model' 'opus'"]
    })
  })

  /**
   * `/c`, not `/k`: a pane with a setup must report its exit — `/k` leaves an
   * interactive prompt as the pty's process, so onExit never fires, the pane
   * reads as running forever and auto-restart is dead. A plain viaShell pane
   * keeps the `/k` it has always had.
   */
  it('leaves out the exec on cmd.exe, which has none, and tells it to exit', () => {
    onPlatform('win32')
    windowsShellsIn(dir)
    vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\cmd.exe')

    expect(argvFor({ setup: 'npm ci', command: 'npm run dev', viaShell: true })).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/c', 'npm ci && npm run dev']
    })
    expect(argvFor({ command: 'npm run dev', viaShell: true })).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/k', 'npm run dev']
    })
  })

  /**
   * cmd.exe expands `%VAR%` during tokenization — inside double quotes too —
   * and a `/c` line has no escape for `%`, so a promoted argv carrying one
   * cannot be quoted faithfully. Spawning anyway would run a line that
   * quietly differs from the pane's spec; the manager refuses instead, in the
   * same in-band shape a bad path lands in.
   */
  it('refuses to promote an argv cmd.exe would rewrite, rather than spawn a lie', () => {
    onPlatform('win32')
    windowsShellsIn(dir)
    vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\cmd.exe')

    const { mgr, calls } = harness()
    const result = mgr.ensure(
      spec('a', { setup: 'npm ci', args: ['--prompt=%USERPROFILE%'] }),
      80,
      24
    )

    expect(calls).toHaveLength(0)
    expect(result).toMatchObject({ created: true, status: 'exited', exitCode: -1 })
    expect(result.error).toContain('%...%')
    expect(result.replay).toContain('Failed to start: fake-agent')
    expect(mgr.status('a')).toEqual({ status: 'exited', exitCode: -1 })
  })

  /**
   * The PowerShell preamble carries three findings at once: $LASTEXITCODE is
   * $null until a *native* executable sets it, so it is primed to 0 or a
   * cmdlet-only setup would never start the agent; $? is what a failing cmdlet
   * shows; and there is no -NoExit — the shell must die with the command so
   * the pane's exit code is real (the trailing `exit` forwards the agent's).
   */
  it('asks PowerShell for the exit code, having no && to ask it with', () => {
    onPlatform('win32')
    const pwsh = join(dir, 'PowerShell', '7', 'pwsh.exe')
    mkdirSync(join(dir, 'PowerShell', '7'), { recursive: true })
    writeFileSync(pwsh, '')
    windowsShellsIn(dir)

    const guard =
      '$LASTEXITCODE = 0; npm ci; $ok = $?; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; if (-not $ok) { exit 1 }'
    expect(argvFor({ setup: 'npm ci', command: 'npm run dev', viaShell: true })).toEqual({
      command: pwsh,
      args: ['-NoLogo', '-Command', `${guard}; npm run dev; exit $LASTEXITCODE`]
    })
    // The call operator, because a quoted path on its own is a string to
    // print — and single quotes, PowerShell's literal string: double quotes
    // expand, and would rewrite `$env:USER` before the agent saw it.
    expect(
      argvFor({
        setup: 'npm ci',
        command: 'C:\\Program Files\\hd\\claude.cmd',
        args: ['--prompt=$env:USER']
      }).args
    ).toEqual([
      '-NoLogo',
      '-Command',
      `${guard}; & 'C:\\Program Files\\hd\\claude.cmd' '--prompt=$env:USER'; exit $LASTEXITCODE`
    ])
    // Without a setup nothing changes: interactive, and the line as typed.
    expect(argvFor({ command: 'npm run dev', viaShell: true })).toEqual({
      command: pwsh,
      args: ['-NoLogo', '-NoExit', '-Command', 'npm run dev']
    })
  })

  /**
   * `ssh`, `wsl` and `docker` are launchers on *this* machine carrying the
   * process to another one. Prepending a local shell would run the install
   * here, which is the opposite of what it is for — so those panes are left
   * exactly as they were.
   */
  it('does not put a local install in front of a pane that runs elsewhere', () => {
    onPlatform('linux')
    vi.stubEnv('SHELL', '/bin/bash')

    expect(argvFor({ setup: 'npm ci', command: 'ssh', args: ['-t', 'build-box', 'claude'] })).toEqual(
      { command: 'ssh', args: ['-t', 'build-box', 'claude'] }
    )
    expect(argvFor({ setup: 'npm ci', command: 'docker', args: ['exec', '-it', 'web-1'] })).toEqual({
      command: 'docker',
      args: ['exec', '-it', 'web-1']
    })
    expect(
      argvFor({ setup: 'npm ci', command: 'C:\\Windows\\System32\\wsl.exe', args: ['-d', 'Ubuntu'] })
    ).toEqual({ command: 'C:\\Windows\\System32\\wsl.exe', args: ['-d', 'Ubuntu'] })
  })
})

describe('disposeAll', () => {
  it('kills every session and empties the registry', () => {
    const { mgr, spawned } = harness()
    mgr.ensure(spec('a'), 100, 40)
    mgr.ensure(spec('b'), 100, 40)

    mgr.disposeAll()

    expect(spawned.every((p) => p.killed)).toBe(true)
    expect(mgr.runningIds()).toEqual([])
    expect(mgr.status('a')).toBeNull()
  })
})
