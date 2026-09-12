import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WorkBoardService } from './work-board'
import { WorkBoardAccess } from './work-board-access'

let dir: string
let access: WorkBoardAccess | undefined
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hd-board-')) })
afterEach(async () => { await access?.stop(); access = undefined; rmSync(dir, { recursive: true, force: true }) })

it('persists cards, orders moves, rejects stale edits and reopens completed work', () => {
  const changed = vi.fn()
  const service = new WorkBoardService(dir, changed)
  const a = service.mutate({ operation: 'create', title: ' A ' })
  const b = service.mutate({ operation: 'create', title: 'B' })
  if (!a.ok || !a.item || !b.ok || !b.item) throw Error('create failed')
  expect(a.item.title).toBe('A')
  expect(service.mutate({ operation: 'move', id: a.item.id, expectedRevision: 1, status: 'done' }).ok).toBe(true)
  expect(service.mutate({ operation: 'edit', id: a.item.id, expectedRevision: 1, title: 'Lost update' })).toMatchObject({ ok: false, code: 'conflict', current: { title: 'A', revision: 2 } })
  expect(service.mutate({ operation: 'edit', id: b.item.id, expectedRevision: 1, title: 'Independent' }).ok).toBe(true)
  expect(service.mutate({ operation: 'move', id: a.item.id, expectedRevision: 2, status: 'ideas' }).ok).toBe(true)
  const reload = new WorkBoardService(dir).snapshot()
  expect(reload).toMatchObject({ ok: true, board: { revision: 5, items: [{ title: 'Independent' }, { title: 'A', status: 'ideas' }] } })
  expect(changed).toHaveBeenCalledTimes(5)
})

it('validates input and does not publish a failed save', () => {
  const changed = vi.fn()
  const service = new WorkBoardService(dir, changed, () => ({ ok: false, error: 'disk full' }))
  for (const input of [null, {}, { operation: 'create', title: ' ' }, { operation: 'create', title: 'x', status: 'unknown' }, { operation: 'create', title: 'x', id: 'injected' }, { operation: 'create', title: 'x', description: '😀'.repeat(9000) }]) expect(service.mutate(input)).toMatchObject({ ok: false, code: 'invalid' })
  expect(service.mutate({ operation: 'create', title: 'x' })).toMatchObject({ ok: false, code: 'storage', error: 'disk full' })
  expect(service.snapshot()).toMatchObject({ ok: true, board: { revision: 0, items: [] } })
  expect(changed).not.toHaveBeenCalled()
})

it('recovers a valid backup and blocks corrupt or newer data', () => {
  const service = new WorkBoardService(dir)
  service.mutate({ operation: 'create', title: 'Keep' })
  service.mutate({ operation: 'create', title: 'Second' })
  writeFileSync(join(dir, 'work-board.json'), '{broken')
  expect(new WorkBoardService(dir).snapshot()).toMatchObject({ ok: true, board: { items: [{ title: 'Keep' }] } })
  writeFileSync(join(dir, 'work-board.json.bak'), '{broken')
  const corrupt = new WorkBoardService(dir)
  expect(corrupt.mutate({ operation: 'create', title: 'Do not overwrite' })).toMatchObject({ ok: false, code: 'storage' })
  writeFileSync(join(dir, 'work-board.json'), JSON.stringify({ version: 2, items: [] }))
  expect(new WorkBoardService(dir).snapshot()).toMatchObject({ ok: false, error: expect.stringContaining('version') })
})

it('round trips the real CLI, rejects unauthorized requests, and rotates discovery', async () => {
  const service = new WorkBoardService(dir)
  access = new WorkBoardAccess(dir, service, process.execPath, resolve('scripts/hd-work.cjs'))
  expect(access.status().enabled).toBe(false)
  expect((await access.setEnabled(true)).enabled).toBe(true)
  const config = JSON.parse(readFileSync(access.discovery, 'utf8'))
  const endpoint = `http://127.0.0.1:${config.port}/board`
  expect((await fetch(endpoint)).status).toBe(401)
  expect((await fetch(endpoint, { headers: { authorization: `Bearer ${config.token}`, origin: 'http://example.com' } })).status).toBe(401)
  const cli = async (...args: string[]): Promise<any> => JSON.parse((await promisify(execFile)(process.platform === 'win32' ? process.execPath : access!.status().command, process.platform === 'win32' ? [resolve('scripts/hd-work.cjs'), '--discovery', access!.discovery, ...args] : args)).stdout)
  const created = await cli('create', '--title', 'From agent', '--description', 'literal $() `text`')
  expect(created.item.description).toBe('literal $() `text`')
  expect((await cli('list')).items).toHaveLength(1)
  expect((await cli('get', created.item.id)).item.revision).toBe(1)
  const moved = await cli('move', created.item.id, '--revision', '1', '--status', 'in_progress')
  expect(moved.item.status).toBe('in_progress')
  await expect(cli('move', created.item.id, '--revision', '1', '--status', 'done')).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('conflict') })
  await cli('edit', created.item.id, '--revision', '2', '--title', 'Edited')
  expect((await cli('move', created.item.id, '--revision', '3', '--status', 'done')).item.status).toBe('done')
  await access.setEnabled(false)
  await expect(fetch(endpoint)).rejects.toThrow()
  await access.setEnabled(true)
  expect(JSON.parse(readFileSync(access.discovery, 'utf8')).token).not.toBe(config.token)
  expect((await cli('list')).items[0].title).toBe('Edited')
})
