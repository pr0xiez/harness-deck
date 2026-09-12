import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { McpMutation } from '@shared/mcp'
import { configValue, editConfig, inventoryEntries, serversFor } from './mcp-config'
import { McpManager } from './mcp'
import * as processTools from './process'

const mutation = (
  change: Omit<Extract<McpMutation, { action: 'edit' }>, 'sourceId' | 'revision'>
): McpMutation => ({ sourceId: 'source', revision: 'revision', ...change })

describe('format-preserving MCP edits', () => {
  it('edits TOML values without changing comments, credentials, unknown fields or neighboring tables', () => {
    const before =
      '# retain\r\nmodel = "test"\r\n[mcp_servers."my.server"]\r\ncommand = "original" # keep comment\r\nargs = [\r\n  "secret-value"\r\n]\r\ncustom = 17\r\n[mcp_servers."my.server".env]\r\nTOKEN = "secret-token"\r\n[mcp_servers.other]\r\nurl = "https://example.test/mcp"\r\n'
    const after = editConfig(
      before,
      'codex',
      'user',
      mutation({
        action: 'edit',
        name: 'my.server',
        server: {
          name: 'my.server',
          transport: 'stdio',
          command: 'updated',
          env: { REGION: 'west' }
        }
      })
    )
    expect(after).toContain('command = "updated" # keep comment\r\n')
    expect(after).toContain('args = [\r\n  "secret-value"\r\n]')
    expect(after).toContain('TOKEN = "secret-token"\r\n')
    expect(after).toContain('[mcp_servers.other]\r\nurl = "https://example.test/mcp"\r\n')
    expect(serversFor(after, 'codex', 'user')['my.server']).toEqual({
      command: 'updated',
      args: ['secret-value'],
      custom: 17,
      env: { TOKEN: 'secret-token', REGION: 'west' }
    })
  })
  it('adds a server, toggles it and removes all its nested tables without touching other servers', () => {
    const original = '# keep\n[mcp_servers.other]\ncommand = "other"\n'
    let text = editConfig(original, 'codex', 'user', {
      sourceId: '',
      revision: '',
      action: 'add',
      server: {
        name: 'new',
        transport: 'stdio',
        command: 'tool',
        args: ['a b', '$(touch nope)', 'x"y'],
        env: { TOKEN: 'kept' }
      }
    })
    expect(serversFor(text, 'codex', 'user').new).toEqual({
      command: 'tool',
      args: ['a b', '$(touch nope)', 'x"y'],
      env: { TOKEN: 'kept' }
    })
    text = editConfig(text, 'codex', 'user', {
      sourceId: '',
      revision: '',
      action: 'toggle',
      name: 'new',
      enabled: false
    })
    expect((serversFor(text, 'codex', 'user').new as Record<string, unknown>).enabled).toBe(false)
    text += '\n[mcp_servers.new.tools.read]\napproval_mode = "prompt"\n'
    text = editConfig(text, 'codex', 'user', {
      sourceId: '',
      revision: '',
      action: 'remove',
      name: 'new'
    })
    expect(serversFor(text, 'codex', 'user')).toEqual({ other: { command: 'other' } })
    expect(text.startsWith(original)).toBe(true)
  })
  it('preserves an inline env table when replacing an existing secret, and rejects unsupported insertions', () => {
    const text =
      '[mcp_servers.test]\ncommand="test"\nenv = { TOKEN = "secret", REGION = "west" } # comment\n'
    const change = mutation({
      action: 'edit',
      name: 'test',
      server: { name: 'test', transport: 'stdio', env: { TOKEN: 'updated' } }
    })
    expect(editConfig(text, 'codex', 'user', change)).toContain(
      'env = { TOKEN = "updated", REGION = "west" } # comment'
    )
    expect(() =>
      editConfig(
        text,
        'codex',
        'user',
        mutation({
          action: 'edit',
          name: 'test',
          server: { name: 'test', transport: 'stdio', env: { NEW: 'value' } }
        })
      )
    ).toThrow('inline table')
  })
  it('keeps Claude private project entries separate and preserves unknown fields and secrets', () => {
    const text =
      '{\n  "theme": "dark",\n  "mcpServers": {"same":{"type":"http","url":"https://user.test","headers":{"Authorization":"secret"}}},\n  "projects": {"/repo":{"trusted":true,"mcpServers":{"same":{"type":"stdio","command":"tool","env":{"TOKEN":"local-secret"}}}}}\n}\n'
    const after = editConfig(
      text,
      'claude',
      'local',
      mutation({
        action: 'edit',
        name: 'same',
        server: { name: 'same', transport: 'stdio', args: [] }
      }),
      '/repo'
    )
    expect(after).toContain('"theme": "dark"')
    expect(after).toContain('"Authorization":"secret"')
    expect(serversFor(after, 'claude', 'user').same).toEqual(
      serversFor(text, 'claude', 'user').same
    )
    expect(serversFor(after, 'claude', 'local', '/repo').same).toEqual({
      type: 'stdio',
      command: 'tool',
      env: { TOKEN: 'local-secret' },
      args: []
    })
  })
  it('redacts secrets in URL paths, userinfo, query, command arguments and errors', () => {
    const text = JSON.stringify({
      mcpServers: {
        http: {
          url: 'https://user:password@example.test/secret-path?token=secret-query',
          headers: { Authorization: 'secret-header' }
        },
        local: { command: '/secret-command', args: ['secret-arg'], env: { TOKEN: 'secret-env' } }
      }
    })
    const payload = JSON.stringify(inventoryEntries(text, 'claude', 'user', 'source', true))
    for (const secret of [
      'password',
      'secret-path',
      'secret-query',
      'secret-header',
      'secret-command',
      'secret-arg',
      'secret-env'
    ])
      expect(payload).not.toContain(secret)
    expect(payload).toContain('https://example.test/…')
    expect(() => configValue('{"secret": secret-literal}', 'claude')).toThrow(
      'Configuration is malformed'
    )
  })
  it('rejects duplicate keys, invalid schemas and unsupported TOML layouts', () => {
    expect(() => configValue('{"mcpServers":{},"mcpServers":{}}', 'claude')).toThrow('duplicate')
    expect(() => serversFor('{"mcpServers":[]}', 'claude', 'user')).toThrow('unsupported')
    const text = 'mcp_servers = { test = { command = "test" } }\n'
    expect(inventoryEntries(text, 'codex', 'user', '', true)[0].canEdit).toBe(false)
    expect(() =>
      editConfig(text, 'codex', 'user', {
        sourceId: '',
        revision: '',
        action: 'remove',
        name: 'test'
      })
    ).toThrow('layout')
  })
})

