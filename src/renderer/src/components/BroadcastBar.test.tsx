import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, useDeck, type DeckWorkspace } from '../store'
import { BroadcastBar, fencedBlock } from './BroadcastBar'

/**
 * The selection hand-off (HD-17): the fence a pane's output gets wrapped in,
 * and the one-field queue the shortcut leaves it in for the bar to collect.
 */

const workspace: DeckWorkspace = {
  id: 'ws1',
  name: 'deck',
  cwd: '/repos/deck',
  accent: '#7aa2f7',
  panes: [],
  activePaneId: null,
  layout: 'grid',
  columns: 2,
  zoomedPaneId: null
}

/** What Ctrl+Shift+E leaves behind for the bar. */
const send = (selection: string): void =>
  act(() => useDeck.getState().setUi({ pendingInsert: fencedBlock(selection) }))

const box = (): HTMLTextAreaElement => screen.getByRole('textbox') as HTMLTextAreaElement

afterEach(() => {
  useDeck.setState({ settings: DEFAULT_SETTINGS, profiles: [] })
  useDeck.getState().setUi({ pendingInsert: null })
})

describe('fencedBlock', () => {
  it('keeps every line of a selection, between fences of its own', () => {
    expect(fencedBlock('Traceback:\n  File "x.py", line 3\nKeyError: id')).toBe(
      '\n```\nTraceback:\n  File "x.py", line 3\nKeyError: id\n```\n'
    )
  })

  /**
   * The fence has to survive the thing it is fencing, and a pane showing a
   * markdown file is the ordinary way to come across a ``` line.
   */
  it('reaches for tildes when the selection carries backtick fences', () => {
    expect(fencedBlock('```js\nconst a = 1\n```')).toBe('\n~~~\n```js\nconst a = 1\n```\n~~~\n')
  })

  it('outgrows both when the selection carries both', () => {
    expect(fencedBlock('```\n~~~\n````')).toBe('\n`````\n```\n~~~\n````\n`````\n')
  })

  /** A drag past the end of the last line brings blank space back with it. */
  it('does not keep the trailing blank a drag picked up', () => {
    expect(fencedBlock('npm ERR! 404\n\n  ')).toBe('\n```\nnpm ERR! 404\n```\n')
  })
})

describe('the target chips', () => {
  /**
   * The chip's label once stopped at the profile name, so a fresh pane opened
   * from a nameless profile rendered an empty chip. The command is the floor.
   */
  it('labels a fresh pane by its command when its profile has no name', () => {
    useDeck.setState({
      profiles: [
        {
          id: 'custom:dev',
          name: '',
          command: 'npm',
          args: [],
          kind: 'custom',
          icon: '»',
          accent: '#7aa2f7',
          available: true
        }
      ]
    })
    render(
      <BroadcastBar
        workspace={{
          ...workspace,
          panes: [
            {
              id: 'p1',
              profileId: 'custom:dev',
              command: 'npm run dev',
              args: [],
              cwd: '/repos/deck',
              status: 'running',
              epoch: 0
            }
          ]
        }}
      />
    )

    expect(screen.getByRole('button', { name: /npm run dev/ })).toBeTruthy()
  })
})

describe('the bar collecting a selection', () => {
  it('opens holding the block, with no blank line above it', () => {
    useDeck.getState().setUi({ pendingInsert: fencedBlock('KeyError: id') })
    render(<BroadcastBar workspace={workspace} />)

    expect(box().value).toBe('```\nKeyError: id\n```\n')
    // Cleared on the way in, so the same selection sent twice arrives twice.
    expect(useDeck.getState().ui.pendingInsert).toBeNull()
  })

  /**
   * The bar stays mounted for as long as it is open, so collecting on mount
   * alone would silently drop every selection after the first.
   */
  it('collects a second selection while it is already open', () => {
    render(<BroadcastBar workspace={workspace} />)
    send('first')
    send('second')

    expect(box().value).toBe('```\nfirst\n``` \n```\nsecond\n```\n')
  })

  it('keeps what was already typed, and starts the block on a line of its own', async () => {
    const user = userEvent.setup()
    render(<BroadcastBar workspace={workspace} />)
    await user.type(box(), 'why does this happen')
    send('KeyError: id')

    expect(box().value).toBe('why does this happen \n```\nKeyError: id\n```\n')
  })

  /**
   * Snippets and dictation reach the box through the same `insert()` the
   * selection now uses, and none of the three gets a rule of its own: text
   * arriving after a block joins to it exactly as it always has.
   */
  it('leaves the funnel snippets and dictation share alone', async () => {
    const user = userEvent.setup()
    useDeck.setState({ settings: { ...DEFAULT_SETTINGS, broadcastSnippets: ['explain this'] } })
    render(<BroadcastBar workspace={workspace} />)
    send('KeyError: id')
    await user.click(screen.getByTitle('Saved prompts'))
    await user.click(screen.getByTitle('explain this'))

    expect(box().value).toBe('```\nKeyError: id\n``` explain this')
  })
})
