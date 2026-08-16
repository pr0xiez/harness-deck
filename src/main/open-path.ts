import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * The decision behind `app:openPath`, kept out of index.ts (and free of
 * `electron`) so it can be driven directly in tests the way `worktreePathAllowed`
 * is in git.test.ts — the userData-containment, manifest and symlink cases were
 * previously only reachable by clicking through the built app.
 *
 * Everything here is async over `fs/promises`: the path arrives from a renderer
 * that fully controls it, and a UNC path or a stalled network mount must not
 * park the main process's event loop — every IPC channel, the menu and the
 * window — while it resolves.
 */

/** win32 compares paths case-insensitively, like `samePath` in git.ts. */
function normPath(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

/**
 * `path.relative`-based containment, so neither a `..` segment nor a sibling
 * that merely shares the prefix (`/data-evil` against `/data`) counts as
 * inside. Both `base` and `candidate` are expected to already be realpath'd by
 * the caller: a symlinked *base* — a Linux home on another volume,
 * `/home/dev -> /data/dev`, which is common — would otherwise fail every
 * comparison even for a file that really is inside it, because only the
 * candidate side had been resolved.
 */
export function isInsideDir(base: string, candidate: string): boolean {
  const rel = relative(normPath(base), normPath(candidate))
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

export interface OpenPathPolicy {
  /** `app.getPath('userData')` — the app's own data folder. */
  userData: string
  /** `manifestPath()` from updater.ts — HD_UPDATE_MANIFEST can move it, and it may not exist yet. */
  manifestPath: string
}

export type OpenPathDecision =
  | { ok: true; target: string; /** A directory is revealed, never launched. */ reveal: boolean }
  | { ok: false }

/**
 * Whether `rawPath` is somewhere `app:openPath` may act on, and how.
 *
 * A directory is always *revealed* rather than opened: on macOS an application
 * bundle — `.app`, `.workflow`, `.prefPane`, `.bundle` — is a directory too, and
 * `shell.openPath` on darwin goes through `NSWorkspace openURL:`, the same path
 * a Finder double-click takes, i.e. it launches the bundle. Both legitimate
 * directory call sites in this app (`CompareView.tsx`'s `pane.cwd` links) only
 * ever mean "show me this folder", and `shell.showItemInFolder` gets that
 * without ever launching anything, on every platform — so every directory goes
 * that way rather than singling out bundle extensions.
 *
 * A file has to resolve inside `userData` or be the update manifest.
 */
export async function resolveOpenPath(rawPath: string, policy: OpenPathPolicy): Promise<OpenPathDecision> {
  // `resolve('')` is `process.cwd()` — a directory, and one nobody meant to
  // name. Reject anything that isn't already an absolute path before any I/O.
  if (!rawPath || !isAbsolute(rawPath)) return { ok: false }

  try {
    // realpath, so a symlink cannot stand in for something outside the allowed
    // locations, and a missing path fails here instead of at the OS.
    const target = await realpath(resolve(rawPath))
    const info = await stat(target)
    if (info.isDirectory()) return { ok: true, target, reveal: true }

    const userData = await realpath(policy.userData)
    if (isInsideDir(userData, target)) return { ok: true, target, reveal: false }

    // The manifest may not exist yet (no update has ever been checked for) —
    // that is a normal "not the manifest" answer, not a failure of this check.
    const manifest = await realpath(policy.manifestPath).catch(() => null)
    if (manifest !== null && normPath(target) === normPath(manifest)) {
      return { ok: true, target, reveal: false }
    }

    return { ok: false }
  } catch {
    return { ok: false }
  }
}
