import type { ExecFileException } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { runProcess } from './process'

/**
 * These drive real child processes — the module exists to standardise what
 * Node's `execFile` does at its edges, and a stubbed `execFile` would only
 * prove the file agrees with itself. The child is always the node that is
 * already running this suite, so there is nothing to install and no platform
 * where the binary means something different.
 *
 * The callers this was extracted from disagree about what an error means —
 * git reads stderr, the WSL probe keeps partial output, the shell probe wants
 * null — so what is pinned down here is the raw material they all adapt:
 * nothing thrown, output kept, the error passed along rather than interpreted.
 */

const node = process.execPath

/** A child that runs `script` — output is deterministic, exit code is ours. */
function inNode(script: string): [string, string[]] {
  return [node, ['-e', script]]
}

describe('runProcess', () => {
  it('hands back both streams from a clean exit, with no error', async () => {
    const [cmd, args] = inNode('process.stdout.write("out"); process.stderr.write("err")')
    const ran = await runProcess(cmd, args, { timeout: 10_000 })

    expect(ran).toEqual({ ok: true, stdout: 'out', stderr: 'err', error: null })
  })

  /**
   * The behaviour every caller leans on: a child that failed after saying
   * something has still said it. `git diff` exiting 1, a probe shell dying in
   * its own rc file — the output that arrived is the answer.
   */
  it('keeps the output a failing child produced before it exited', async () => {
    const [cmd, args] = inNode('process.stdout.write("partial"); process.exit(3)')
    const ran = await runProcess(cmd, args, { timeout: 10_000 })

    expect(ran.ok).toBe(false)
    expect(ran.stdout).toBe('partial')
    expect((ran.error as ExecFileException)?.code).toBe(3)
  })

  it('stops a child that outstays its timeout, keeping what it did say', async () => {
    const [cmd, args] = inNode('process.stdout.write("early"); setTimeout(() => {}, 60_000)')
    const ran = await runProcess(cmd, args, { timeout: 500 })

    expect(ran.ok).toBe(false)
    expect(ran.stdout).toBe('early')
    // Node reports a timeout through the kill it performed, not a named error.
    expect((ran.error as ExecFileException)?.killed).toBe(true)
  })

  /** A binary that is not there answers like everything else — never a rejection. */
  it('answers rather than throwing for a command that does not exist', async () => {
    const ran = await runProcess('hd-no-such-binary-anywhere', [], { timeout: 5000 })

    expect(ran.ok).toBe(false)
    expect(ran.stdout).toBe('')
    expect((ran.error as ExecFileException)?.code).toBe('ENOENT')
  })

  it('answers the same way for a cwd that is not there', async () => {
    const [cmd, args] = inNode('process.stdout.write("never")')
    const ran = await runProcess(cmd, args, { cwd: '/no/such/directory/anywhere', timeout: 5000 })

    expect(ran.ok).toBe(false)
    expect(ran.stdout).toBe('')
    expect(ran.error).toBeTruthy()
  })

  /** The WSL probe's case: bytes, so the caller can sniff UTF-16LE for itself. */
  it('hands the streams over as bytes when asked to', async () => {
    const [cmd, args] = inNode('process.stdout.write(Buffer.from([0x68, 0x00, 0x69, 0x00]))')
    const ran = await runProcess(cmd, args, { timeout: 10_000, encoding: 'buffer' })

    expect(Buffer.isBuffer(ran.stdout)).toBe(true)
    expect(ran.stdout).toEqual(Buffer.from([0x68, 0x00, 0x69, 0x00]))
  })

  it('keeps bytes a failing child produced, and empty bytes when nothing ran', async () => {
    const [cmd, args] = inNode('process.stdout.write("half"); process.exit(1)')
    const failed = await runProcess(cmd, args, { timeout: 10_000, encoding: 'buffer' })
    const missing = await runProcess('hd-no-such-binary-anywhere', [], {
      timeout: 5000,
      encoding: 'buffer'
    })

    expect(failed.stdout).toEqual(Buffer.from('half'))
    expect(Buffer.isBuffer(missing.stdout)).toBe(true)
    expect(missing.stdout.length).toBe(0)
  })

  /** git runs against `shellEnv()`, so the option has to actually reach the child. */
  it('runs the child in the environment and directory it was given', async () => {
    const [cmd, args] = inNode('process.stdout.write(process.env.HD_PROBE + ":" + process.cwd())')
    const ran = await runProcess(cmd, args, {
      cwd: process.cwd(),
      env: { ...process.env, HD_PROBE: 'reached' },
      timeout: 10_000
    })

    expect(ran.ok).toBe(true)
    expect(ran.stdout).toBe(`reached:${process.cwd()}`)
  })
})
