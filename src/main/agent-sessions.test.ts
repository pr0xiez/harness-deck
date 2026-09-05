import { execFileSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentSessions, OPENCODE_SESSION_PLUGIN, POSIX_SESSION_HOOK } from './agent-sessions'
import type { PaneSpec } from '@shared/types'
import { agentLaunch } from '@shared/agent-session'

const one = '550e8400-e29b-41d4-a716-446655440000'
const two = '550e8400-e29b-41d4-a716-446655440001'
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hd-agent-session-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))
const pane = (command = 'codex', id = 'a'): PaneSpec => ({ id, command, args: [], cwd: dir })
const report = (spec: PaneSpec, id: string) => writeFileSync(spec.env!.HD_SESSION_FILE, JSON.stringify({ session_id: id }))

describe('durable per-pane session identity', () => {
  it.each(['codex', 'claude', 'opencode'])('resumes %s after an app restart', (agent) => {
    const spec = pane(agent), id = agent === 'opencode' ? 'ses_one' : one
    const started = new AgentSessions(dir).prepare(spec)
    report(started.spec, id)
    const resumed = new AgentSessions(dir).prepare(spec)
    expect(resumed.resumed).toBe(id)
    expect(resumed.spec.args).toContain(id)
    expect(resumed.spec.args).toContain(agent === 'codex' ? 'resume' : agent === 'claude' ? '--resume' : '--session')
  })
  it('does not confuse two panes in the same folder', () => {
    const sessions = new AgentSessions(dir)
    report(sessions.prepare(pane('codex', 'a')).spec, one)
    report(sessions.prepare(pane('codex', 'b')).spec, two)
    expect(sessions.prepare(pane('codex', 'b')).resumed).toBe(two)
    expect(sessions.prepare(pane('codex', 'a')).resumed).toBe(one)
  })
  it('ignores a stale hook after a replacement has claimed the pane', () => {
    const sessions = new AgentSessions(dir), spec = pane()
    const old = sessions.prepare(spec)
    report(old.spec, one)
    const replacement = sessions.prepare({ ...spec, sessionGeneration: 'new' })
    report(replacement.spec, two)
    report(old.spec, one)
    expect(sessions.prepare({ ...spec, sessionGeneration: 'new' }).resumed).toBe(two)
  })
  it('keeps the new conversation if the renderer quit before saving its new generation', () => {
    const sessions = new AgentSessions(dir), spec = pane()
    report(sessions.prepare(spec).spec, one)
    report(sessions.prepare({ ...spec, sessionGeneration: 'new' }).spec, two)
    // Disk layout still contains the older pane spec.
    expect(new AgentSessions(dir).prepare(spec).resumed).toBe(two)
  })
  it('does not replay prompts or fork options on restart', () => {
    const sessions = new AgentSessions(dir)
    const spec = { ...pane('opencode'), args: ['--continue', '--fork', '--prompt', 'launch once', '--model', 'a/b'] }
    report(sessions.prepare(spec).spec, 'ses_fork')
    expect(sessions.prepare(spec).spec.args).toEqual(['--model', 'a/b', '--session', 'ses_fork'])
  })
  it('fresh start discards an explicit original target, including its fallback ID', () => {
    const sessions = new AgentSessions(dir)
    const spec = { ...pane('opencode'), args: ['--session', 'ses_original'] }
    const fresh = sessions.prepare({ ...spec, sessionGeneration: 'new' })
    expect(fresh.spec.args).toEqual([])
    expect(() => sessions.prepare({ ...spec, sessionGeneration: 'new' })).toThrow('did not report')
  })
  it('fails visibly when the ID is missing or invalid; never chooses latest', () => {
    const sessions = new AgentSessions(dir), spec = pane()
    const started = sessions.prepare(spec)
    expect(() => sessions.prepare(spec)).toThrow('did not report')
    report(started.spec, 'latest')
    expect(() => sessions.prepare(spec)).toThrow('did not report')
    expect(() => sessions.prepare({ ...spec, sessionGeneration: 'fresh' })).not.toThrow()
  })
  it('rolls back a failed spawn so retry can launch normally', () => {
    const sessions = new AgentSessions(dir), spec = pane()
    sessions.prepare(spec).rollback()
    expect(() => sessions.prepare(spec)).not.toThrow()
  })
  it('requires a new fresh request to recover corrupt metadata', () => {
    const sessions = new AgentSessions(dir), spec = pane()
    const launched = sessions.prepare({ ...spec, sessionGeneration: 'first' })
    writeFileSync(join(dirname(launched.spec.env!.HD_SESSION_FILE), 'current.json'), '{broken')
    expect(() => sessions.prepare({ ...spec, sessionGeneration: 'first' })).toThrow()
    expect(() => sessions.prepare({ ...spec, sessionGeneration: 'second' })).not.toThrow()
  })
  it('changing folder/command starts an independent conversation', () => {
    const sessions = new AgentSessions(dir), spec = pane()
    report(sessions.prepare(spec).spec, one)
    expect(sessions.prepare({ ...spec, cwd: join(dir, 'other') }).resumed).toBeUndefined()
    expect(sessions.prepare({ ...spec, command: 'claude' }).resumed).toBeUndefined()
  })
  it('preassigns a different Claude UUID for every pane and preserves custom hooks', () => {
    const sessions = new AgentSessions(dir)
    const started = sessions.prepare({ ...pane('claude'), args: ['--settings', JSON.stringify({
      permissions: { defaultMode: 'default' }, hooks: { SessionStart: [{ hooks: [{ command: 'existing' }] }] }
    })] })
    const settings = JSON.parse(started.spec.args[started.spec.args.indexOf('--settings') + 1])
    expect(settings.permissions.defaultMode).toBe('default')
    expect(settings.hooks.SessionStart).toHaveLength(2)
    const other = sessions.prepare(pane('claude', 'b'))
    expect(JSON.parse(readFileSync(started.spec.env!.HD_SESSION_FILE, 'utf8')).session_id)
      .not.toBe(JSON.parse(readFileSync(other.spec.env!.HD_SESSION_FILE, 'utf8')).session_id)
  })
  it('translates only path variables for WSL and round trips hook arguments', () => {
    const spec = { ...pane('wsl.exe'), args: ['-e', 'bash', '-lic', 'cd "$HD_CWD" 2>/dev/null; exec codex'] }
    const sessions = new AgentSessions(dir, 'win32')
    const start = sessions.prepare(spec)
    expect(start.spec.env!.WSLENV).toContain('HD_SESSION_FILE/p')
    expect(agentLaunch(start.spec)?.args.join(' ')).toContain(JSON.stringify(POSIX_SESSION_HOOK))
    report(start.spec, one)
    expect(agentLaunch(sessions.prepare(spec).spec)?.args.slice(0, 2)).toEqual(['resume', one])
  })
  it('preserves existing OpenCode inline config and adds a local plugin', () => {
    const started = new AgentSessions(dir).prepare({ ...pane('opencode'), env: {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'a/b', plugin: ['existing'] })
    } })
    const config = JSON.parse(started.spec.env!.OPENCODE_CONFIG_CONTENT)
    expect(config.model).toBe('a/b')
    expect(config.plugin[0]).toBe('existing')
    expect(config.plugin[1]).toMatch(/^file:/)
  })
  it('executes the POSIX hook with spaces and shell metacharacters in its path', () => {
    const file = join(dir, 'a $literal session.json')
    const input = join(dir, 'input.json')
    writeFileSync(input, JSON.stringify({ session_id: one }))
    const fd = openSync(input, 'r')
    try {
      execFileSync('sh', ['-c', POSIX_SESSION_HOOK], {
        env: { ...process.env, HD_SESSION_FILE: file }, stdio: [fd, 'pipe', 'pipe'], timeout: 5000
      })
    } finally { closeSync(fd) }
    expect(JSON.parse(readFileSync(file, 'utf8')).session_id).toBe(one)
  })
  it('OpenCode plugin records roots and user-selected sessions, excluding subagents', async () => {
    const file = join(dir, 'plugin.json')
    // Execute the shipped module body with an isolated environment and real fs.
    const create = new Function('writeFileSync', 'renameSync', 'process',
      OPENCODE_SESSION_PLUGIN.replace("import { writeFileSync, renameSync } from 'node:fs';", '')
        .replace('export const', 'const') + '\nreturn HarnessDeckSession;')
    const { renameSync } = await import('node:fs')
    const plugin = await create(writeFileSync, renameSync, { env: { HD_SESSION_FILE: file } })({
      client: { session: { get: async ({ path }: any) => ({ data: { parentID: path.id === 'ses_child' ? 'ses_root' : undefined } }) } }
    })
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'ses_root' } } } })
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'ses_child', parentID: 'ses_root' } } } })
    await plugin['chat.message']({ sessionID: 'ses_child' })
    expect(JSON.parse(readFileSync(file, 'utf8')).session_id).toBe('ses_root')
    await plugin['chat.message']({ sessionID: 'ses_selected' })
    expect(JSON.parse(readFileSync(file, 'utf8')).session_id).toBe('ses_selected')
  })
})
