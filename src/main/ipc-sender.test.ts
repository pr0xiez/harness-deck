import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { trustedSenderUrl } from './ipc-sender'

/**
 * The predicate is pure string-in/boolean-out, so every case runs in plain
 * Node. The senders worth testing are the ones an attacker would actually
 * present: look-alike hosts, scheme and port swaps, opaque-origin schemes, and
 * file URLs that are almost — but not — the bundled index.
 */

/** Built the same way index.ts builds it, so the tests exercise the real shape. */
const appIndex = join('/opt', 'harness-deck', 'out', 'renderer', 'index.html')
// The href, not the path: hand-mangled variants below are spliced from this so
// they stay valid on Windows, where pathToFileURL adds the drive-letter form.
const indexUrl = pathToFileURL(appIndex).href

const dev = { devUrl: 'http://localhost:5173/', appIndex }
const prod = { appIndex }

describe('trustedSenderUrl in dev', () => {
  it('accepts the dev URL itself', () => {
    expect(trustedSenderUrl('http://localhost:5173/', dev)).toBe(true)
  })

  it('accepts other paths on the dev origin — vite serves /index.html and assets', () => {
    expect(trustedSenderUrl('http://localhost:5173/index.html', dev)).toBe(true)
    expect(trustedSenderUrl('http://localhost:5173/assets/index-B3xQ.js?v=1#top', dev)).toBe(true)
  })

  it('rejects a look-alike host that merely starts with the dev host', () => {
    expect(trustedSenderUrl('http://localhost.evil.com:5173/', dev)).toBe(false)
  })

  it('rejects a different port on the right host', () => {
    expect(trustedSenderUrl('http://localhost:5174/', dev)).toBe(false)
  })

  it('rejects an https sender for an http dev URL, and the reverse', () => {
    expect(trustedSenderUrl('https://localhost:5173/', dev)).toBe(false)
    expect(
      trustedSenderUrl('http://localhost:5173/', { ...dev, devUrl: 'https://localhost:5173/' })
    ).toBe(false)
  })

  it('rejects the packaged file URL while the app is loading from the dev server', () => {
    expect(trustedSenderUrl(indexUrl, dev)).toBe(false)
  })

  it('rejects everything when the configured dev URL does not parse', () => {
    const broken = { ...dev, devUrl: 'not a url' }
    expect(trustedSenderUrl('http://localhost:5173/', broken)).toBe(false)
    expect(trustedSenderUrl(indexUrl, broken)).toBe(false)
  })
})

describe('trustedSenderUrl packaged', () => {
  it('accepts exactly the bundled index.html', () => {
    expect(trustedSenderUrl(indexUrl, prod)).toBe(true)
  })

  it('accepts a differently spelled path to the same file', () => {
    // `..` that round-trips to the same file: URL parsing normalizes it away,
    // so this is the bundled index, not a traversal.
    expect(
      trustedSenderUrl(indexUrl.replace('renderer/index.html', 'renderer/../renderer/index.html'), prod)
    ).toBe(true)
  })

  it('rejects a sibling file in the renderer directory', () => {
    expect(trustedSenderUrl(indexUrl.replace(/index\.html$/, 'other.html'), prod)).toBe(false)
  })

  it('rejects a file whose URL merely starts with the trusted one', () => {
    expect(trustedSenderUrl(`${indexUrl}.evil.html`, prod)).toBe(false)
  })

  it('rejects a traversal that normalizes to a different file', () => {
    expect(
      trustedSenderUrl(indexUrl.replace('renderer/index.html', 'renderer/../evil/index.html'), prod)
    ).toBe(false)
  })

  it('rejects an http sender when the app loaded from disk', () => {
    expect(trustedSenderUrl('http://localhost:5173/', prod)).toBe(false)
  })
})

describe('trustedSenderUrl regardless of mode', () => {
  // All of these carry the opaque origin "null" (or no origin at all), which is
  // exactly why the dev branch demands http(s) and the packaged branch an exact
  // file URL — two "null" origins must never satisfy each other.
  const hostile = ['data:text/html,<script>1</script>', 'javascript:void(0)', 'about:blank', 'chrome://gpu']

  it.each([dev, prod])('rejects opaque-origin schemes', (opts) => {
    for (const url of hostile) expect(trustedSenderUrl(url, opts)).toBe(false)
  })

  it.each([dev, prod])('rejects undefined, empty, and unparseable senders', (opts) => {
    expect(trustedSenderUrl(undefined, opts)).toBe(false)
    expect(trustedSenderUrl('', opts)).toBe(false)
    expect(trustedSenderUrl('not a url', opts)).toBe(false)
    expect(trustedSenderUrl('//localhost:5173/', opts)).toBe(false)
  })
})
