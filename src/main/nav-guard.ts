/**
 * True when `url` is the app's own page — same-origin with the dev server when
 * one is running, a `file:` URL (the bundled renderer) otherwise. Anything
 * else, including URLs that don't parse, is denied: top-level navigation away
 * from the app's page would swap the document out while the preload bridge
 * stays exposed to whatever loads next.
 */
export function navigationAllowed(url: string, devOrigin: string | null): boolean {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return false
  }
  return devOrigin ? target.origin === devOrigin : target.protocol === 'file:'
}
