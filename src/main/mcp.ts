import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type {
  McpInventory,
  McpMutation,
  McpMutationResult,
  McpScope,
  McpSource,
  McpTarget
} from '@shared/mcp'
import { editConfig, inventoryEntries, record } from './mcp-config'
import { runProcess } from './process'
import { shellEnv } from './shell-env'

const MAX_BYTES = 1024 * 1024
const revision = (text: string | null): string =>
  text === null ? 'missing' : createHash('sha256').update(text).digest('hex')
interface SourceRecord {
  target: McpTarget
  source: McpSource
  parent: string
  at: number
}
interface SourceSpec {
  path: string
  scope: McpScope
  readOnly?: boolean
  text?: string | null
  error?: string
}
interface Options {
  home?: string
  env?: () => NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}

async function readBounded(path: string): Promise<string | null> {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
    const info = await handle.stat()
    if (!info.isFile() || info.size > MAX_BYTES) throw new Error('unsupported')
    const buffer = Buffer.alloc(MAX_BYTES + 1)
    let total = 0
    while (total <= MAX_BYTES) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null)
      if (!bytesRead) break
      total += bytesRead
    }
    if (total > MAX_BYTES) throw new Error('too large')
    return buffer.subarray(0, total).toString('utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error(
      'Cannot read this source. Check file permissions, format and the 1 MiB size limit.'
    )
  } finally {
    await handle?.close()
  }
}

// Only fixed code reaches the shell. The script and project path travel as argv.
// Python is used solely as a bounded file reader; no configured server is executed.
const WSL_READER = `import os,sys,json,subprocess
harness,cwd=sys.argv[1:3]
if cwd and not cwd.startswith('/'):
    cwd=subprocess.check_output(['wslpath','-u',cwd],text=True,timeout=5).strip()
if cwd and not os.path.isdir(cwd): raise ValueError('missing directory')
home=os.path.expanduser('~')
if harness=='claude' and os.environ.get('CLAUDE_CONFIG_DIR'): raise ValueError('custom Claude config directory unsupported')
base=os.environ.get('CODEX_HOME',os.path.join(home,'.codex')) if harness=='codex' else home
paths=[(os.path.join(base,'config.toml' if harness=='codex' else '.claude.json'),'user')]
if cwd:
    paths.append((os.path.join(cwd,'.codex','config.toml') if harness=='codex' else os.path.join(cwd,'.mcp.json'),'project'))
    if harness=='claude': paths.append((os.path.join(home,'.claude.json'),'local'))
result=[]
for path,scope in paths:
    item={'path':path,'scope':scope,'readOnly':True}
    try:
        if not os.path.exists(path): item['text']=None
        elif not os.path.isfile(path) or os.path.getsize(path)>1048576: item['error']='Source is not a regular file or exceeds 1 MiB.'
        else:
            with open(path,encoding='utf-8') as f: item['text']=f.read(1048577)
            if len(item['text'].encode('utf-8'))>1048576: item={'path':path,'scope':scope,'readOnly':True,'error':'Source exceeds 1 MiB.'}
    except Exception: item['error']='Cannot read this WSL source.'
    result.append(item)
print(json.dumps({'cwd':cwd,'sources':result}))`

/** Main-process registry: mutations accept opaque discovered IDs, never renderer file paths. */
export class McpManager {
  private sources = new Map<string, SourceRecord>()
  private writes = new Set<string>()
  private home: string
  private env: () => NodeJS.ProcessEnv
  private platform: NodeJS.Platform
  constructor(options: Options = {}) {
    this.home = options.home ?? homedir()
    this.env = options.env ?? shellEnv
    this.platform = options.platform ?? process.platform
  }

