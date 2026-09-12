import { beforeEach, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { harness } from '../test/harness'
import { DiffViewer } from './DiffViewer'

beforeEach(() => vi.clearAllMocks())
it('loads changes, filters files, switches layout, refreshes and closes', async () => {
  const user = userEvent.setup()
  const read = vi.mocked(harness.git.diffRange).mockResolvedValue({ dir: '/repo', root: '/repo', branch: 'main', base: 'HEAD', baseRef: 'HEAD', stat: '2 files', patch: 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/b.ts b/b.ts\n@@ -0,0 +1 @@\n+hello', patchLines: 7, truncated: false, untracked: 1 })
  const close = vi.fn()
  render(<DiffViewer dir="/repo" title="Agent" onClose={close} />)
  await screen.findByRole('button', { name: 'a.ts' })
  await user.type(screen.getByRole('textbox', { name: 'Filter changed files' }), 'b.ts')
  expect(screen.queryByRole('button', { name: 'a.ts' })).toBeNull()
  await user.click(screen.getByRole('button', { name: 'Side by side' }))
  expect(screen.getByText('Before')).toBeTruthy()
  await user.click(screen.getByRole('button', { name: 'Refresh' }))
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2))
  await user.keyboard('{Escape}')
  expect(close).toHaveBeenCalledOnce()
})
it('reports read failures instead of showing a clean repository', async () => {
  vi.mocked(harness.git.diffRange).mockRejectedValue(new Error('Git unavailable'))
  render(<DiffViewer dir="/repo" title="Agent" onClose={() => {}} />)
  expect((await screen.findByRole('alert')).textContent).toContain('Git unavailable')
  expect(screen.queryByText('No changes to review')).toBeNull()
})
