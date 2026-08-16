import { pathToFileURL } from 'node:url'

/**
 * Whether an IPC sender frame URL is the app's own UI, and therefore allowed to
 * call privileged channels. Anything that can run script in the window — a
 * dropped file, a page the window was navigated to — inherits the preload
 * bridge, so the bridge alone proves nothing; the frame URL is what says whose
 * document is calling.
 *
 * In dev the app loads from the vite server (`opts.devUrl`), which serves the
 * page and its assets from one origin — so the check is origin equality, not
 * URL equality. Packaged, the app loads exactly one file, so the check is the
 * exact `file:` URL of that file. The two modes are exclusive: when a dev URL
 * is configured, no `file:` sender is trusted, and vice versa.
 *
 * Comparisons run on parsed URLs. String prefixing would wave through
 * `localhost.evil.com`; and `file:` / `data:` URLs all report the opaque origin
 * "null", which would match *each other* — hence the http(s) requirement on the
 * dev branch. A URL that does not parse, or a missing one (Electron nulls
 * `senderFrame` once the frame is disposed), is untrusted.
 *
 * The caller must separately require the sender frame to be the window's main
 * frame — a hostile iframe under the real origin carries a trusted URL.
 */
export function trustedSenderUrl(
  url: string | undefined,
  opts: { devUrl?: string; appIndex: string }
): boolean {
  if (!url) return false
  let sender: URL
  try {
    sender = new URL(url)
  } catch {
    return false
  }

  if (opts.devUrl) {
    let dev: URL
    try {
      dev = new URL(opts.devUrl)
    } catch {
      // A dev URL that does not parse trusts nothing, rather than silently
      // falling back to the packaged-file rule the running app is not using.
      return false
    }
    return (
      (sender.protocol === 'http:' || sender.protocol === 'https:') &&
      sender.origin === dev.origin
    )
  }

  // `pathToFileURL` builds the same URL Electron's `loadFile` navigates to,
  // including the Windows drive-letter form — which a hand-built
  // `'file://' + path` string would get wrong. `new URL(...)` above has already
  // normalized any `..` segments in the sender, so equal hrefs mean the same
  // file, and traversals that merely *spell* the path differently still match.
  return sender.href === pathToFileURL(opts.appIndex).href
}
