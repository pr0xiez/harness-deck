import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WORK_STATUSES, type WorkBoard, type WorkItem, type WorkResult } from '@shared/work-board'
import type { SaveStateResult } from '@shared/types'

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const revision = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0
const status = (v: unknown): boolean => WORK_STATUSES.includes(v as typeof WORK_STATUSES[number])
const title = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 200
const description = (v: unknown): v is string => typeof v === 'string' && Buffer.byteLength(v) <= 32768
const workspace = (v: unknown): boolean => v === null || (typeof v === 'string' && v.length > 0 && v.length <= 200)
function validBoard(v: unknown): v is WorkBoard {
  if (!object(v) || v.version !== 1 || !revision(v.revision) || !Array.isArray(v.items)) return false
  const ids = new Set<string>()
  return v.items.every((i: unknown) => {
    if (!object(i) || typeof i.id !== 'string' || !i.id || ids.has(i.id) || !title(i.title) || !description(i.description) || !status(i.status) || !workspace(i.workspaceId) || !revision(i.revision) || i.revision < 1 || typeof i.createdAt !== 'string' || !Number.isFinite(Date.parse(i.createdAt)) || typeof i.updatedAt !== 'string' || !Number.isFinite(Date.parse(i.updatedAt))) return false
    ids.add(i.id)
    return true
  })
}

function writeBoard(file: string, value: unknown): SaveStateResult {
  try {
    mkdirSync(dirname(file), { recursive: true })
    // A recovered backup must survive a failed repair of the corrupt primary.
    let primaryValid = false
    try { primaryValid = validBoard(JSON.parse(readFileSync(file, 'utf8'))) } catch { /* No valid primary. */ }
    if (primaryValid) copyFileSync(file, `${file}.bak`)
    writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 })
    renameSync(`${file}.tmp`, file)
    return { ok: true }
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
}

/** The only writer: synchronous persistence makes compare-and-swap indivisible. */
export class WorkBoardService {
  private board: WorkBoard = { version: 1, revision: 0, items: [] }
  private error?: string
  private file: string
  constructor(baseDir: string, private changed: (board: WorkBoard) => void = () => {}, private write = writeBoard) {
    this.file = join(baseDir, 'work-board.json')
    for (const file of [this.file, `${this.file}.bak`]) {
      if (!existsSync(file)) continue
      try {
        const data: unknown = JSON.parse(readFileSync(file, 'utf8'))
        if (object(data) && data.version !== 1) {
          this.error = 'Unsupported board version. Restore a compatible board file before editing.'
          return
        }
        if (validBoard(data)) { this.board = data; this.error = undefined; return }
      } catch { /* Try the backup before reporting recovery failure. */ }
      this.error = 'Board data is unreadable. Restore work-board.json from a valid backup before editing.'
    }
  }
  snapshot(): WorkResult {
    return this.error ? { ok: false, code: 'storage', error: this.error } : { ok: true, board: structuredClone(this.board) }
  }
  mutate(input: unknown): WorkResult {
    if (this.error) return { ok: false, code: 'storage', error: this.error }
    const invalid = (): WorkResult => ({ ok: false, code: 'invalid', error: 'Invalid board operation or fields.' })
    if (!object(input)) return invalid()
    const op = input.operation
    const allowed = op === 'create' ? ['operation', 'title', 'description', 'status', 'workspaceId'] : op === 'edit' ? ['operation', 'id', 'expectedRevision', 'title', 'description', 'workspaceId'] : op === 'move' ? ['operation', 'id', 'expectedRevision', 'status'] : []
    if (!allowed.length || Object.keys(input).some(k => !allowed.includes(k))) return invalid()
    if (('title' in input && !title(input.title)) || ('description' in input && !description(input.description)) || ('workspaceId' in input && !workspace(input.workspaceId)) || ('status' in input && !status(input.status))) return invalid()
    const next = structuredClone(this.board)
    const now = new Date().toISOString()
    let item: WorkItem
    if (op === 'create') {
      if (!title(input.title)) return invalid()
      item = { id: randomUUID(), title: input.title.trim(), description: (input.description as string) ?? '', status: (input.status as WorkItem['status']) ?? 'ideas', workspaceId: (input.workspaceId as string | null) ?? null, revision: 1, createdAt: now, updatedAt: now }
      next.items.push(item)
    } else {
      if (typeof input.id !== 'string' || !revision(input.expectedRevision) || (op === 'move' && !status(input.status))) return invalid()
      const found = next.items.find(i => i.id === input.id)
      if (!found) return { ok: false, code: 'not_found', error: 'Card not found.' }
      if (found.revision !== input.expectedRevision) return { ok: false, code: 'conflict', error: 'This card changed. Reload the current card before saving again.', current: found }
      item = found
      if (op === 'edit') {
        if (input.title !== undefined) item.title = (input.title as string).trim()
        if (input.description !== undefined) item.description = input.description as string
        if (input.workspaceId !== undefined) item.workspaceId = input.workspaceId as string | null
      } else if (item.status !== input.status) {
        item.status = input.status as WorkItem['status']
        next.items = [...next.items.filter(i => i.id !== item.id), item]
      }
      item.revision++
      item.updatedAt = now
    }
    next.revision++
    const saved = this.write(this.file, next)
    if (!saved.ok) return { ok: false, code: 'storage', error: saved.error || 'Could not save board.' }
    this.board = next
    this.changed(structuredClone(next))
    return { ok: true, board: structuredClone(next), item: structuredClone(item) }
  }
}
