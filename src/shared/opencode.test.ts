import { describe, expect, it } from 'vitest'
import {
  isOpencodeProfile,
  opencodeArgs,
  opencodePaneSuffix,
  opencodeShellLine,
  opencodeWslScript
} from './opencode'

describe('opencodeArgs', () => {
  it('composes nothing for an empty launch', () => {
    expect(opencodeArgs({})).toEqual([])
    expect(opencodeArgs({ model: '  ' })).toEqual([])
  })

  it('passes the model and agent through', () => {
    expect(opencodeArgs({ model: 'anthropic/claude-sonnet-4', agent: 'build' })).toEqual([
      '--model',
      'anthropic/claude-sonnet-4',
      '--agent',
      'build'
    ])
  })

  it('continues the last session', () => {
    expect(opencodeArgs({ resume: 'continue' })).toEqual(['--continue'])
  })

  it('names the session to resume', () => {
    expect(opencodeArgs({ resume: { id: 'ses_abc' } })).toEqual(['--session', 'ses_abc'])
  })

  it('ignores a blank session id rather than sending --session with nothing', () => {
    expect(opencodeArgs({ resume: { id: ' ' } })).toEqual([])
  })

  it('only forks when there is something to fork', () => {
    expect(opencodeArgs({ fork: true })).toEqual([])
    expect(opencodeArgs({ fork: true, resume: 'continue' })).toEqual(['--continue', '--fork'])
    expect(opencodeArgs({ fork: true, resume: { id: 'ses_abc' } })).toEqual([
      '--session',
      'ses_abc',
      '--fork'
    ])
  })

  it('asks for auto-approval', () => {
    expect(opencodeArgs({ auto: true })).toEqual(['--auto'])
  })

  it('sends the prompt last', () => {
    expect(opencodeArgs({ prompt: 'fix the lint', auto: true })).toEqual([
      '--auto',
      '--prompt',
      'fix the lint'
    ])
  })

  it('trims whitespace around values', () => {
    expect(opencodeArgs({ model: ' anthropic/claude-sonnet-4 ' })).toEqual([
      '--model',
      'anthropic/claude-sonnet-4'
    ])
  })
})

describe('opencodeShellLine', () => {
  it('leaves plain values unquoted', () => {
    expect(opencodeShellLine({ model: 'anthropic/claude-sonnet-4' })).toBe(
      'opencode --model anthropic/claude-sonnet-4'
    )
  })

  it('single-quotes a prompt with spaces', () => {
    expect(opencodeShellLine({ prompt: 'fix the lint' })).toBe(
      `opencode --prompt 'fix the lint'`
    )
  })

  it('escapes a single quote inside a value', () => {
    expect(opencodeShellLine({ prompt: "it's broken" })).toBe(
      `opencode --prompt 'it'\\''s broken'`
    )
  })

  it('renames the binary for the inner line', () => {
    expect(opencodeShellLine({}, 'opencode-preview')).toBe('opencode-preview')
  })

  it('composes a full WSL launcher script', () => {
    expect(opencodeWslScript({ resume: 'continue', model: 'a/b' })).toBe(
      'cd "$HD_CWD" 2>/dev/null; exec opencode --model a/b --continue'
    )
  })
})

describe('opencodePaneSuffix', () => {
  it('prefers the model, tail only', () => {
    expect(opencodePaneSuffix({ model: 'anthropic/claude-sonnet-4', agent: 'plan' })).toBe(
      'claude-sonnet-4'
    )
  })

  it('falls back to the agent, then the prompt', () => {
    expect(opencodePaneSuffix({ agent: 'plan', prompt: 'ship it' })).toBe('plan')
    expect(opencodePaneSuffix({ prompt: 'ship it' })).toBe('ship it')
  })

  it('truncates a long prompt', () => {
    const long = 'x'.repeat(40)
    expect(opencodePaneSuffix({ prompt: long })).toBe(`${'x'.repeat(31)}…`)
  })

  it('names a resume, and nothing for a plain launch', () => {
    expect(opencodePaneSuffix({ resume: 'continue' })).toBe('last session')
    expect(opencodePaneSuffix({ resume: { id: 'ses_abc' } })).toBe('resumed')
    expect(opencodePaneSuffix({})).toBeNull()
  })
})

describe('isOpencodeProfile', () => {
  it('matches the native and WSL profiles only', () => {
    expect(isOpencodeProfile('agent:opencode')).toBe(true)
    expect(isOpencodeProfile('wsl:opencode')).toBe(true)
    expect(isOpencodeProfile('agent:claude')).toBe(false)
    expect(isOpencodeProfile('custom:opencode anything')).toBe(false)
  })
})
