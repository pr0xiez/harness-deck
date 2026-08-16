import { describe, expect, it } from 'vitest'
import { chainFor, cmdExpansionHazard, flavourOf, quoteFor } from './shell'

describe('flavourOf', () => {
  it('is posix everywhere but Windows, whatever the shell is called', () => {
    expect(flavourOf('darwin', '/bin/zsh')).toBe('posix')
    expect(flavourOf('linux', '/usr/bin/fish')).toBe('posix')
    expect(flavourOf('linux', 'cmd.exe')).toBe('posix')
  })

  it('splits Windows by the one shell that is not PowerShell', () => {
    expect(flavourOf('win32', 'C:\\Windows\\System32\\cmd.exe')).toBe('cmd')
    expect(flavourOf('win32', 'C:\\WINDOWS\\SYSTEM32\\CMD.EXE')).toBe('cmd')
    expect(flavourOf('win32', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe('powershell')
  })
})

describe('quoteFor', () => {
  it('keeps an apostrophe-ridden message one word in each grammar', () => {
    expect(quoteFor("don't", 'posix')).toBe(`'don'\\''t'`)
    expect(quoteFor("don't", 'powershell')).toBe(`'don''t'`)
    expect(quoteFor('say "when"', 'cmd')).toBe('"say ""when"""')
  })
})

describe('cmdExpansionHazard', () => {
  it('flags any %, because cmd expands %VAR% inside double quotes too', () => {
    expect(cmdExpansionHazard('fix %USERNAME% handling')).toBe(true)
    // Even an unpaired % is a hazard: whether it expands depends on what
    // variables happen to exist on the machine that runs the line.
    expect(cmdExpansionHazard('100% done')).toBe(true)
  })

  it('passes ordinary prose, which is every message this ever sees', () => {
    expect(cmdExpansionHazard("don't ship what you can't read")).toBe(false)
    expect(cmdExpansionHazard('')).toBe(false)
  })

  it('is the guard quoteFor cannot be: quoting leaves the % in place', () => {
    // The point of the predicate — cmd's quoting has no effect on variable
    // expansion, so the quoted form still carries the hazard verbatim.
    expect(quoteFor('fix %PATH% handling', 'cmd')).toContain('%PATH%')
  })
})

describe('chainFor', () => {
  it('is && where the shell has it, and nothing when there are no commands', () => {
    expect(chainFor([], 'posix')).toBe('')
    expect(chainFor(['a', 'b'], 'posix')).toBe('a &&\nb')
    expect(chainFor(['a', 'b'], 'cmd')).toBe('a && b')
  })

  it('nests the PowerShell form so a skipped step cannot leave a stale zero', () => {
    expect(chainFor(['a', 'b', 'c'], 'powershell')).toBe(
      'a; if ($LASTEXITCODE -eq 0) { b; if ($LASTEXITCODE -eq 0) { c } }'
    )
  })
})
