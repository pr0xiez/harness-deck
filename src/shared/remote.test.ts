import { describe, expect, it } from 'vitest'
import { buildRemote, commandName, parseRemote, type RemoteTarget } from './remote'

describe('buildRemote', () => {
  it('sends the pane folder across when no directory is pinned', () => {
    const { command, args } = buildRemote({ kind: 'ssh', host: 'build-box' }, 'claude --resume')
    expect(command).toBe('ssh')
    expect(args).toEqual([
      '-t',
      '-o',
      'SendEnv=HD_CWD',
      'build-box',
      'cd "$HD_CWD" 2>/dev/null; exec claude --resume'
    ])
  })

  it('drops the handover once a directory is pinned', () => {
    const { args } = buildRemote({ kind: 'ssh', host: 'me@box', dir: '/srv/app' }, 'claude')
    expect(args).toEqual(['-t', 'me@box', "cd '/srv/app' 2>/dev/null; exec claude"])
  })

  it('runs a login shell when no command is given', () => {
    const { args } = buildRemote({ kind: 'ssh', host: 'box' }, '   ')
    expect(args[args.length - 1]).toBe('cd "$HD_CWD" 2>/dev/null; exec "${SHELL:-/bin/sh}" -l')
  })

  it('forwards HD_CWD into a container by name, not by value', () => {
    const { command, args } = buildRemote({ kind: 'docker', host: 'web-1' }, 'codex')
    expect(command).toBe('docker')
    expect(args).toEqual([
      'exec',
      '-it',
      '-e',
      'HD_CWD',
      'web-1',
      'bash',
      '-lic',
      'cd "$HD_CWD" 2>/dev/null; exec codex'
    ])
  })

  it('takes the shell the user named for a container', () => {
    const { args } = buildRemote({ kind: 'docker', host: 'alpine-1', shell: 'sh' }, '')
    expect(args).toContain('sh')
    expect(args).not.toContain('bash')
  })

  // A path with a space or a quote in it reaches the far shell as one word or
  // the pane lands somewhere else entirely.
  it('quotes a directory the far shell would otherwise re-split', () => {
    const { args } = buildRemote({ kind: 'ssh', host: 'box', dir: "/srv/my app/o'brien" }, 'ls')
    expect(args[args.length - 1]).toBe(`cd '/srv/my app/o'\\''brien' 2>/dev/null; exec ls`)
  })
})

describe('parseRemote', () => {
  const roundTrip = (target: RemoteTarget, cmdline: string): void => {
    const built = buildRemote(target, cmdline)
    const read = parseRemote(built.command, built.args)
    if (!read) throw new Error(`${built.command} ${built.args.join(' ')} did not read back`)
    expect(read.cmdline).toBe(cmdline)
    expect(read.target.kind).toBe(target.kind)
    expect(read.target.host).toBe(target.host)
    expect(read.target.dir ?? '').toBe(target.dir ?? '')
    // The property that matters: reopening a pane in the dialog and pressing
    // Apply must hand back the argv it already had, defaults and all.
    expect(buildRemote(read.target, read.cmdline)).toEqual(built)
  }

  it('reads back what it wrote', () => {
    roundTrip({ kind: 'ssh', host: 'build-box' }, 'claude --resume')
    roundTrip({ kind: 'ssh', host: 'me@box', dir: '/srv/my app' }, '')
    roundTrip({ kind: 'docker', host: 'web-1' }, 'npm test')
    roundTrip({ kind: 'docker', host: 'web-1', dir: '/app', shell: 'sh' }, 'codex')
  })

  it('leaves an argv it did not write alone', () => {
    expect(parseRemote('ssh', ['build-box'])).toBeNull()
    expect(parseRemote('ssh', ['-t', 'box', 'top'])).toBeNull()
    expect(parseRemote('docker', ['ps'])).toBeNull()
    expect(parseRemote('claude', [])).toBeNull()
  })

  it('does not care how the binary was spelled', () => {
    const { args } = buildRemote({ kind: 'ssh', host: 'box' }, 'claude')
    expect(parseRemote('/usr/bin/ssh', args)?.target.host).toBe('box')
    expect(parseRemote('C:\\Windows\\System32\\OpenSSH\\ssh.exe', args)?.target.host).toBe('box')
  })
})

describe('commandName', () => {
  it('reduces a spelling of a binary to its name', () => {
    expect(commandName('wsl.exe')).toBe('wsl')
    expect(commandName('C:\\Windows\\System32\\wsl.exe')).toBe('wsl')
    expect(commandName('/usr/local/bin/docker')).toBe('docker')
    expect(commandName('/bin/zsh')).toBe('zsh')
    expect(commandName('')).toBe('')
  })
})
