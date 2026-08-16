import { execFile, type ExecFileException } from 'node:child_process'

/**
 * The one way the main process runs a command and waits for its output. git,
 * the WSL probe and the login-shell probe each grew a copy of this wrapper, and
 * the copies disagreed in the places that only show up in the field — what
 * happens to output that arrived before a timeout killed the child, and whether
 * a missing binary rejects, throws, or answers.
 *
 * So the contract is: this never throws and never rejects. Whatever happened —
 * a clean exit, a non-zero exit, a timeout, no such binary at all — the caller
 * gets the same shape back, with everything the child managed to say before it
 * stopped saying it. Callers decide what an error means for them; several of
 * them treat partial output as a perfectly good answer, and this is the only
 * place that could have thrown it away.
 */

export interface RanProcess<T extends string | Buffer = string> {
  /** True only for a clean zero exit that stayed inside every limit. */
  ok: boolean
  /** Everything the child wrote, up to the moment it exited or was stopped. */
  stdout: T
  stderr: T
  /**
   * Why `ok` is false, verbatim from Node: the non-zero exit, the timeout's
   * SIGTERM, the ENOENT for a binary that is not there. Null on success.
   */
  error: Error | null
}

export interface RunProcessOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Milliseconds before the child is sent SIGTERM. Unset means wait forever. */
  timeout?: number
  /** Bytes of output kept before Node stops the child; Node's default is 1 MiB. */
  maxBuffer?: number
}

/**
 * `encoding: 'buffer'` is for the one caller that cannot ask for a string:
 * wsl.exe answers some subcommands in UTF-16LE, and the caller has to see the
 * bytes to work out which decoding it is looking at.
 */
export function runProcess(
  cmd: string,
  args: string[],
  options: RunProcessOptions & { encoding: 'buffer' }
): Promise<RanProcess<Buffer>>
export function runProcess(
  cmd: string,
  args: string[],
  options?: RunProcessOptions & { encoding?: undefined }
): Promise<RanProcess<string>>
export function runProcess(
  cmd: string,
  args: string[],
  { cwd, env, timeout, maxBuffer, encoding }: RunProcessOptions & { encoding?: 'buffer' } = {}
): Promise<RanProcess<string | Buffer>> {
  const empty = (): string | Buffer => (encoding === 'buffer' ? Buffer.alloc(0) : '')
  return new Promise((done) => {
    const finish = (
      err: ExecFileException | null,
      stdout?: string | Buffer,
      stderr?: string | Buffer
    ): void =>
      done({ ok: !err, stdout: stdout ?? empty(), stderr: stderr ?? empty(), error: err ?? null })

    const opts = { cwd, env, timeout, maxBuffer, windowsHide: true }
    const child =
      encoding === 'buffer'
        ? execFile(cmd, args, { ...opts, encoding: 'buffer' }, finish)
        : execFile(cmd, args, opts, finish)
    // No binary on PATH at all, or a cwd that went away between the check and
    // the spawn — neither reaches the callback on every platform. The promise
    // settles once, so a platform that reports both ways is still one answer.
    child.on('error', (err) => finish(err))
  })
}
