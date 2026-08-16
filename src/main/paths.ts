import { isAbsolute, relative, resolve } from 'node:path'

/**
 * Resolves `target` against `baseDir` and hands the result back only when it
 * is still inside that directory — `null` for anything that escapes, whether
 * by `..`, by arriving absolute, or by naming the directory itself.
 *
 * The check is `relative()` on the *resolved* paths rather than a prefix
 * comparison on strings, because `/tmp/shots` is a prefix of `/tmp/shotsX`
 * and a prefix check would wave the latter through (issue #29).
 */
export function resolveWithin(baseDir: string, target: string): string | null {
  const base = resolve(baseDir)
  const file = resolve(base, target)
  const rel = relative(base, file)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  return file
}
