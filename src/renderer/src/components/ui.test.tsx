import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Modal, Toggle } from './ui'

/**
 * The two pieces of `ui.tsx` that have behaviour rather than markup: a dialog
 * that has to decide when a click means "dismiss me", and a switch whose whole
 * job is to report the value the user is asking for.
 */

describe('Modal', () => {
  it('closes on Escape, and keeps the key to itself', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    // Everything behind the dialog — the palette, the workspace shortcuts —
    // listens for Escape too, and none of them should also act on this one.
    const behind = vi.fn()
    window.addEventListener('keydown', behind)

    render(
      <Modal title="Pane settings" onClose={onClose}>
        <p>body</p>
      </Modal>
    )
    await user.keyboard('{Escape}')

    expect(onClose).toHaveBeenCalledOnce()
    expect(behind).not.toHaveBeenCalled()
    window.removeEventListener('keydown', behind)
  })

  it('closes when the mouse goes down on the backdrop behind it', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()

    render(
      <Modal title="Pane settings" onClose={onClose}>
        <p>body</p>
      </Modal>
    )
    const scrim = screen.getByRole('dialog').parentElement
    await user.click(scrim!)

    expect(onClose).toHaveBeenCalledOnce()
  })

  /** Selecting text in the dialog and letting go past its edge is not a dismiss. */
  it('stays put when the mouse went down inside it', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()

    render(
      <Modal title="Pane settings" onClose={onClose}>
        <p>body</p>
      </Modal>
    )
    await user.click(screen.getByText('body'))

    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('Toggle', () => {
  it('hands back the value the user is asking for, not the one it is showing', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()

    render(<Toggle checked label="Copy on select" onChange={onChange} />)
    // Found by what it reports to a screen reader: a switch that is currently on.
    await user.click(screen.getByRole('switch', { checked: true }))

    expect(onChange).toHaveBeenCalledWith(false)
  })
})
