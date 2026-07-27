import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  feedUrl,
  parseLatestYml,
  pickInstaller,
  repoFromPackage,
  updateInfoFile
} from './update-feed'

/** Byte-for-byte what electron-builder 26 wrote for the arm64 mac build. */
const MAC_YML = `version: 0.1.0
files:
  - url: Harness-Deck-0.1.0-mac-arm64.zip
    sha512: rccF9PVRp7dYeoN79VEBvcNbcF+Yt4aZobUG00Zbl+3Q8QGQndkCOvZD3A09TcsgS1icH0uQ/bTkOPMfJ9XtAA==
    size: 120162341
  - url: Harness-Deck-0.1.0-mac-arm64.dmg
    sha512: ZZZF9PVRp7dYeoN79VEBvcNbcF+Yt4aZobUG00Zbl+3Q8QGQndkCOvZD3A09TcsgS1icH0uQ/bTkOPMfJ9XtAA==
    size: 121000000
path: Harness-Deck-0.1.0-mac-arm64.zip
sha512: rccF9PVRp7dYeoN79VEBvcNbcF+Yt4aZobUG00Zbl+3Q8QGQndkCOvZD3A09TcsgS1icH0uQ/bTkOPMfJ9XtAA==
releaseDate: '2026-07-27T15:50:19.744Z'
`

const WIN_YML = `version: 0.2.1
files:
  - url: Harness-Deck-0.2.1-win-x64.exe
    sha512: abc==
    size: 251658240
path: Harness-Deck-0.2.1-win-x64.exe
sha512: abc==
releaseDate: '2026-07-27T15:50:19.744Z'
`

describe('compareVersions', () => {
  it('orders the numeric parts before anything else', () => {
    expect(compareVersions('0.2.0', '0.1.9')).toBe(1)
    expect(compareVersions('0.1.9', '0.2.0')).toBe(-1)
    expect(compareVersions('1.0.0', '0.9.9')).toBe(1)
    expect(compareVersions('0.1.10', '0.1.9')).toBe(1)
  })

  it('treats equal versions as equal, with or without the v', () => {
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0)
    expect(compareVersions('v0.1.0', '0.1.0')).toBe(0)
    expect(compareVersions(' 0.1.0 ', '0.1.0')).toBe(0)
  })

  it('ranks a release above its own prereleases', () => {
    expect(compareVersions('0.2.0', '0.2.0-beta.1')).toBe(1)
    expect(compareVersions('0.2.0-beta.1', '0.2.0')).toBe(-1)
    expect(compareVersions('0.2.0-beta.2', '0.2.0-beta.1')).toBe(1)
  })

  it('pads a short version rather than reading undefined as newer', () => {
    expect(compareVersions('0.1', '0.1.0')).toBe(0)
    expect(compareVersions('1', '0.9.9')).toBe(1)
  })
})

describe('parseLatestYml', () => {
  it('reads the scalars and the file list', () => {
    const yml = parseLatestYml(MAC_YML)
    expect(yml.version).toBe('0.1.0')
    expect(yml.path).toBe('Harness-Deck-0.1.0-mac-arm64.zip')
    expect(yml.releaseDate).toBe('2026-07-27T15:50:19.744Z')
    expect(yml.files).toHaveLength(2)
    expect(yml.files[0]).toEqual({
      url: 'Harness-Deck-0.1.0-mac-arm64.zip',
      sha512: 'rccF9PVRp7dYeoN79VEBvcNbcF+Yt4aZobUG00Zbl+3Q8QGQndkCOvZD3A09TcsgS1icH0uQ/bTkOPMfJ9XtAA==',
      size: 120162341
    })
  })

  it('keeps base64 padding and the sha512 intact', () => {
    const yml = parseLatestYml(WIN_YML)
    expect(yml.sha512).toBe('abc==')
    expect(yml.files[0].sha512).toBe('abc==')
  })

  it('survives keys it has never seen', () => {
    const yml = parseLatestYml(`${WIN_YML}stagingPercentage: 10\nminimumSystemVersion: '10.13'\n`)
    expect(yml.version).toBe('0.2.1')
    expect(yml.files).toHaveLength(1)
  })

  it('falls back to path when a feed lists no files', () => {
    const yml = parseLatestYml("version: 1.0.0\npath: app-1.0.0.exe\nsha512: xyz==\n")
    expect(yml.files).toEqual([{ url: 'app-1.0.0.exe', sha512: 'xyz==', size: undefined }])
  })

  it('refuses a feed with nothing usable in it', () => {
    expect(() => parseLatestYml('<html>404</html>')).toThrow(/names no version/)
    expect(() => parseLatestYml('version: 1.0.0\n')).toThrow(/lists no files/)
  })
})

describe('pickInstaller', () => {
  it('takes the dmg on mac, not the zip electron-updater patches against', () => {
    const file = pickInstaller(parseLatestYml(MAC_YML), 'darwin')
    expect(file?.url).toBe('Harness-Deck-0.1.0-mac-arm64.dmg')
  })

  it('takes the exe on windows', () => {
    const file = pickInstaller(parseLatestYml(WIN_YML), 'win32')
    expect(file?.url).toBe('Harness-Deck-0.2.1-win-x64.exe')
    expect(file?.sha512).toBe('abc==')
  })

  it('reports nothing rather than offering the wrong platform an installer', () => {
    expect(pickInstaller(parseLatestYml(MAC_YML), 'win32')?.url).toBe(
      'Harness-Deck-0.1.0-mac-arm64.zip'
    )
    expect(pickInstaller({ version: '1.0.0', files: [] }, 'win32')).toBeNull()
  })
})

describe('updateInfoFile', () => {
  it('names the file electron-builder wrote for each platform', () => {
    expect(updateInfoFile('win32')).toBe('latest.yml')
    expect(updateInfoFile('darwin')).toBe('latest-mac.yml')
    expect(updateInfoFile('linux')).toBe('latest-linux.yml')
  })
})

describe('repoFromPackage', () => {
  it('accepts every shape npm allows for repository', () => {
    const expected = { owner: 'pr0xiez', repo: 'harness-deck' }
    expect(repoFromPackage({ repository: 'github:pr0xiez/harness-deck' })).toEqual(expected)
    expect(repoFromPackage({ repository: 'pr0xiez/harness-deck' })).toEqual(expected)
    expect(
      repoFromPackage({ repository: { url: 'git+https://github.com/pr0xiez/harness-deck.git' } })
    ).toEqual(expected)
    expect(repoFromPackage({ repository: { url: 'git@github.com:pr0xiez/harness-deck.git' } })).toEqual(
      expected
    )
  })

  it('returns nothing when there is nothing to poll', () => {
    expect(repoFromPackage({})).toBeNull()
    expect(repoFromPackage(null)).toBeNull()
    expect(repoFromPackage({ repository: 'harness-deck' })).toBeNull()
  })
})

describe('feedUrl', () => {
  it('points at the release asset for this platform', () => {
    expect(feedUrl({ owner: 'pr0xiez', repo: 'harness-deck' }, 'latest-main', 'win32')).toBe(
      'https://github.com/pr0xiez/harness-deck/releases/download/latest-main/latest.yml'
    )
  })

  it('resolves an installer against itself, so any tag works', () => {
    const feed = feedUrl({ owner: 'pr0xiez', repo: 'harness-deck' }, 'v0.2.1', 'win32')
    expect(new URL('Harness-Deck-0.2.1-win-x64.exe', feed).toString()).toBe(
      'https://github.com/pr0xiez/harness-deck/releases/download/v0.2.1/Harness-Deck-0.2.1-win-x64.exe'
    )
  })
})
