import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { DiffResult } from '@shared/types'
import { parseDiff, splitLines, type DiffLine } from '../diff'
import { Icon } from './Icon'

export function DiffViewer({ dir, title, onClose }: { dir: string; title: string; onClose: () => void }): React.JSX.Element {
  const [diff, setDiff] = useState<DiffResult>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(true)
  const [refresh, setRefresh] = useState(0)
  const [selected, setSelected] = useState('')
  const [filter, setFilter] = useState('')
  const [split, setSplit] = useState(false)
  const [wrap, setWrap] = useState(false)
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let current = true
    setBusy(true); setError('')
    window.harness.git.diffRange({ dir, limit: 4000 }).then((result) => {
      if (current) { setDiff(result); setError(result.error ?? '') }
    }).catch((reason) => { if (current) setError(String(reason)) })
      .finally(() => { if (current) setBusy(false) })
    return () => { current = false }
  }, [dir, refresh])
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.focus()
    return () => previous?.focus()
  }, [])
  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose() }
      if (event.key === 'Tab') {
        const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input') ?? [])
        const first = controls[0], last = controls.at(-1)
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [onClose])
  const files = useMemo(() => parseDiff(diff?.patch ?? ''), [diff?.patch])
  const filtered = files.filter((file) => file.path.toLowerCase().includes(filter.toLowerCase()))
  const file = filtered.find((item) => item.path === selected) ?? filtered[0]
  const rows = useMemo(() => splitLines(file?.lines ?? []), [file])
  const cell = (line: DiffLine | undefined, side: 'old' | 'next'): React.JSX.Element => (
    <div className={`dv-cell ${line?.kind ?? 'empty'}`}><span className="dv-number">{line?.[side]}</span><code>{line ? `${line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '} ${line.text}` : ' '}</code></div>
  )
  return createPortal(
    <div className="dv-scrim">
      <div className="dv" ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`Changes — ${title}`}>
        <header className="dv-head"><div><h2>Changes <span> / {title}</span></h2><p title={dir}>{diff?.branch || dir}{diff?.baseRef ? ` · Compared with ${diff.baseRef}` : ''}</p></div>
          <button className="ghost-btn" disabled={busy} onClick={() => setRefresh((n) => n + 1)}><Icon name="refresh" />{busy ? 'Reading…' : 'Refresh'}</button>
          <button className="icon-btn" aria-label="Close changes" onClick={onClose}><Icon name="close" /></button>
        </header>
        {error ? <p className="dv-notice" role="alert">{error}</p> : busy && !diff ? <p className="dv-notice" role="status">Reading Git changes…</p> : <>
          <div className="dv-toolbar"><span>{files.length} files{diff?.truncated ? ' in preview' : ''} <b className="dv-add">+{files.reduce((n, f) => n + f.additions, 0)}</b> <b className="dv-del">−{files.reduce((n, f) => n + f.deletions, 0)}</b></span>
            <label><input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /> Wrap lines</label>
            <div className="segmented wide" role="group" aria-label="Diff layout"><button className={!split ? 'on' : ''} aria-pressed={!split} onClick={() => setSplit(false)}>Unified</button><button className={split ? 'on' : ''} aria-pressed={split} onClick={() => setSplit(true)}>Side by side</button></div>
          </div>
          <div className="dv-body"><aside className="dv-files"><input aria-label="Filter changed files" placeholder="Filter files…" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <nav aria-label="Changed files">{filtered.map((item) => <button key={item.path} className={item === file ? 'on' : ''} aria-current={item === file ? 'true' : undefined} title={item.path} aria-label={item.path} onClick={() => setSelected(item.path)}><span>{item.path}</span><small><b className="dv-add">+{item.additions}</b> <b className="dv-del">−{item.deletions}</b></small></button>)}</nav>
          </aside><main className="dv-main">{file ? <><header className="dv-file-head">{file.path}</header><div key={`${file.path}:${split}`} className={`dv-code ${wrap ? 'wrap' : ''}`}>
            {split ? <><div className="dv-split-label"><span>Before</span><span>After</span></div>{rows.map((row, i) => <div className="dv-split" key={i}>{cell(row.left, 'old')}{cell(row.right, 'next')}</div>)}</> : file.lines.map((line, i) => <div className={`dv-unified ${line.kind}`} key={i}><span className="dv-number">{line.old}</span><span className="dv-number">{line.next}</span><code>{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '} {line.text}</code></div>)}
          </div></> : <div className="dv-empty"><Icon name={files.length ? 'search' : 'check'} size={28} /><h3>{files.length ? 'No matching files' : 'No changes to review'}</h3><p>{files.length ? 'Try another file name.' : 'Changes in this repository will appear here after you refresh.'}</p></div>}</main></div>
          {(diff?.truncated || (diff?.untracked ?? 0) > 25) && <p className="dv-notice">Preview limited to 4,000 patch lines, 500 characters per line, and 25 untracked files. Some changes are omitted.</p>}
          <footer className="dv-foot">{diff?.baseRef === 'HEAD' ? 'Working tree vs HEAD · staged and unstaged changes, including new files' : 'Branch changes · includes committed, staged, unstaged and new files'}<span>Read only</span></footer>
        </>}
      </div>
    </div>, document.body
  )
}
