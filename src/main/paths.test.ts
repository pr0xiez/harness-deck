import { resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveWithin } from './paths'

/**
 * This is the containment check behind `app:capture` (issue #29): the renderer
 * hands over a string, and whatever this function returns is where the main
 * process writes a file. So the questions worth asking are the ways a string
 * can name somewhere it should not — `..` hops, absolute paths, and the
 * prefix trick where `/base` almost-matches `/basement`. Pure path algebra,
 * no filesystem: none of these directories need to exist.
 */

const base = resolve('/tmp/shots')

describe('resolveWithin', () => {
  it('drops a bare filename into the base directory', () => {
    expect(resolveWithin(base, 'shot.png')).toBe(resolve(base, 'shot.png'))
  })

  it('allows a subdirectory that has yet to be created', () => {
    expect(resolveWithin(base, 'nested/deeper/shot.png')).toBe(
      resolve(base, 'nested', 'deeper', 'shot.png')
    )
  })

  it('accepts an absolute path that lands inside the base', () => {
    const inside = resolve(base, 'shot.png')
    expect(resolveWithin(base, inside)).toBe(inside)
  })

  it('accepts a dotted path that comes back inside after resolution', () => {
    expect(resolveWithin(base, 'nested/../shot.png')).toBe(resolve(base, 'shot.png'))
  })

  it('refuses a path that climbs out with ..', () => {
    expect(resolveWithin(base, '../../home/user/.bashrc')).toBeNull()
  })

  it('refuses an absolute path somewhere else entirely', () => {
    expect(resolveWithin(base, resolve('/home/user/.bashrc'))).toBeNull()
  })

  /** The trap a string-prefix check falls into: `/tmp/shots` prefixes `/tmp/shotsX`. */
  it('refuses a sibling whose name merely starts with the base', () => {
    expect(resolveWithin(base, `${base}X${sep}shot.png`)).toBeNull()
  })

  it('refuses the base directory itself — it is a directory, not a file to write', () => {
    expect(resolveWithin(base, base)).toBeNull()
    expect(resolveWithin(base, '.')).toBeNull()
  })

  it('treats a relative base the same as its resolved form', () => {
    const resolved = resolveWithin('some/dir', 'shot.png')
    expect(resolved).toBe(resolve('some/dir', 'shot.png'))
  })
})
