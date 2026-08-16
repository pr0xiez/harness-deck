import { describe, expect, it } from 'vitest'
import { navigationAllowed } from './nav-guard'

/**
 * The guard's job is to keep the main window on the app's own page: whatever
 * it lets through is a document the preload bridge stays exposed to. So the
 * cases that matter are the impostors — look-alike hosts, other schemes,
 * neighboring file: paths, and strings that aren't URLs at all — in both of
 * the app's modes.
 */

const DEV = 'http://localhost:5173'
const APP_URL = 'file:///opt/app/resources/renderer/index.html'

describe('packaged (no dev server)', () => {
  it('allows exactly the bundled renderer page', () => {
    expect(navigationAllowed(APP_URL, null, APP_URL)).toBe(true)
  })

  it('denies an unrelated file: URL, even one that looks close', () => {
    expect(navigationAllowed('file:///tmp/evil.html', null, APP_URL)).toBe(false)
    expect(navigationAllowed(`${APP_URL}.evil.html`, null, APP_URL)).toBe(false)
    expect(navigationAllowed('file:///etc/passwd', null, APP_URL)).toBe(false)
  })

  it('denies web URLs', () => {
    expect(navigationAllowed('https://example.com/', null, APP_URL)).toBe(false)
    expect(navigationAllowed('http://localhost:5173/', null, APP_URL)).toBe(false)
  })

  it('denies non-document schemes', () => {
    expect(navigationAllowed('javascript:alert(1)', null, APP_URL)).toBe(false)
    expect(navigationAllowed('data:text/html,<script>1</script>', null, APP_URL)).toBe(false)
    expect(navigationAllowed('about:blank', null, APP_URL)).toBe(false)
  })
})

describe('development (dev server running)', () => {
  it('allows any path on the dev server itself', () => {
    expect(navigationAllowed(`${DEV}/`, DEV, APP_URL)).toBe(true)
    expect(navigationAllowed(`${DEV}/index.html?hmr=1#top`, DEV, APP_URL)).toBe(true)
  })

  it('denies a different port, scheme, or host — including look-alikes', () => {
    expect(navigationAllowed('http://localhost:5174/', DEV, APP_URL)).toBe(false)
    expect(navigationAllowed('https://localhost:5173/', DEV, APP_URL)).toBe(false)
    expect(navigationAllowed('http://localhost.evil.com:5173/', DEV, APP_URL)).toBe(false)
    expect(navigationAllowed('http://evil.com/?http://localhost:5173', DEV, APP_URL)).toBe(false)
  })

  it('denies file: URLs — dev mode has no business loading the bundle', () => {
    expect(navigationAllowed('file:///etc/passwd', DEV, APP_URL)).toBe(false)
    expect(navigationAllowed(APP_URL, DEV, APP_URL)).toBe(false)
  })
})

describe('opaque origins never match, even a literal "null" devOrigin', () => {
  it('denies data: and about:blank when devOrigin is the opaque-origin string', () => {
    expect(navigationAllowed('data:text/html,<script>1</script>', 'null', APP_URL)).toBe(false)
    expect(navigationAllowed('about:blank', 'null', APP_URL)).toBe(false)
  })
})

it('denies what does not parse as a URL', () => {
  expect(navigationAllowed('', null, APP_URL)).toBe(false)
  expect(navigationAllowed('not a url', DEV, APP_URL)).toBe(false)
})
