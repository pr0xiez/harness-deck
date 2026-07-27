import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { IPty } from '@lydell/node-pty'
import type { PaneSpec } from '@shared/types'
import { PtyManager, type Spawn } from './pty'

/** Matches FLUSH_MS in pty.ts — output is coalesced into one message per tick. */
const FLUSH_MS = 8
/** Matches REPLAY_LIMIT in pty.ts. */
const REPLAY_LIMIT = 512 * 1024

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
  /** Every `pty:data` payload for an id, concatenated. */
  dataFor(id: string): string
}

function harness(spawnImpl?: () => never): Harness {
  const sent: Harness['sent'] = []
  const spawned: FakePty[] = []
  const spawn: Spawn = () => {
    if (spawnImpl) spawnImpl()
    const proc = new FakePty()
    spawned.push(proc)
    return proc as unknown as IPty
  }
  const mgr = new PtyManager(
    (channel, payload) => sent.push({ channel, payload: payload as Record<string, unknown> }),
    spawn
  )
  return {
    mgr,
    sent,
    spawned,
    dataFor: (id) =>
      sent
        .filter((m) => m.channel === 'pty:data' && m.payload.id === id)
        .map((m) => String(m.payload.data))
        .join('')
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
    expect(messages[0].payload).toEqual({ id: 'a', data: 'one two three' })
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
