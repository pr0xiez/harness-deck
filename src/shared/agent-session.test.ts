import { describe, expect, it } from 'vitest'
import { agentLaunch, continuationArgs, shellWords, validSessionId } from './agent-session'
import { opencodeWslScript } from './opencode'

const id = '550e8400-e29b-41d4-a716-446655440000'

describe('agent launch recognition', () => {
  it('recognizes native binaries and Windows npm shims', () => {
    expect(agentLaunch({ command: '/usr/bin/codex', args: [] })?.agent).toBe('codex')
    expect(agentLaunch({ command: 'C:\\tools\\claude.cmd', args: [] })?.agent).toBe('claude')
  })
  it('leaves shell commands and administrative/non-interactive launches alone', () => {
    for (const command of ['bash', 'ssh', 'echo codex', 'codex resume abc'])
      expect(agentLaunch({ command, args: [] })).toBeNull()
    for (const [command, args] of [['codex', ['exec', 'task']], ['claude', ['-p', 'task']],
      ['opencode', ['serve']], ['opencode', ['run', 'task']]] as const)
      expect(agentLaunch({ command, args: [...args] })).toBeNull()
  })
  it('round trips WSL launchers with quotes and literal shell metacharacters', () => {
    const args = ['-e', 'bash', '-lic', opencodeWslScript({ prompt: "don't run $(whoami); $HOME", model: 'a/b' })]
    const launch = agentLaunch({ command: 'wsl.exe', args })!
    expect(launch.args).toEqual(['--model', 'a/b', '--prompt', "don't run $(whoami); $HOME"])
    expect(agentLaunch(launch.apply(launch.args))?.args).toEqual(launch.args)
    expect(shellWords('opencode; evil')).toBeNull()
    expect(shellWords('opencode $(evil)')).toBeNull()
  })
})

describe('continuation commands', () => {
  it('resumes the exact Codex thread without reusing the initial input', () => {
    expect(continuationArgs('codex', ['-m', 'model', '-c', 'a="b"', '--search', 'initial task'], id))
      .toEqual(['resume', id, '-m', 'model', '-c', 'a="b"', '--search'])
    expect(continuationArgs('codex', ['fork', id, '--last', 'initial task'], id)).toEqual(['resume', id])
  })
  it('preserves Claude permissions and models, replacing resume and fork flags', () => {
    expect(continuationArgs('claude', ['--resume', id, '--fork-session', '--model', 'model',
      '--permission-mode', 'default', 'initial task'], id))
      .toEqual(['--model', 'model', '--permission-mode', 'default', '--resume', id])
  })
  it('removes OpenCode prompts and fork/continue options on both resume and fresh start', () => {
    const args = ['--model', 'a/b', '--continue', '--fork', '--prompt', 'do it', '--auto']
    expect(continuationArgs('opencode', args, 'ses_one'))
      .toEqual(['--model', 'a/b', '--auto', '--session', 'ses_one'])
    expect(continuationArgs('opencode', args)).toEqual(['--model', 'a/b', '--auto'])
  })
  it('rejects names and malformed IDs instead of resolving by recency', () => {
    expect(validSessionId('codex', 'latest')).toBe(false)
    expect(validSessionId('opencode', 'ses_../../other')).toBe(false)
    expect(() => continuationArgs('claude', [], '$(evil)')).toThrow('Invalid')
  })
})
