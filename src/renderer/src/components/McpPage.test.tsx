import { beforeEach, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { McpInventory } from '@shared/mcp'
import { harness } from '../test/harness'
import { useDeck } from '../store'
import { buildCommands } from './commands'
import { McpPage } from './McpPage'

const inventory = (): McpInventory => ({
  target: { harness: 'codex', environment: 'native' },
  sources: [
    {
      id: 'user',
      scope: 'user',
      path: '/home/test/.codex/config.toml',
      revision: 'v1',
      writable: true
    }
  ],
  entries: [
    {
      id: 'user:test',
      sourceId: 'user',
      name: 'test',
      transport: 'stdio',
      enabled: true,
      endpoint: 'Local command (values hidden)',
      environmentKeys: ['TOKEN'],
      headerKeys: [],
      canEdit: true,
      canToggle: true
    }
  ],
  notices: ['Configuration is not a live connection.']
})
beforeEach(() => {
  harness.mcp.list.mockReset().mockResolvedValue(inventory())
  harness.mcp.mutate.mockReset().mockResolvedValue({ ok: true })
  harness.confirm.mockReset().mockResolvedValue(true)
  useDeck.setState({ workspaces: [], activeWorkspaceId: null, profiles: [], mounted: [] })
  useDeck.getState().setUi({ page: 'mcps' })
})

it('shows masked source details and sends only changed values when editing', async () => {
  const user = userEvent.setup()
  render(<McpPage />)
  await user.click(await screen.findByRole('button', { name: /test · User/ }))
  expect(screen.getByText('Not checked · view /mcp in your harness')).toBeTruthy()
  await user.click(screen.getByRole('button', { name: 'Edit' }))
  const dialog = screen.getByRole('dialog')
  expect((within(dialog).getByRole('textbox', { name: 'Command' }) as HTMLInputElement).value).toBe(
    ''
  )
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Arguments' }), {
    target: { value: '["hello world", "$(no-shell)"]' }
  })
  await user.click(within(dialog).getByRole('button', { name: 'Save server' }))
  await waitFor(() =>
    expect(harness.mcp.mutate).toHaveBeenCalledWith({
      action: 'edit',
      sourceId: 'user',
      revision: 'v1',
      name: 'test',
      server: { name: 'test', transport: 'stdio', args: ['hello world', '$(no-shell)'] }
    })
  )
  expect(await screen.findByRole('status')).toBeTruthy()
})

it('keeps the editor and entered values on a conflicting save, without claiming success', async () => {
  const user = userEvent.setup()
  harness.mcp.mutate.mockResolvedValue({
    ok: false,
    error: 'Configuration changed outside this editor. Refresh before saving.'
  })
  render(<McpPage />)
  await user.click(await screen.findByRole('button', { name: 'Add server' }))
  await user.type(screen.getByRole('textbox', { name: 'Server name' }), 'new-server')
  await user.type(screen.getByRole('textbox', { name: 'Command' }), 'tool')
  await user.click(screen.getByRole('button', { name: 'Save server' }))
  expect((await screen.findByRole('alert')).textContent).toContain('changed outside')
  expect((screen.getByRole('textbox', { name: 'Command' }) as HTMLInputElement).value).toBe('tool')
  expect(screen.queryByText(/Configuration saved/)).toBeNull()
  expect(harness.mcp.list).toHaveBeenCalledTimes(1)
})

it('confirms the exact source before removal and does nothing when canceled', async () => {
  const user = userEvent.setup()
  harness.confirm.mockResolvedValue(false)
  render(<McpPage />)
  await user.click(await screen.findByRole('button', { name: /test · User/ }))
  await user.click(screen.getByRole('button', { name: 'Remove' }))
  expect(harness.confirm).toHaveBeenCalledWith(
    expect.objectContaining({
      detail: '/home/test/.codex/config.toml',
      message: expect.stringContaining('all projects')
    })
  )
  expect(harness.mcp.mutate).not.toHaveBeenCalled()
})

it('displays partial errors alongside readable servers and hides writes for read-only sources', async () => {
  const data = inventory()
  data.sources[0].writable = false
  data.entries[0].canEdit = false
  data.entries[0].canToggle = false
  data.sources.push({
    id: 'project',
    scope: 'project',
    path: '/repo/.codex/config.toml',
    writable: false,
    revision: '',
    error: 'Malformed source'
  })
  harness.mcp.list.mockResolvedValue(data)
  const user = userEvent.setup()
  render(<McpPage />)
  await user.click(await screen.findByRole('button', { name: /test · User/ }))
  expect(screen.getByRole('alert').textContent).toBe('Malformed source')
  expect(screen.queryByRole('button', { name: 'Add server' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
})

it('discards a stale discovery response after the harness changes', async () => {
  let resolveOld!: (value: McpInventory) => void
  harness.mcp.list.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve
      })
  )
  const newer = inventory()
  newer.target.harness = 'claude'
  newer.entries[0].name = 'claude-server'
  harness.mcp.list.mockResolvedValueOnce(newer)
  const user = userEvent.setup()
  render(<McpPage />)
  await user.selectOptions(screen.getByRole('combobox', { name: 'Harness' }), 'claude')
  await screen.findByRole('button', { name: /claude-server/ })
  resolveOld(inventory())
  await waitFor(() => expect(screen.queryByRole('button', { name: /^test · User/ })).toBeNull())
})

it('offers MCP navigation while keeping terminal commands out of the palette, and returns to a workspace', () => {
  const state = useDeck.getState()
  const id = state.addWorkspace('Test', '/repo')
  state.setUi({ page: 'mcps' })
  const commands = buildCommands(useDeck.getState())
  expect(commands.some((c) => c.id === 'app:mcps')).toBe(true)
  expect(commands.some((c) => c.group === 'Pane' || c.id === 'ws:layout-grid')).toBe(false)
  commands.find((c) => c.id === `ws:${id}`)!.run()
  expect(useDeck.getState().ui.page).toBe('deck')
  expect(useDeck.getState().mounted).toContain(id)
})