describe('MCP source discovery and writes', () => {
  let home: string
  let manager: McpManager
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'harness-deck-mcp-test-'))
    manager = new McpManager({ home, env: () => ({}), platform: 'linux' })
  })
  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })
  it('keeps WSL source identity read-only and passes project paths as arguments, not shell code', async () => {
    const project = 'C:\\repo with spaces $(touch sentinel)'
    const reader = vi.spyOn(processTools, 'runProcess').mockResolvedValueOnce({
      ok: true, error: null, stderr: '',
      stdout: JSON.stringify({ cwd: '/mnt/c/repo with spaces $(touch sentinel)', sources: [
        { path: '/home/wsl/.codex/config.toml', scope: 'user', readOnly: true, text: '[mcp_servers.test]\ncommand="tool"\n' }
      ] })
    })
    try {
      const windows = new McpManager({ home, env: () => ({}), platform: 'win32' })
      const result = await windows.list({ harness: 'codex', environment: 'wsl', cwd: project })
      expect(result.error).toBeUndefined()
      expect(result.sources[0].path).toBe('/home/wsl/.codex/config.toml')
      expect(result.sources[0].writable).toBe(false)
      expect(result.entries[0].canEdit).toBe(false)
      const args = reader.mock.calls[0][1]
      expect(args.at(-1)).toBe(project)
      expect(args[4]).not.toContain(project)
      expect(await windows.mutate({ action: 'remove', name: 'test', sourceId: result.sources[0].id, revision: result.sources[0].revision })).toMatchObject({ ok: false, error: 'This source is read-only.' })
    } finally { reader.mockRestore() }
  })

  it('creates missing user configuration, rereads it and keeps backups when editing', async () => {
    const first = await manager.list({ harness: 'codex', environment: 'native' })
    const source = first.sources[0]
    expect(source.revision).toBe('missing')
    expect(
      await manager.mutate({
        sourceId: source.id,
        revision: source.revision,
        action: 'add',
        server: { name: 'test', transport: 'http', url: 'https://example.test/mcp' }
      })
    ).toEqual({ ok: true })
    const second = await manager.list({ harness: 'codex', environment: 'native' })
    expect(second.entries[0].name).toBe('test')
    expect(
      await manager.mutate({
        sourceId: second.sources[0].id,
        revision: second.sources[0].revision,
        action: 'toggle',
        name: 'test',
        enabled: false
      })
    ).toEqual({ ok: true })
    const files = await readdir(join(home, '.codex'))
    expect(files.some((name) => name.endsWith('.bak'))).toBe(true)
    expect(files.some((name) => name.endsWith('.tmp'))).toBe(false)
    expect(
      (await manager.list({ harness: 'codex', environment: 'native' })).entries[0].enabled
    ).toBe(false)
  })
  it('does not overwrite an external edit or accept a renderer file path as a source ID', async () => {
    const file = join(home, '.claude.json')
    await writeFile(file, '{"mcpServers":{"test":{"command":"tool"}}}')
    const first = await manager.list({ harness: 'claude', environment: 'native' })
    const external = '{"mcpServers":{"test":{"command":"externally-edited"}}}'
    await writeFile(file, external)
    expect(
      await manager.mutate({
        sourceId: first.sources[0].id,
        revision: first.sources[0].revision,
        action: 'remove',
        name: 'test'
      })
    ).toMatchObject({ ok: false, error: expect.stringContaining('changed outside') })
    expect(await readFile(file, 'utf8')).toBe(external)
    expect(
      await manager.mutate({ sourceId: file, revision: 'missing', action: 'remove', name: 'test' })
    ).toMatchObject({ ok: false })
  })
  it('returns readable sources when another source is malformed', async () => {
    const project = join(home, 'repo')
    await mkdir(project)
    await writeFile(join(home, '.claude.json'), '{"mcpServers":{"user":{"command":"tool"}}}')
    await writeFile(join(project, '.mcp.json'), '{"secret-token":invalid}')
    const result = await manager.list({ harness: 'claude', environment: 'native', cwd: project })
    expect(result.error).toBeUndefined()
    expect(result.entries.map((e) => e.name)).toEqual(['user'])
    expect(result.sources.find((s) => s.scope === 'project')?.error).toBeTruthy()
    expect(JSON.stringify(result)).not.toContain('secret-token')
  })
  it('does not let a malformed ancestor hide a valid Codex project source', async () => {
    const project = join(home, 'parent/repo')
    await mkdir(join(project, '.codex'), { recursive: true })
    await mkdir(join(home, 'parent/.codex'), { recursive: true })
    await writeFile(join(home, 'parent/.codex/config.toml'), 'broken = [')
    await writeFile(join(project, '.codex/config.toml'), '[mcp_servers.project]\ncommand="tool"\n')
    const result = await manager.list({ harness: 'codex', environment: 'native', cwd: project })
    expect(result.entries.some((e) => e.name === 'project')).toBe(true)
    expect(result.sources.some((s) => Boolean(s.error))).toBe(true)
    expect(result.error).toBeUndefined()
  })
  it('keeps symlinked configuration read-only', async () => {
    const target = join(home, 'actual.json')
    await writeFile(target, '{"mcpServers":{"test":{"command":"tool"}}}')
    await symlink(target, join(home, '.claude.json'))
    const result = await manager.list({ harness: 'claude', environment: 'native' })
    expect(result.entries[0].canEdit).toBe(false)
    expect(
      await manager.mutate({
        sourceId: result.sources[0].id,
        revision: result.sources[0].revision,
        action: 'remove',
        name: 'test'
      })
    ).toMatchObject({ ok: false, error: 'This source is read-only.' })
  })
  it('isolates overridden Codex home and declines unsupported WSL requests on Linux', async () => {
    const alternate = join(home, 'alternate')
    await mkdir(alternate)
    await writeFile(join(alternate, 'config.toml'), '[mcp_servers.alternate]\ncommand="tool"\n')
    manager = new McpManager({ home, env: () => ({ CODEX_HOME: alternate }), platform: 'linux' })
    expect((await manager.list({ harness: 'codex', environment: 'native' })).entries[0].name).toBe(
      'alternate'
    )
    const result = await manager.list({ harness: 'codex', environment: 'wsl' })
    expect(result.sources).toEqual([])
    expect(result.error).toContain('Windows app')
  })
})