  async list(request: McpTarget): Promise<McpInventory> {
    const result: McpInventory = { target: request, sources: [], entries: [], notices: [] }
    if (
      !record(request) ||
      !['codex', 'claude'].includes(request.harness) ||
      !['native', 'wsl'].includes(request.environment) ||
      (request.cwd !== undefined &&
        (typeof request.cwd !== 'string' ||
          request.cwd.length > 4096 ||
          request.cwd.includes('\0')))
    ) {
      return { ...result, error: 'Invalid MCP target.' }
    }
    const target = { ...request }
    try {
      let specs: SourceSpec[]
      if (target.environment === 'wsl') {
        if (this.platform !== 'win32')
          return {
            ...result,
            error:
              'WSL inventory is available from the Windows app. Use Native when running inside Linux.'
          }
        const ran = await runProcess(
          'wsl.exe',
          [
            '--exec',
            'bash',
            '-lic',
            'exec python3 -c "$1" "$2" "$3"',
            'harness-deck-mcp',
            WSL_READER,
            target.harness,
            target.cwd ?? ''
          ],
          { timeout: 10000, maxBuffer: 8 * MAX_BYTES }
        )
        if (!ran.ok)
          throw new Error(
            'WSL discovery failed. The default distribution needs bash and Python 3; custom Claude configuration directories are not supported.'
          )
        let data: unknown
        try {
          data = JSON.parse(ran.stdout)
        } catch {
          throw new Error(
            'WSL returned an unreadable inventory. Check login-shell output and Python 3 availability.'
          )
        }
        if (!record(data) || !Array.isArray(data.sources) || typeof data.cwd !== 'string')
          throw new Error('WSL returned an unsupported inventory.')
        target.cwd = data.cwd || undefined
        specs = data.sources as SourceSpec[]
        result.notices.push(
          'Default WSL distribution · read-only. Edit WSL configuration from that environment. Ancestor project layers are not included.'
        )
      } else {
        if (target.cwd) {
          if (!isAbsolute(target.cwd) || !(await stat(target.cwd)).isDirectory())
            throw new Error('Choose an existing absolute project folder.')
          target.cwd = resolve(target.cwd)
        }
        const env = this.env()
        if (target.harness === 'claude' && env.CLAUDE_CONFIG_DIR)
          throw new Error(
            'Custom CLAUDE_CONFIG_DIR is not supported yet. Manage this configuration in Claude Code.'
          )
        const configHome =
          target.harness === 'codex' ? env.CODEX_HOME || join(this.home, '.codex') : this.home
        if (!isAbsolute(configHome))
          throw new Error('The configuration home must be an absolute path.')
        const userPath = join(
          configHome,
          target.harness === 'codex' ? 'config.toml' : '.claude.json'
        )
        specs = [{ path: userPath, scope: 'user' }]
        if (target.cwd) {
          const projectPath = join(
            target.cwd,
            target.harness === 'codex' ? '.codex/config.toml' : '.mcp.json'
          )
          if (projectPath !== userPath) specs.push({ path: projectPath, scope: 'project' })
          if (target.harness === 'claude') specs.push({ path: userPath, scope: 'local' })
          else {
            // Show existing ancestor layers separately; do not guess their effective trust/precedence.
            let ancestor = dirname(target.cwd)
            for (let depth = 0; depth < 32 && ancestor !== target.cwd; depth++) {
              const path = join(ancestor, '.codex/config.toml')
              if (path !== userPath) {
                const exists = await lstat(path)
                  .then(() => true)
                  .catch((error: NodeJS.ErrnoException) => error.code !== 'ENOENT')
                if (exists) specs.push({ path, scope: 'project', readOnly: true })
              }
              const parent = dirname(ancestor)
              if (parent === ancestor) break
              ancestor = parent
            }
          }
        }
      }
      result.target = target
      result.notices.push(
        'This inventory shows configuration files, not live session connections. Plugin, managed, account and launcher-specific definitions are not included; they may override these entries.'
      )
      result.notices.push(
        target.harness === 'codex'
          ? 'Project configuration loads only in trusted projects. Enable/disable changes this source; a running Codex session may need a restart.'
          : 'Local scope is private to the selected project; Project scope is shared through .mcp.json. Approvals, enable/disable and authentication are managed in Claude Code’s /mcp panel.'
      )
      for (const spec of specs) {
        const id = randomUUID()
        const source: McpSource = {
          id,
          scope: spec.scope,
          path: spec.path,
          revision: '',
          writable: target.environment === 'native' && !spec.readOnly
        }
        try {
          if (spec.error) throw new Error(spec.error)
          const text =
            target.environment === 'wsl' ? (spec.text ?? null) : await readBounded(spec.path)
          source.revision = revision(text)
          let parent = ''
          if (source.writable) {
            const link = await lstat(spec.path).catch((e: NodeJS.ErrnoException) => {
              if (e.code === 'ENOENT') return null
              throw e
            })
            if (link?.isSymbolicLink()) source.writable = false
            parent = await realpath(dirname(spec.path)).catch(() => '')
          }
          result.entries.push(
            ...inventoryEntries(
              text ?? '',
              target.harness,
              spec.scope,
              id,
              source.writable,
              target.cwd
            )
          )
          this.sources.set(id, { target, source: { ...source }, parent, at: Date.now() })
        } catch (error) {
          source.writable = false
          source.error =
            error instanceof Error && !('code' in error)
              ? error.message
              : 'Unable to read this source.'
        }
        result.sources.push(source)
      }
      while (this.sources.size > 256) this.sources.delete(this.sources.keys().next().value!)
      const names = new Set<string>()
      for (const entry of result.entries) {
        if (names.has(entry.name)) {
          result.notices.push(
            'Some server names occur in multiple sources. Each row is a separate definition; effective precedence is determined by the harness.'
          )
          break
        }
        names.add(entry.name)
      }
      return result
    } catch (error) {
      return {
        ...result,
        error:
          error instanceof Error && !('code' in error)
            ? error.message
            : 'Cannot discover this target. Check the project folder and configuration permissions.'
      }
    }
  }

