import { describe, expect, it } from 'vitest'
import { navigationAllowed } from './nav-guard'

/**
 * The guard's job is to keep the main window on the app's own page: whatever
 * it lets through is a document the preload bridge stays exposed to. So the
 * cases that matter are the impostors — look-alike hosts, other schemes, and
 * strings that aren't URLs at all — in both of the app's modes.
 */

const DEV = 'http://localhost:5173'

describe('packaged (no dev server)', () => {
  it('allows the bundled renderer page', () => {
    expect(navigationAllowed('file:///opt/app/resources/renderer/index.html', null)).toBe(true)
  })

  it('denies web URLs', () => {
    expect(navigationAllowed('https://example.com/', null)).toBe(false)
    expect(navigationAllowed('http://localhost:5173/', null)).toBe(false)
  })

  it('denies non-document schemes', () => {
    expect(navigationAllowed('javascript:alert(1)', null)).toBe(false)
    expect(navigationAllowed('data:text/html,<script>1</script>', null)).toBe(false)
    expect(navigationAllowed('about:blank', null)).toBe(false)
  })
})

describe('development (dev server running)', () => {
  it('allows any path on the dev server itself', () => {
    expect(navigationAllowed(`${DEV}/`, DEV)).toBe(true)
    expect(navigationAllowed(`${DEV}/index.html?hmr=1#top`, DEV)).toBe(true)
  })

  it('denies a different port, scheme, or host — including look-alikes', () => {
    expect(navigationAllowed('http://localhost:5174/', DEV)).toBe(false)
    expect(navigationAllowed('https://localhost:5173/', DEV)).toBe(false)
    expect(navigationAllowed('http://localhost.evil.com:5173/', DEV)).toBe(false)
    expect(navigationAllowed('http://evil.com/?http://localhost:5173', DEV)).toBe(false)
  })

  it('denies file: URLs — dev mode has no business loading the bundle', () => {
    expect(navigationAllowed('file:///etc/passwd', DEV)).toBe(false)
  })
})

it('denies what does not parse as a URL', () => {
  expect(navigationAllowed('', null)).toBe(false)
  expect(navigationAllowed('not a url', DEV)).toBe(false)
})
