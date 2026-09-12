import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it } from 'vitest'
import type { WorkBoard, WorkItem } from '@shared/work-board'
import { harness } from '../test/harness'
import { useDeck } from '../store'
import { WorkBoardPage } from './WorkBoardPage'
const item: WorkItem = { id: 'one', title: 'An idea', description: 'Details', status: 'ideas', workspaceId: null, revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
const board = (i = item, revision = 1): WorkBoard => ({ version: 1, revision, items: [i] })
beforeEach(() => {
  useDeck.setState({ workspaces: [] })
  harness.work.snapshot.mockResolvedValue({ ok: true, board: board() })
  harness.work.access.mockResolvedValue({ enabled: false, command: '/deck/hd-work' })
})
it('creates cards and moves them using the keyboard-accessible control', async () => {
  const user = userEvent.setup()
  render(<WorkBoardPage />)
  await screen.findByText('An idea')
  harness.work.mutate.mockResolvedValue({ ok: true, board: board({ ...item, status: 'done', revision: 2 }, 2) })
  await user.selectOptions(screen.getByRole('combobox', { name: 'Move An idea to' }), 'done')
  expect(harness.work.mutate).toHaveBeenCalledWith({ operation: 'move', id: 'one', expectedRevision: 1, status: 'done' })
  expect(within(screen.getByRole('region', { name: 'Done' })).getByText('An idea')).toBeTruthy()
  await user.click(screen.getByRole('button', { name: 'Add card' }))
  await user.type(screen.getByLabelText('Title'), 'New work')
  await user.click(screen.getByRole('button', { name: 'Save card' }))
  expect(harness.work.mutate).toHaveBeenLastCalledWith({ operation: 'create', title: 'New work', description: '', workspaceId: null, status: 'ideas' })
})
it('preserves a draft during an external edit and requires reloading before saving', async () => {
  const user = userEvent.setup()
  render(<WorkBoardPage />)
  await user.click(await screen.findByRole('button', { name: /An idea Details/ }))
  await user.clear(screen.getByLabelText('Title'))
  await user.type(screen.getByLabelText('Title'), 'My unsaved draft')
  act(() => harness.work.onChanged.mock.calls.at(-1)![0](board({ ...item, title: 'Agent edit', revision: 2 }, 2)))
  expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('My unsaved draft')
  expect((screen.getByRole('button', { name: 'Save card' }) as HTMLButtonElement).disabled).toBe(true)
  await user.click(screen.getByRole('button', { name: 'Reload current card' }))
  expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Agent edit')
})
it('ignores old initial snapshots and retains a failed edit', async () => {
  let resolve!: (value: any) => void
  harness.work.snapshot.mockReturnValue(new Promise(r => { resolve = r }))
  render(<WorkBoardPage />)
  act(() => harness.work.onChanged.mock.calls.at(-1)![0](board({ ...item, title: 'Latest' }, 3)))
  await act(async () => resolve({ ok: true, board: board() }))
  expect(screen.queryByText('An idea')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /Latest Details/ }))
  harness.work.mutate.mockResolvedValue({ ok: false, code: 'storage', error: 'disk full' })
  fireEvent.click(screen.getByRole('button', { name: 'Save card' }))
  await screen.findByText(/The card was not saved/)
  expect(screen.getByRole('dialog')).toBeTruthy()
})
