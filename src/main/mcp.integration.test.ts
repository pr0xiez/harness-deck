import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpManager } from './mcp'
import { runProcess } from './process'

/** Opt-in checks against installed CLIs. Only disposable configuration homes are used. */
describe.runIf(process.env.HARNESS_DECK_MCP_CLI_TEST === '1')(
  'installed harness compatibility',
  () => {
    let fixture: string
    let manager: McpManager
    let env: NodeJS.ProcessEnv
    beforeEach(async () => {
      fixture = await mkdtemp(join(tmpdir(), 'harness-deck-mcp-cli-'))
      const config = join(fixture, '.codex')
      await mkdir(config)
      // Product-defined home variables have their normal meaning, isolated to this child process.
      env = {
        PATH: process.env.PATH,
        HOME: fixture,
        USERPROFILE: fixture,
        CODEX_HOME: config,
        DISABLE_AUTOUPDATER: '1',
        DISABLE_TELEMETRY: '1'
      }
      manager = new McpManager({ home: fixture, env: () => env })
    })
    afterEach(async () => {
      await rm(fixture, { recursive: true, force: true })
    })
    it('Codex reads a saved definition, its edited arguments and disabled state', async () => {
      let source = (await manager.list({ harness: 'codex', environment: 'native' })).sources[0]
      expect(
        await manager.mutate({
          sourceId: source.id,
          revision: source.revision,
          action: 'add',
          server: {
            name: 'deck-fixture',
            transport: 'stdio',
            command: '/usr/bin/true',
            args: ['space value']
          }
        })
      ).toEqual({ ok: true })
      source = (await manager.list({ harness: 'codex', environment: 'native' })).sources[0]
      expect(
        await manager.mutate({
          sourceId: source.id,
          revision: source.revision,
          action: 'toggle',
          name: 'deck-fixture',
          enabled: false
        })
      ).toEqual({ ok: true })
      const result = await runProcess('codex', ['mcp', 'get', 'deck-fixture', '--json'], {
        env,
        cwd: fixture,
        timeout: 15000
      })
      expect(result.ok).toBe(true)
      const data = JSON.parse(result.stdout)
      expect(data.enabled).toBe(false)
      expect(data.transport.command).toBe('/usr/bin/true')
      expect(data.transport.args).toEqual(['space value'])
    }, 20000)
    it.each(['user', 'local', 'project'] as const)(
      'Claude recognizes a saved %s definition in its own configuration commands',
      async (scope) => {
        const source = (
          await manager.list({ harness: 'claude', environment: 'native', cwd: fixture })
        ).sources.find((s) => s.scope === scope)!
        expect(
          await manager.mutate({
            sourceId: source.id,
            revision: source.revision,
            action: 'add',
            server: { name: 'deck-fixture', transport: 'stdio', command: '/usr/bin/true' }
          })
        ).toEqual({ ok: true })
        // remove verifies the CLI finds precisely this scope, without starting or connecting a server.
        const result = await runProcess(
          'claude',
          ['mcp', 'remove', 'deck-fixture', '--scope', scope],
          { env, cwd: fixture, timeout: 15000 }
        )
        expect(result.ok).toBe(true)
        expect(await readFile(source.path, 'utf8')).not.toContain('deck-fixture')
      },
      20000
    )
  }
)
