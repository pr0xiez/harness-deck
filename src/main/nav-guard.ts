/**
 * True when `url` is the app's own page — same-origin with the dev server
 * when one is running, exactly `appUrl` (the bundled renderer's file: URL)
 * otherwise. Anything else, including URLs that don't parse, is denied:
 * top-level navigation away from the app's page would swap the document out
 * while the preload bridge stays exposed to whatever loads next.
 *
 * Packaged mode intentionally does not accept "any file: URL" — every file:
 * document shares one origin, so an origin check there would trust any local
 * file that found its way into the window (a dropped file is enough). Only
 * an exact match on the app's own resolved path is safe.
 */
export function navigationAllowed(
  url: string,
  devOrigin: string | null,
  appUrl: string
): boolean {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return false
  }
  if (devOrigin) {
    // Every opaque origin (data:, about:, and — notably — file:) serializes
    // to the literal string "null". Reject it outright rather than compare
    // it against devOrigin: a devOrigin that was itself somehow opaque
    // must not admit an unrelated opaque target.
    return target.origin !== 'null' && target.origin === devOrigin
  }
  return target.href === appUrl
}
