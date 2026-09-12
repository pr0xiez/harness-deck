import { useEffect, useRef, useState } from 'react'
import { WORK_LABELS, WORK_STATUSES, type WorkAccess, type WorkBoard, type WorkItem, type WorkMutation, type WorkStatus } from '@shared/work-board'
import { useDeck } from '../store'
import { Modal } from './ui'

const api = window.harness.work
const empty: WorkBoard = { version: 1, revision: -1, items: [] }

export function WorkBoardPage(): React.JSX.Element {
  const workspaces = useDeck(s => s.workspaces)
  const [board, setBoard] = useState(empty)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('all')
  const [access, setAccess] = useState<WorkAccess>()
  const [accessBusy, setAccessBusy] = useState(false)
  const [editor, setEditor] = useState<{ item?: WorkItem; status: WorkStatus }>()
  const [busy, setBusy] = useState(false)
  const drag = useRef<{ id: string; revision: number } | null>(null)
  const receive = (next: WorkBoard): void => setBoard(old => next.revision >= old.revision ? next : old)
  useEffect(() => {
    let alive = true
    const off = api.onChanged(next => { if (alive) receive(next) })
    void api.snapshot().then(result => {
      if (!alive) return
      if (result.ok) receive(result.board)
      else setError(result.error)
    }).catch(e => { if (alive) setError(String(e)) })
    void api.access().then(value => { if (alive) setAccess(value) }).catch(e => { if (alive) setError(String(e)) })
    return () => { alive = false; off() }
  }, [])
  const mutate = async (change: WorkMutation): Promise<boolean> => {
    setBusy(true)
    setError('')
    try {
      const result = await api.mutate(change)
      if (!result.ok) {
        setError(result.error)
        if (result.code === 'conflict') { const fresh = await api.snapshot(); if (fresh.ok) receive(fresh.board) }
        return false
      }
      receive(result.board)
      return true
    } catch (e) { setError(String(e)); return false } finally { setBusy(false) }
  }
  const move = (id: string, expectedRevision: number, status: WorkStatus): void => {
    void mutate({ operation: 'move', id, expectedRevision, status })
  }
  const workspaceLabel = (id: string | null): string => id ? workspaces.find(w => w.id === id)?.name || 'Missing workspace' : 'Unassigned'
  return <main className="work-board">
    <header className="work-board-head">
      <div><h1>Board</h1><p>Capture an idea, pick it up, and track it through to done.</p></div>
      <div className="work-board-actions">
        <select aria-label="Filter by workspace" value={filter} onChange={e => setFilter(e.target.value)}>
          <option value="all">All work</option><option value="unassigned">Unassigned</option>
          {workspaces.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <button className="btn primary" disabled={board.revision < 0} onClick={() => setEditor({ status: 'ideas' })}>Add card</button>
      </div>
    </header>
    {error && <div className="work-error" role="alert">{error}</div>}
    {board.revision < 0 && !error && <p>Loading board…</p>}
    <div className="work-columns">
      {WORK_STATUSES.map(status => {
        const items = board.items.filter(i => i.status === status && (filter === 'all' || i.workspaceId === (filter === 'unassigned' ? null : filter)))
        return <section className={`work-column work-${status}`} key={status} aria-label={WORK_LABELS[status]}
          onDragOver={e => { if (drag.current && !busy) { e.preventDefault(); e.dataTransfer.dropEffect = 'move' } }}
          onDrop={e => { e.preventDefault(); const card = drag.current; drag.current = null; if (card && !busy) move(card.id, card.revision, status) }}>
          <header><h2>{WORK_LABELS[status]}</h2><span className="work-count">{items.length}</span></header>
          <div className="work-card-list">
            {items.map(item => <article className="work-card" key={item.id} draggable={!busy}
              onDragStart={e => { drag.current = { id: item.id, revision: item.revision }; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', item.id) }} onDragEnd={() => { drag.current = null }}>
              <button className="work-card-open" onClick={() => setEditor({ item: { ...item }, status: item.status })}>
                <strong>{item.title}</strong>{item.description && <p>{item.description}</p>}
                <small>{workspaceLabel(item.workspaceId)}</small>
              </button>
              <select aria-label={`Move ${item.title} to`} value={item.status} disabled={busy} onChange={e => move(item.id, item.revision, e.target.value as WorkStatus)}>
                {WORK_STATUSES.map(s => <option key={s} value={s}>Move to {WORK_LABELS[s]}</option>)}
              </select>
            </article>)}
            {!items.length && <p className="work-empty">No cards here yet.</p>}
          </div>
          <button className="btn subtle full" disabled={board.revision < 0} onClick={() => setEditor({ status })}>+ Add card</button>
        </section>
      })}
    </div>
    <details className="work-access">
      <summary>Harness access {access?.enabled ? '· Enabled' : '· Disabled'}</summary>
      <p>Let agents read, add, edit and move cards through hd-work. Deck must be running.</p>
      <label><input type="checkbox" checked={access?.enabled ?? false} disabled={!access || accessBusy} onChange={async e => {
        setAccessBusy(true)
        try { setAccess(await api.setAccess(e.target.checked)) } catch (e) { setError(String(e)) } finally { setAccessBusy(false) }
      }} /> Allow harnesses to manage this board</label>
      {access?.error && <p role="alert">{access.error}</p>}
      {access && <><p>CLI path (new panes receive this folder on PATH):</p><code>{access.command}</code>
        {access.wslCommand && <p>WSL: use the translated Linux path to <code>{access.wslCommand}</code>. Windows interop is required.</p>}
        <p>Agent instructions:</p><pre>{'Use hd-work --help to manage the Deck board. Read a card with hd-work get <id> before editing or moving it; pass its revision with --revision. Statuses: ideas, in_progress, wont_do, done. Move to done only when the work is complete. On a conflict, reread the card and reconcile the changes.'}</pre>
        <button className="btn" onClick={() => void window.harness.clipboard.write(`Use ${access.command} --help to manage the Deck board. Read cards before editing and supply their current --revision. Statuses: ideas, in_progress, wont_do, done. Mark done only when complete. Reread and reconcile conflicts.`)}>Copy agent instructions</button></>}
    </details>
    {editor && <CardEditor key={editor.item?.id || 'new'} item={editor.item} status={editor.status} current={board.items.find(i => i.id === editor.item?.id)}
      error={error} initialWorkspace={filter === 'all' || filter === 'unassigned' ? null : filter} onClose={() => setEditor(undefined)} onSave={async change => {
        const saved = await mutate(change)
        if (saved) setEditor(undefined)
        return saved
      }} />}
  </main>
}

function CardEditor({ item, current, status, initialWorkspace, error, onClose, onSave }: {
  item?: WorkItem; current?: WorkItem; status: WorkStatus; initialWorkspace: string | null; error: string
  onClose: () => void; onSave: (change: WorkMutation) => Promise<boolean>
}): React.JSX.Element {
  const workspaces = useDeck(s => s.workspaces)
  const [base, setBase] = useState(item)
  const [title, setTitle] = useState(item?.title || '')
  const [description, setDescription] = useState(item?.description || '')
  const [workspaceId, setWorkspaceId] = useState(item?.workspaceId ?? initialWorkspace)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const stale = base && current && base.revision !== current.revision
  return <Modal title={item ? 'Edit card' : `Add to ${WORK_LABELS[status]}`} onClose={() => { if (!saving) onClose() }}>
    <form className="work-editor" onSubmit={async e => {
      e.preventDefault(); setSaving(true); setFailed(false)
      const ok = await onSave(base ? { operation: 'edit', id: base.id, expectedRevision: base.revision, title, description, workspaceId } : { operation: 'create', title, description, workspaceId, status })
      if (!ok) setFailed(true)
      setSaving(false)
    }}>
      <label>Title<input autoFocus required maxLength={200} value={title} onChange={e => setTitle(e.target.value)} /></label>
      <label>Description<textarea rows={7} value={description} onChange={e => setDescription(e.target.value)} /></label>
      <label>Workspace<select value={workspaceId || ''} onChange={e => setWorkspaceId(e.target.value || null)}>
        <option value="">Unassigned</option>
        {workspaceId && !workspaces.some(w => w.id === workspaceId) && <option value={workspaceId}>Missing workspace</option>}
        {workspaces.map(w => <option value={w.id} key={w.id}>{w.name}</option>)}
      </select></label>
      {base && <small>ID: {base.id}<br />Created {new Date(base.createdAt).toLocaleString()} · Updated {new Date(base.updatedAt).toLocaleString()}</small>}
      {stale && <div role="alert">This card changed while you were editing. Your draft is preserved. Copy any text you want to keep, then reload the current card.
        <button type="button" className="btn" onClick={() => { setBase(current); setTitle(current.title); setDescription(current.description); setWorkspaceId(current.workspaceId); setFailed(false) }}>Reload current card</button>
      </div>}
      {failed && <p role="alert">The card was not saved. {error} Your draft is preserved.</p>}
      <div className="work-board-actions"><button type="button" className="btn" disabled={saving} onClick={onClose}>Cancel</button><button className="btn primary" disabled={saving || !!stale || !title.trim()}>{saving ? 'Saving…' : 'Save card'}</button></div>
    </form>
  </Modal>
}
