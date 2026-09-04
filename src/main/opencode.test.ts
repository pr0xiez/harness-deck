import { describe, expect, it } from 'vitest'
import type { OpencodeRunner } from './opencode'
import { assembleInfo, parseAgents, parseModels, parseSessions, powershellShimLine } from './opencode'

const ok = (out: string): OpencodeRunner => async () => out

describe('parseModels', () => {
  it('keeps provider/model lines, one per name', () => {
    expect(
      parseModels(
        [
          'opencode/big-pickle',
          'openrouter/~anthropic/claude-fable-latest',
          'anthropic/claude-sonnet-4'
        ].join('\n')
      )
    ).toEqual([
      'opencode/big-pickle',
      'openrouter/~anthropic/claude-fable-latest',
      'anthropic/claude-sonnet-4'
    ])
  })

  it('drops prose, blank lines and bare words', () => {
    expect(parseModels('Loading models…\n\nanthropic/claude-sonnet-4\n  \nprovider\n')).toEqual([
      'anthropic/claude-sonnet-4'
    ])
  })

  it('deduplicates', () => {
    expect(parseModels('a/b\na/b\n')).toEqual(['a/b'])
  })
})

describe('parseAgents', () => {
  it('reads the `name (kind)` headers', () => {
    expect(parseAgents('build (primary)\n  [...]\nexplore (subagent)\n  [...]\n')).toEqual([
      'build',
      'explore'
    ])
  })

  it('ignores everything that is not a header', () => {
    expect(parseAgents('{"permission":"*"}\nplan (primary)\n  [\n  {\n  }\n  ]\n')).toEqual([
      'plan'
    ])
  })
})

describe('parseSessions', () => {
  it('reads the JSON array and sorts by recency', () => {
    const json = JSON.stringify([
      { id: 'ses_old', title: 'older', updated: 1000, directory: '/repo' },
      { id: 'ses_new', title: 'newer', updated: 2000 }
    ])
    expect(parseSessions(json)).toEqual([
      { id: 'ses_new', title: 'newer', updated: 2000 },
      { id: 'ses_old', title: 'older', updated: 1000, directory: '/repo' }
    ])
  })

  it('fills in a title for a session that has none', () => {
    expect(parseSessions('[{"id":"ses_x"}]')).toEqual([{ id: 'ses_x', title: 'Untitled' }])
  })

  it('answers empty for anything that is not an array of sessions', () => {
    expect(parseSessions('')).toEqual([])
    expect(parseSessions('not json')).toEqual([])
    expect(parseSessions('{"id":"ses_x"}')).toEqual([])
    expect(parseSessions('[null,1,{"nope":true}]')).toEqual([])
  })
})

describe('powershellShimLine', () => {
  it('quotes the shim path and every argument', () => {
    expect(powershellShimLine('C:\\Program Files\\nodejs\\opencode.cmd', ['models'])).toBe(
      `& 'C:\\Program Files\\nodejs\\opencode.cmd' 'models'`
    )
  })

  it('doubles single quotes inside a path', () => {
    expect(powershellShimLine("C:\\od'd\\opencode.cmd", [])).toBe(`& 'C:\\od''d\\opencode.cmd' `)
  })
})

describe('assembleInfo', () => {
  it('collects all three lists from one runner', async () => {
    const run: OpencodeRunner = async (args) => {
      if (args[0] === 'models') return 'a/b\n'
      if (args[0] === 'agent') return 'build (primary)\n'
      return '[{"id":"ses_1","title":"t","updated":1}]'
    }
    const info = await assembleInfo(run)
    expect(info).toEqual({
      models: ['a/b'],
      agents: ['build'],
      sessions: [{ id: 'ses_1', title: 't', updated: 1 }]
    })
  })

  it('keeps the lists that worked when one command fails', async () => {
    const run: OpencodeRunner = async (args) => {
      if (args[0] === 'session') throw new Error('no such table')
      if (args[0] === 'agent') return 'build (primary)\n'
      return ''
    }
    const info = await assembleInfo(run)
    expect(info.models).toEqual([])
    expect(info.agents).toEqual(['build'])
    expect(info.sessions).toEqual([])
    expect(info.error).toBeUndefined()
  })

  it('reports an error when all three came back empty', async () => {
    const info = await assembleInfo(ok(''))
    expect(info.error).toMatch(/did not answer/)
  })
})