  async mutate(request: McpMutation): Promise<McpMutationResult> {
    if (
      !record(request) ||
      typeof request.sourceId !== 'string' ||
      typeof request.revision !== 'string' ||
      !['add', 'edit', 'remove', 'toggle'].includes(request.action)
    )
      return { ok: false, error: 'Invalid MCP change.' }
    const saved = this.sources.get(request.sourceId)
    if (!saved || Date.now() - saved.at > 30 * 60 * 1000)
      return { ok: false, error: 'This inventory expired. Refresh before saving.' }
    const { source, target } = saved
    if (!source.writable || target.environment !== 'native')
      return { ok: false, error: 'This source is read-only.' }
    if (this.writes.has(source.path))
      return { ok: false, error: 'Another change is being saved. Refresh and try again.' }
    this.writes.add(source.path)
    let temp = ''
    try {
      const old = await readBounded(source.path)
      if (request.revision !== source.revision || revision(old) !== request.revision)
        throw new Error(
          'Configuration changed outside this editor. Refresh before saving; your change was not written.'
        )
      const info = await lstat(source.path).catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return null
        throw e
      })
      if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink > 1))
        throw new Error('Linked configuration files are read-only here.')
      if (saved.parent && (await realpath(dirname(source.path))) !== saved.parent)
        throw new Error('The configuration location changed. Refresh before saving.')
      const next = editConfig(old ?? '', target.harness, source.scope, request, target.cwd)
      if (Buffer.byteLength(next) > MAX_BYTES)
        throw new Error('The edited configuration exceeds 1 MiB.')
      if (next === old) return { ok: true }
      await mkdir(dirname(source.path), { recursive: true, mode: 0o700 })
      const nonce = randomUUID()
      temp = join(dirname(source.path), `.harness-deck-mcp-${nonce}.tmp`)
      const handle = await open(temp, 'wx', info ? info.mode & 0o777 : 0o600)
      try {
        await handle.writeFile(next)
        await handle.sync()
      } finally {
        await handle.close()
      }
      if (old !== null) {
        const backup = await open(`${source.path}.harness-deck-${nonce}.bak`, 'wx', 0o600)
        try {
          await backup.writeFile(old)
          await backup.sync()
        } finally {
          await backup.close()
        }
      }
      // Check immediately before replacement, after all other awaited writes.
      if (revision(await readBounded(source.path)) !== request.revision)
        throw new Error(
          'Configuration changed during save. Refresh and try again; the original was not replaced.'
        )
      await rename(temp, source.path)
      temp = ''
      if ((await readFile(source.path, 'utf8')) !== next)
        throw new Error(
          'The source changed immediately after saving. Refresh to see its current contents.'
        )
      this.sources.delete(request.sourceId)
      return { ok: true }
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error && !('code' in error)
            ? error.message
            : 'Unable to save the configuration. Check permissions and refresh before trying again.'
      }
    } finally {
      if (temp) await rm(temp, { force: true }).catch(() => undefined)
      this.writes.delete(source.path)
    }
  }
}
