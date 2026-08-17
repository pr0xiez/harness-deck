import { describe, expect, it } from 'vitest'
import {
  decidePermission,
  devOriginFor,
  isTrustedPageUrl,
  originOf,
  type TrustedPage
} from './permissions'

const BUNDLED = 'file:///opt/harness-deck/resources/app/out/renderer/index.html'

const packaged: TrustedPage = { bundledPage: BUNDLED, devOrigin: null }
const dev: TrustedPage = { bundledPage: BUNDLED, devOrigin: 'http://localhost:5173' }

describe('isTrustedPageUrl', () => {
  it('trusts the bundled page exactly', () => {
    expect(isTrustedPageUrl(BUNDLED, packaged)).toBe(true)
  })

  it('trusts the bundled page with a query or hash', () => {
    expect(isTrustedPageUrl(`${BUNDLED}?smoke=1`, packaged)).toBe(true)
    expect(isTrustedPageUrl(`${BUNDLED}#/settings`, packaged)).toBe(true)
  })

  it('rejects every other local file — file: URLs all share one origin', () => {
    expect(isTrustedPageUrl('file:///home/user/Downloads/dropped.html', packaged)).toBe(false)
    expect(
      isTrustedPageUrl('file:///opt/harness-deck/resources/app/out/renderer/other.html', packaged)
    ).toBe(false)
  })

  it('rejects web content outright when no dev server is in use', () => {
    expect(isTrustedPageUrl('https://example.com/', packaged)).toBe(false)
    expect(isTrustedPageUrl('http://localhost:5173/', packaged)).toBe(false)
  })

  it('trusts only the dev server origin when one is configured', () => {
    expect(isTrustedPageUrl('http://localhost:5173/', dev)).toBe(true)
    expect(isTrustedPageUrl('http://localhost:5173/src/main.tsx', dev)).toBe(true)
    expect(isTrustedPageUrl('http://localhost:5174/', dev)).toBe(false)
    expect(isTrustedPageUrl('https://evil.example/', dev)).toBe(false)
  })

  it('rejects a missing or malformed URL', () => {
    expect(isTrustedPageUrl(undefined, packaged)).toBe(false)
    expect(isTrustedPageUrl(null, packaged)).toBe(false)
    expect(isTrustedPageUrl('', packaged)).toBe(false)
    expect(isTrustedPageUrl('not a url', packaged)).toBe(false)
  })

  it('rejects about:blank and data: pages — no page, no grant', () => {
    expect(isTrustedPageUrl('about:blank', packaged)).toBe(false)
    expect(isTrustedPageUrl('data:text/html,<script></script>', dev)).toBe(false)
  })
})

describe('decidePermission', () => {
  it('grants microphone and notifications to the app page', () => {
    for (const permission of ['media', 'audioCapture', 'notifications']) {
      expect(decidePermission(permission, BUNDLED, packaged)).toBe(true)
    }
  })

  it('denies clipboard-sanitized-write even to the app page — nothing shipped uses it', () => {
    expect(decidePermission('clipboard-sanitized-write', BUNDLED, packaged)).toBe(false)
  })

  it('denies unlisted permissions to everyone', () => {
    for (const permission of ['geolocation', 'camera', 'midi', 'pointerLock']) {
      expect(decidePermission(permission, BUNDLED, packaged)).toBe(false)
    }
  })

  it('denies allow-listed permissions to pages that are not the app', () => {
    expect(decidePermission('media', 'https://example.com/', packaged)).toBe(false)
    expect(decidePermission('audioCapture', 'file:///tmp/dropped.html', packaged)).toBe(false)
    expect(decidePermission('notifications', undefined, packaged)).toBe(false)
  })
})

describe('devOriginFor', () => {
  it('trusts the dev-server origin only in a dev build', () => {
    expect(devOriginFor(false, 'http://localhost:5173/')).toBe('http://localhost:5173')
  })

  it('ignores ELECTRON_RENDERER_URL entirely when packaged — the env is attacker-settable', () => {
    expect(devOriginFor(true, 'http://localhost:5173/')).toBe(null)
    expect(devOriginFor(true, 'https://evil.example/')).toBe(null)
  })

  it('returns null when the variable is unset or malformed', () => {
    expect(devOriginFor(false, undefined)).toBe(null)
    expect(devOriginFor(false, 'not a url')).toBe(null)
  })
})

describe('originOf', () => {
  it('extracts an origin from a well-formed URL', () => {
    expect(originOf('http://localhost:5173/anything?x=1')).toBe('http://localhost:5173')
  })

  it('returns null for missing or malformed input', () => {
    expect(originOf(undefined)).toBe(null)
    expect(originOf('')).toBe(null)
    expect(originOf('not a url')).toBe(null)
  })
})
