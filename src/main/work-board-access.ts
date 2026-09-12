import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WorkAccess } from '@shared/work-board'
import { WorkBoardService } from './work-board'

const quote = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'"
/** The CLI owns no state; both transports call the main-process service. */
export class WorkBoardAccess {
  private server?: Server
  private pending: Promise<unknown> = Promise.resolve()
  private error?: string
  readonly discovery: string
  readonly bin: string
  private command: string
  private wslCommand?: string
  constructor(private dir: string, private board: WorkBoardService, executable: string, client: string, platform = process.platform) {
    this.discovery = join(dir, 'work-board-runtime.json')
    this.bin = join(dir, 'work-bin')
    mkdirSync(this.bin, { recursive: true, mode: 0o700 })
    // Each wrapper pins this profile's discovery path, never its rotating token.
    if (platform === 'win32') {
      this.command = join(this.bin, 'hd-work.cmd')
      const safe = (s: string): string => s.replace(/%/g, '%%')
      writeFileSync(this.command, `@echo off\r\nsetlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${safe(executable)}" "${safe(client)}" --discovery "${safe(this.discovery)}" %*\r\n`, { mode: 0o700 })
      this.wslCommand = join(this.bin, 'hd-work')
      writeFileSync(this.wslCommand, `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexport WSLENV="ELECTRON_RUN_AS_NODE/w:HD_WORK_WORKSPACE/w\${WSLENV:+:$WSLENV}"\nexec "$(wslpath -u ${quote(executable)})" ${quote(client)} --discovery ${quote(this.discovery)} "$@"\n`, { mode: 0o700 })
    } else {
      this.command = join(this.bin, 'hd-work')
      writeFileSync(this.command, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${quote(executable)} ${quote(client)} --discovery ${quote(this.discovery)} "$@"\n`, { mode: 0o700 })
    }
    rmSync(this.discovery, { force: true })
  }
  status(): WorkAccess { return { enabled: !!this.server, command: this.command, wslCommand: this.wslCommand, error: this.error } }
  async restore(): Promise<void> {
    try { if (JSON.parse(readFileSync(join(this.dir, 'work-board-access.json'), 'utf8')).enabled === true) await this.setEnabled(true) } catch { /* Default is off. */ }
  }
  setEnabled(enabled: boolean): Promise<WorkAccess> {
    const next = this.pending.then(async () => {
      try {
        if (enabled && !this.server) await this.start()
        if (!enabled) await this.stop()
        writeFileSync(join(this.dir, 'work-board-access.json'), JSON.stringify({ enabled }), { mode: 0o600 })
        this.error = undefined
      } catch (error) {
        await this.stop()
        this.error = error instanceof Error ? error.message : String(error)
      }
      return this.status()
    })
    this.pending = next
    return next
  }
  private async start(): Promise<void> {
    const token = randomBytes(32).toString('hex')
    const server = createServer(async (req, res) => {
      const respond = (code: number, body: unknown): void => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
      if (req.headers.origin || req.headers.authorization !== `Bearer ${token}`) { respond(401, { ok: false, error: 'Unauthorized' }); return }
      if (req.url !== '/board' || !['GET', 'POST'].includes(req.method || '')) { respond(404, { ok: false, error: 'Unknown operation' }); return }
      if (req.method === 'GET') { respond(200, this.board.snapshot()); return }
      try {
        const chunks: Buffer[] = []
        let bytes = 0
        for await (const chunk of req) {
          bytes += chunk.length
          if (bytes > 256 * 1024) { respond(413, { ok: false, error: 'Request too large' }); return }
          chunks.push(Buffer.from(chunk))
        }
        const result = this.board.mutate(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        respond(result.ok ? 200 : result.code === 'conflict' ? 409 : 400, result)
      } catch { if (!res.headersSent && !res.destroyed) respond(400, { ok: false, error: 'Invalid request' }) }
    })
    server.requestTimeout = 10000
    server.headersTimeout = 10000
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() }) })
    this.server = server
    const address = server.address()
    if (!address || typeof address === 'string') throw Error('Unable to start board access')
    writeFileSync(this.discovery, JSON.stringify({ port: address.port, token }), { mode: 0o600 })
  }
  async stop(): Promise<void> {
    const server = this.server
    this.server = undefined
    rmSync(this.discovery, { force: true })
    if (server) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })
  }
}
