/**
 * The permission policy for every web page in the app's session. Electron
 * grants each request itself — there is no Chromium consent prompt — so the
 * handler in index.ts is the only thing standing between a page and the
 * microphone. That makes *who is asking* as important as *what they ask for*:
 * a decision keyed on the permission name alone stays live for any content
 * that ever ends up in the window (a followed link, a dropped file, a future
 * injection bug), not just the app's own page.
 *
 * So a grant requires both halves: a permission on the short allow-list, and a
 * requesting page that is provably the app's own — the exact bundled
 * index.html, or the dev server it was told to load instead. Everyone else is
 * denied, whatever they ask for.
 */

/**
 * Dictation needs the microphone; nothing else has a reason to ask. Clipboard
 * writes are deliberately absent:
 * the app's own code writes through the harness.clipboard IPC bridge, never
 * `navigator.clipboard`, so a Web-API clipboard grant would serve only
 * whatever untrusted content ends up in the session.
 */
export const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set([
  'media',
  'audioCapture'
])

/** Where the app's own page legitimately lives. */
export interface TrustedPage {
  /** Full file: URL of the bundled renderer index.html. */
  bundledPage: string
  /** Origin of the dev server when ELECTRON_RENDERER_URL is in use, else null. */
  devOrigin: string | null
}

/** The origin of a URL, or null if it does not parse. */
export function originOf(rawUrl: string | undefined): string | null {
  if (!rawUrl) return null
  try {
    return new URL(rawUrl).origin
  } catch {
    return null
  }
}

/**
 * Is this URL the app's own page? For file: URLs the whole path must match the
 * bundled index.html — every file: URL shares one origin, so an origin check
 * would trust any local file that found its way into the window. For the dev
 * server, origin equality is the right bar: Vite serves the app and its
 * modules from many paths on one origin.
 */
export function isTrustedPageUrl(rawUrl: string | null | undefined, trust: TrustedPage): boolean {
  if (!rawUrl) return false
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }
  if (url.protocol === 'file:') {
    url.search = ''
    url.hash = ''
    return url.href === trust.bundledPage
  }
  return trust.devOrigin !== null && url.origin === trust.devOrigin
}

/** The whole policy: an allow-listed permission asked for by the app's own page. */
export function decidePermission(
  permission: string,
  pageUrl: string | null | undefined,
  trust: TrustedPage
): boolean {
  return ALLOWED_PERMISSIONS.has(permission) && isTrustedPageUrl(pageUrl, trust)
}
