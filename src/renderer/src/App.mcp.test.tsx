import { beforeEach, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { UpdateState } from '@shared/types'
import { harness } from './test/harness'
import { useDeck } from './store'
import { App } from './App'

const lifecycle = vi.hoisted(() => ({ mount: vi.fn(), unmount: vi.fn() }))
vi.mock('./components/PaneArea', async () => {
  const { useEffect } = await import('react')
  return {
    PaneArea: ({ visible }: { visible: boolean }) => {
      useEffect(() => {
        lifecycle.mount()
        return () => lifecycle.unmount()
      }, [])
      return <div data-testid="retained-pane" data-visible={String(visible)} />
    }
  }
})
vi.mock('./components/Toolbar', () => ({ Toolbar: () => null }))
vi.mock('./components/TitleBar', () => ({ TitleBar: () => null }))
vi.mock('./github', () => ({
  useGitHubPolling: () => undefined,
  useGitHub: () => 0,
  githubCount: () => 0
}))

beforeEach(() => {
  useDeck.setState({
    hydrated: true,
    workspaces: [],
    mounted: [],
    profiles: [],
    activeWorkspaceId: null
  })
  useDeck.getState().setUi({ page: 'deck', palette: false, settings: false })
  harness.update.state.mockResolvedValue({ stage: 'idle', channel: 'local' } as UpdateState)
  harness.update.setChannel.mockResolvedValue({ stage: 'idle', channel: 'local' } as UpdateState)
  harness.mcp.list.mockResolvedValue({
    target: { harness: 'codex', environment: 'native' },
    sources: [],
    entries: [],
    notices: []
  })
})

it('keeps panes mounted while managing MCPs and prevents hidden workspace shortcuts', async () => {
  const user = userEvent.setup()
  const id = useDeck.getState().addWorkspace('Project', '/repo')
  render(<App />)
  expect(lifecycle.mount).toHaveBeenCalledTimes(1)
  await user.click(screen.getByRole('button', { name: 'MCPs' }))
  await screen.findByRole('heading', { name: 'MCPs' })
  expect(screen.getByTestId('retained-pane').getAttribute('data-visible')).toBe('false')
  fireEvent.keyDown(document.body, { key: 't', ctrlKey: true, shiftKey: true })
  expect(useDeck.getState().ui.profileMenu).toBe(false)
  expect(lifecycle.unmount).not.toHaveBeenCalled()
  await act(async () => {
    useDeck.getState().setActiveWorkspace(id)
  })
  expect(screen.queryByRole('heading', { name: 'MCPs' })).toBeNull()
  expect(screen.getByTestId('retained-pane').getAttribute('data-visible')).toBe('true')
  expect(lifecycle.mount).toHaveBeenCalledTimes(1)
  expect(lifecycle.unmount).not.toHaveBeenCalled()
})


it('keeps terminals mounted and keyboard actions inactive on the work board', async () => {
  const user = userEvent.setup()
  harness.work.snapshot.mockResolvedValue({ ok: true, board: { version: 1, revision: 0, items: [] } })
  harness.work.access.mockResolvedValue({ enabled: false, command: '/deck/hd-work' })
  const id = useDeck.getState().addWorkspace('Project', '/repo')
  render(<App />)
  await user.click(screen.getByRole('button', { name: 'Board' }))
  await screen.findByRole('heading', { name: 'Board' })
  expect(screen.getByTestId('retained-pane').getAttribute('data-visible')).toBe('false')
  fireEvent.keyDown(document.body, { key: 't', ctrlKey: true, shiftKey: true })
  expect(useDeck.getState().ui.profileMenu).toBe(false)
  expect(lifecycle.unmount).not.toHaveBeenCalled()
  await act(async () => { useDeck.getState().setActiveWorkspace(id) })
  expect(screen.queryByRole('heading', { name: 'Board' })).toBeNull()
  expect(screen.getByTestId('retained-pane').getAttribute('data-visible')).toBe('true')
})
