import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * How much of a pane's output survives a quit. Deliberately a quarter of the
 * live REPLAY_LIMIT in pty.ts: this exists so you can see what a pane was doing
 * when you last looked at it, not so you can audit a week of agent output — and
 * unlike the in-memory buffer, every byte of it is disk that stays allocated
 * until the pane is closed.
 */
export const SCROLLBACK_LIMIT = 128 * 1024

const SUFFIX = '.log'

/**
 * Pane tails on disk, one file per pane under `<userData>/scrollback`.
 *
 * Takes its directory rather than reaching for `app.getPath` so it stays clear
 * of `electron` — the unit tests drive a real directory through this, and they
 * run in plain Node (see vitest.config.ts).
 */
export class ScrollbackStore {
  private dir: string

  constructor(userData: string) {
    this.dir = join(userData, 'scrollback')
  }

  /** A pane with nothing on disk is the ordinary case, not an error. */
  read(id: string): string {
    try {
      return tail(readFileSync(this.fileFor(id), 'utf8'))
    } catch {
      return ''
    }
  }

  write(id: string, text: string): void {
    const body = tail(text)
    if (!body) {
      this.remove(id)
      return
    }
    const file = this.fileFor(id)
    try {
      mkdirSync(this.dir, { recursive: true })
      // The temp-file + rename idiom writeJsonAtomic uses in store.ts, without
      // its .bak copy: a tail interrupted mid-write is worth losing, and a
      // second copy of every pane's log is the one cost this must not carry.
      const tmp = `${file}.tmp`
      writeFileSync(tmp, body, 'utf8')
      renameSync(tmp, file)
    } catch (err) {
      console.error(`[scrollback] failed to write ${file}:`, err)
    }
  }

  remove(id: string): void {
    try {
      rmSync(this.fileFor(id), { force: true })
    } catch (err) {
      console.error(`[scrollback] failed to remove the log for ${id}:`, err)
    }
  }

  /**
   * Drops the logs of panes that are not in `keep`. Closing a pane deletes its
   * log, but a pane that went away while the app was not running — a state file
   * restored from a backup, a workspace deleted by a crash — would otherwise
   * keep its tail on disk for as long as the profile exists.
   */
  prune(keep: Iterable<string>): void {
    const wanted = new Set([...keep].map(fileName))
    let entries: string[]
    try {
      entries = readdirSync(this.dir)
    } catch {
      return /* nothing has been written yet */
    }
    for (const entry of entries) {
      // A `.tmp` is a write that never landed; it belongs to whichever pane
      // owns the log it was becoming.
      const name = entry.endsWith('.tmp') ? entry.slice(0, -'.tmp'.length) : entry
      if (!name.endsWith(SUFFIX) || wanted.has(name)) continue
      try {
        rmSync(join(this.dir, entry), { force: true })
      } catch (err) {
        console.error(`[scrollback] failed to prune ${entry}:`, err)
      }
    }
  }

  private fileFor(id: string): string {
    return join(this.dir, fileName(id))
  }
}

/**
 * Pane ids are generated, but they arrive here by way of a JSON file a user is
 * free to edit — so nothing that could walk out of the directory reaches `join`.
 */
function fileName(id: string): string {
  return `${id.replace(/[^a-zA-Z0-9._-]/g, '_')}${SUFFIX}`
}

const tail = (text: string): string =>
  text.length > SCROLLBACK_LIMIT ? text.slice(-SCROLLBACK_LIMIT) : text
