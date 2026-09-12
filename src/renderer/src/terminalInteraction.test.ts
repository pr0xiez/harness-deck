import { describe, expect, it, vi } from 'vitest'
import { handleTerminalKey, terminalLinkHandler } from './terminalInteraction'

const copyKey = (init: KeyboardEventInit = {}, type = 'keydown'): KeyboardEvent =>
  new KeyboardEvent(type, { key: 'c', ctrlKey: true, cancelable: true, ...init })

describe('terminal copying', () => {
  it.each([false, true])('copies a selection without sending Ctrl+C (locked: %s)', (locked) => {
    const copy = vi.fn(async () => true)
    const event = copyKey()
    expect(handleTerminalKey(event, { getSelection: () => 'selected\ntext' }, locked, copy)).toBe(false)
    expect(copy).toHaveBeenCalledExactlyOnceWith('selected\ntext')
    expect(event.defaultPrevented).toBe(true)
  })

  it('passes Ctrl+C through to interrupt when nothing is selected', () => {
    const copy = vi.fn(async () => true)
    const event = copyKey()
    expect(handleTerminalKey(event, { getSelection: () => '' }, false, copy)).toBe(true)
    expect(event.defaultPrevented).toBe(false)
    expect(copy).not.toHaveBeenCalled()
  })

  it('still blocks input in a locked pane with no selection', () => {
    expect(handleTerminalKey(copyKey(), { getSelection: () => '' }, true, vi.fn())).toBe(false)
  })

  it('does not copy again on keyup or steal the app copy shortcuts', () => {
    const copy = vi.fn(async () => true)
    const term = { getSelection: () => 'selected' }
    for (const event of [copyKey({}, 'keyup'), copyKey({ shiftKey: true }), copyKey({ ctrlKey: false, metaKey: true })]) {
      expect(handleTerminalKey(event, term, false, copy)).toBe(false)
    }
    expect(copy).not.toHaveBeenCalled()
  })
})

it('routes terminal links to the external opener without browser navigation', () => {
  const openExternal = vi.fn()
  const event = new MouseEvent('click', { cancelable: true })
  terminalLinkHandler(openExternal).activate(event, 'https://example.com/docs')
  expect(openExternal).toHaveBeenCalledExactlyOnceWith('https://example.com/docs')
  expect(event.defaultPrevented).toBe(true)
})
