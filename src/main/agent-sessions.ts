import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { agentLaunch, continuationArgs, validSessionId, type ResumableAgent } from '@shared/agent-session'
import type { AgentActivity, PaneSpec } from '@shared/types'

// Stable hook definitions: per-invocation paths travel in the environment, so
// Codex's approval of this exact hook can be reused on subsequent launches.
export const POSIX_SESSION_HOOK = 'cat > "$HD_SESSION_FILE.tmp" && mv -f "$HD_SESSION_FILE.tmp" "$HD_SESSION_FILE"'
export const WINDOWS_SESSION_HOOK = 'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(
  "$p=$env:HD_SESSION_FILE; [IO.File]::WriteAllText($p+'.tmp', [Console]::In.ReadToEnd()); Move-Item -Force -LiteralPath ($p+'.tmp') -Destination $p",
  'utf16le'
).toString('base64')

// Separate from session identity: turn events must never overwrite the resume record.
export const POSIX_ACTIVITY_HOOK = 'cat > "$HD_ACTIVITY_FILE.$$.tmp" && mv -f "$HD_ACTIVITY_FILE.$$.tmp" "$HD_ACTIVITY_FILE.$$.json"; printf "{}"'
export const WINDOWS_ACTIVITY_HOOK = 'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(
  "$p=$env:HD_ACTIVITY_FILE; $t=$p+'.'+$PID+'.tmp'; [IO.File]::WriteAllText($t, [Console]::In.ReadToEnd()); Move-Item -Force -LiteralPath $t -Destination ($p+'.'+$PID+'.json'); [Console]::Write('{}')",
  'utf16le'
).toString('base64')

export function codexActivity(event: Record<string, unknown>): AgentActivity | undefined {
  switch (event.hook_event_name) {
    case 'SessionStart': return event.source === 'compact' ? 'working' : 'ready'
    case 'UserPromptSubmit':
    case 'PostToolUse': return 'working'
    case 'PreToolUse': return event.tool_name === 'request_user_input' ? 'waiting' : 'working'
    case 'PermissionRequest':
    case 'Stop': return 'waiting'
    case 'Interrupt':
    case 'SessionEnd': return 'ready'
    default: return undefined
  }
}

/** Loaded only by the OpenCode process launched for this pane. No global installation. */
export const OPENCODE_SESSION_PLUGIN = `import { writeFileSync, renameSync } from 'node:fs';
export const HarnessDeckSession = async ({ client }) => {
  const file = process.env.HD_SESSION_FILE;
  const save = (id) => {
    if (!file || !/^ses_[A-Za-z0-9_-]+$/.test(id || '')) return;
    try {
      writeFileSync(file + '.tmp', JSON.stringify({ session_id: id }));
      renameSync(file + '.tmp', file);
    } catch {}
  };
  return {
    event: async ({ event }) => {
      if (event.type === 'session.created' && !event.properties.info.parentID)
        save(event.properties.info.id);
    },
    'chat.message': async (input) => {
      const result = await client.session.get({ path: { id: input.sessionID } });
      if (result.data && !result.data.parentID) save(input.sessionID);
    }
  };
};
`

interface LaunchRecord { run: string }
export interface PreparedAgent {
  readActivity?: () => AgentActivity | undefined
  spec: PaneSpec
  resumed?: string
  rollback: () => void
}

function readJson(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return null
  if (statSync(file).size > 64 * 1024) throw new Error('Agent session record is too large')
  return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>
}

function atomicJson(file: string, value: unknown): void {
  writeFileSync(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 })
  renameSync(`${file}.tmp`, file)
}

function recordId(file: string, agent: ResumableAgent): string | undefined {
  const data = readJson(file)
  return validSessionId(agent, data?.session_id) ? data!.session_id as string : undefined
}

/**
 * Session identity is durable in the main process, independent of renderer
 * debounce/reloads. Each invocation writes a different file; an old hook can
 * never claim the new invocation. No directory-wide "most recent" matching.
 */
