import { describe, expect, it } from 'vitest'
import { paneLabel } from './paneLabel'

/**
 * The fallback chain every place a pane is named runs through. One copy of the
 * order lives in `paneLabel.ts`; this file pins each rung, and in particular
 * the last one — the raw command — which one drifted call site had lost.
 */

const pane = (over: Partial<Parameters<typeof paneLabel>[0]> = {}): Parameters<typeof paneLabel>[0] => ({
  command: 'claude',
  ...over
})

describe('paneLabel', () => {
  it('lets the name the user gave the pane outrank everything', () => {
    expect(
      paneLabel(pane({ name: 'reviewer', processTitle: 'claude — /repos/deck' }), { name: 'Claude Code' })
    ).toBe('reviewer')
  })

  it('falls back to the title the process reported about itself', () => {
    expect(paneLabel(pane({ processTitle: 'claude — /repos/deck' }), { name: 'Claude Code' })).toBe(
      'claude — /repos/deck'
    )
  })

  it('then to the profile the pane was opened from', () => {
    expect(paneLabel(pane(), { name: 'Claude Code' })).toBe('Claude Code')
  })

  it('and lands on the raw command when nothing else has a name', () => {
    expect(paneLabel(pane({ command: 'npm run dev' }))).toBe('npm run dev')
  })

  /** The BroadcastBar regression: a fresh pane whose profile carries no name. */
  it('still says the command for a nameless profile, rather than nothing', () => {
    expect(paneLabel(pane({ command: 'npm run dev' }), { name: '' })).toBe('npm run dev')
  })

  /** An OSC title of pure whitespace is stripped to `undefined` before it lands
      on the pane (see TerminalPane), so an empty string here means "unset". */
  it('treats empty strings as absent at every rung', () => {
    expect(paneLabel(pane({ name: '', processTitle: '', command: 'htop' }), { name: '' })).toBe('htop')
  })
})
