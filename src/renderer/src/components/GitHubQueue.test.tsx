import { beforeEach, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { GitHubQueue } from './GitHubQueue'
import { useGitHub } from '../github'
import { harness } from '../test/harness'

const item = { id: 'repo#1|me', repository: 'owner/repo', number: 1, title: 'Fix checkout', url: 'https://github.com/owner/repo/pull/1', revision: 'v1', signals: [{ kind: 'checks' as const, label: '1 failed check', url: 'https://github.com/owner/repo/actions/runs/1', revision: 'v1' }] }
beforeEach(() => {
  useGitHub.setState({ enabled: true, folders: ['/repo'], snapshots: { '/repo': { items: [item], checkedAt: 123 } }, marks: {}, loading: false, now: Date.now() })
})
it('opens the PR and failing check and allows restoring an acknowledged row', () => {
  render(<GitHubQueue />)
  fireEvent.click(screen.getByRole('button', { name: 'Open in GitHub' }))
  expect(harness.openExternal).toHaveBeenCalledWith(item.url)
  fireEvent.click(screen.getByRole('button', { name: '1 failed check' }))
  expect(harness.openExternal).toHaveBeenCalledWith(item.signals[0].url)
  fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }))
  expect(screen.queryByText('Fix checkout')).toBeNull()
  fireEvent.click(screen.getByLabelText('Show acknowledged and snoozed'))
  expect(screen.getByText('Acknowledged')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
  expect(screen.queryByText('Acknowledged')).toBeNull()
})
it('shows outages instead of an all-clear message', () => {
  useGitHub.setState({ snapshots: { '/repo': { items: [], checkedAt: 123, error: 'Run gh auth login' } } })
  render(<GitHubQueue />)
  expect(screen.getByText('Run gh auth login')).toBeTruthy()
  expect(screen.queryByText('No GitHub items need your attention in the checked repositories.')).toBeNull()
})