export class AgentSessions {
  private root: string
  constructor(userData: string, private platform = process.platform) {
    this.root = join(userData, 'agent-sessions')
  }

  prepare(spec: PaneSpec): PreparedAgent {
    const launch = agentLaunch(spec)
    if (!launch) return { spec, rollback: () => {} }
    const fingerprint = createHash('sha256').update(JSON.stringify([
      spec.id, spec.command, spec.args, spec.cwd, spec.env, spec.viaShell,
      ...(spec.openRouter ? [spec.openRouter] : [])
    ])).digest('hex')
    const dir = join(this.root, fingerprint)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const pointer = join(dir, 'current.json')
    const receipt = spec.sessionGeneration
      ? join(dir, `fresh-${createHash('sha256').update(spec.sessionGeneration).digest('hex')}.json`) : null
    const fresh = Boolean(receipt && !existsSync(receipt))
    let previous: Record<string, unknown> | null = null
    try { previous = readJson(pointer) } catch (error) { if (!fresh) throw error }
    let resumed: string | undefined
    if (previous && !fresh) {
      if (typeof previous.run !== 'string' || !/^[0-9a-f-]{36}$/.test(previous.run))
        throw new Error('Invalid saved agent session record. Use Start new session to recover.')
      resumed = recordId(join(dir, `${previous.run}.json`), launch.agent)
      if (!resumed) throw new Error(
        `Cannot resume: ${launch.agent} did not report this pane's session ID. ` +
        (launch.agent === 'codex' ? 'Trust the Harness Deck SessionStart hook in Codex (/hooks) when starting a new session. ' : '') +
        'Use Start new session, or edit the pane to supply an explicit resume command. No other conversation was opened.'
      )
    }
    let args = resumed || fresh
      ? continuationArgs(launch.agent, launch.args, resumed) : [...launch.args]
    const run = randomUUID()
    const file = join(dir, `${run}.json`)
    if (resumed) atomicJson(file, { session_id: resumed })
    const env = { ...spec.env, HD_SESSION_FILE: file } as Record<string, string>
    const windows = this.platform === 'win32' && !launch.wsl
    if (launch.wsl) {
      const inherited = spec.env?.WSLENV ?? process.env.WSLENV ?? ''
      env.WSLENV = [...inherited.split(':').filter((e) => e && !e.startsWith('HD_SESSION_FILE/')),
        'HD_SESSION_FILE/p'].join(':')
    }

    const activityFile = join(dir, `${run}.activity.json`)
    if (launch.agent === 'codex') {
      env.HD_ACTIVITY_FILE = activityFile
      if (launch.wsl) env.WSLENV += ':HD_ACTIVITY_FILE/p'

      // Inline hook config augments the CLI's other active hook sources. Do not
      // bypass hook trust or alter the user's config files or permission mode.
      const hook = windows ? WINDOWS_SESSION_HOOK : POSIX_SESSION_HOOK
      const activityHook = windows ? WINDOWS_ACTIVITY_HOOK : POSIX_ACTIVITY_HOOK
      for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop', 'Interrupt', 'SessionEnd']) {
        const hooks = event === 'SessionStart' ? [hook, activityHook] : [activityHook]
        args.push('-c', `hooks.${event}=[{hooks=[${hooks.map(command => `{type="command",command=${JSON.stringify(command)},timeout=3}`).join(',')}]}]`)
      }
    } else if (launch.agent === 'claude') {
      const hook = windows ? WINDOWS_SESSION_HOOK : POSIX_SESSION_HOOK
      // --settings is one override layer. Preserve its other settings/hooks.
      const settingsAt = args.findIndex((a) => a === '--settings' || a.startsWith('--settings='))
      let settings: Record<string, any> = {}
      if (settingsAt >= 0) {
        const inline = args[settingsAt].startsWith('--settings=')
        const raw = inline ? args[settingsAt].slice('--settings='.length) : args[settingsAt + 1]
        if (!raw) throw new Error('Missing Claude --settings value')
        if (launch.wsl && !raw.trim().startsWith('{'))
          throw new Error('Session tracking for WSL Claude requires --settings as inline JSON, not a file path.')
        settings = JSON.parse(raw.trim().startsWith('{') ? raw : readFileSync(resolve(spec.cwd, raw), 'utf8'))
        args.splice(settingsAt, inline ? 1 : 2)
      }
      settings.hooks = { ...settings.hooks, SessionStart: [
        ...(settings.hooks?.SessionStart ?? []), { hooks: [{ type: 'command', command: hook, timeout: 5 }] }
      ] }
      args.push('--settings', JSON.stringify(settings))
      // Reserve Claude's UUID before spawn. Hooks also track /clear and /resume.
      if (!resumed && !args.some((a) => /^(--resume|--continue|--session-id|-r|-c)(=|$)/.test(a))) {
        const id = randomUUID()
        args.push('--session-id', id)
        atomicJson(file, { session_id: id })
      }
    } else {
      const plugin = join(this.root, 'opencode-session.mjs')
      writeFileSync(plugin, OPENCODE_SESSION_PLUGIN, { mode: 0o600 })
      const raw = spec.env?.OPENCODE_CONFIG_CONTENT ?? process.env.OPENCODE_CONFIG_CONTENT
      const config = raw ? JSON.parse(raw) : {}
      let pluginUrl = pathToFileURL(plugin).href
      if (launch.wsl) {
        env.HD_SESSION_PLUGIN = plugin
        env.WSLENV += ':HD_SESSION_PLUGIN/p:OPENCODE_CONFIG_CONTENT'
        pluginUrl = 'file://{env:HD_SESSION_PLUGIN}'
      }
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ ...config, plugin: [...(config.plugin ?? []), pluginUrl] })
    }
    // Retain a user-specified exact target even if they disable hooks/plugins.
    // A fork must report its own ID before it can be resumed.
    if (!fresh && !existsSync(file) && !launch.args.some((a) => ['fork', '--fork', '--fork-session'].includes(a))) {
      const target = launch.agent === 'codex' && launch.args[0] === 'resume' ? launch.args[1]
        : launch.args.find((_, i) => i > 0 && ['--resume', '-r', '--session', '-s', '--session-id'].includes(launch.args[i - 1]))
      if (validSessionId(launch.agent, target)) atomicJson(file, { session_id: target })
    }
    atomicJson(pointer, { run } satisfies LaunchRecord)
    if (fresh) atomicJson(receipt!, { handled: true })
    return {
      spec: { ...spec, ...launch.apply(args), env }, resumed,
      ...(launch.agent === 'codex' ? { readActivity: () => {
        let activity: AgentActivity | undefined
        // One receipt per invocation: a child hook must not overwrite a root
        // Stop between polls. Completed receipts are consumed and removed.
        const prefix = `${run}.activity.json`
        const receipts = readdirSync(dir).filter(name => name === prefix ||
          (name.startsWith(prefix + '.') && name.endsWith('.json')))
          .map(name => ({ file: join(dir, name), time: statSync(join(dir, name)).mtimeMs }))
          .sort((a, b) => a.time - b.time)
        for (const receipt of receipts) {
          try {
            if (statSync(receipt.file).size > 1024 * 1024) continue
            const event = JSON.parse(readFileSync(receipt.file, 'utf8').replace(/^\uFEFF/, ''))
            const root = readJson(file)
            if (!event.session_id || event.session_id !== root?.session_id) continue
            // Codex child hooks share the parent's ID, but have their own transcript.
            if (root?.transcript_path && event.transcript_path !== root.transcript_path) continue
            activity = codexActivity(event) ?? activity
          } catch { /* A malformed hook cannot break PTY delivery. */ }
          finally { rmSync(receipt.file, { force: true }) }
        }
        return activity
      } } : {}),
      rollback: () => {
        atomicJson(pointer, previous)
        if (fresh) rmSync(receipt!, { force: true })
      }
    }
  }
}
