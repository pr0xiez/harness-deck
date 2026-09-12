import { useState } from 'react'
import { githubItems, needsGitHubAttention, useGitHub } from '../github'
import { useDeck } from '../store'
import { Modal } from './ui'

export function AttentionTabs(): React.JSX.Element {
  const tab = useDeck(s => s.ui.attentionTab)
  const setUi = useDeck(s => s.setUi)
  return <div className="github-tabs" role="tablist" aria-label="Attention source">
    <button className={`btn tiny ghost ${tab === 'agents' ? 'on' : ''}`} role="tab" aria-selected={tab === 'agents'} onClick={() => setUi({ attentionTab: 'agents' })}>Agents</button>
    <button className={`btn tiny ghost ${tab === 'github' ? 'on' : ''}`} role="tab" aria-selected={tab === 'github'} onClick={() => setUi({ attentionTab: 'github' })}>GitHub</button>
  </div>
}

export function GitHubQueue(): React.JSX.Element {
  const state = useGitHub()
  const workspaces = useDeck(s => s.workspaces)
  const setUi = useDeck(s => s.setUi)
  const [folder, setFolder] = useState('')
  const [showSeen, setShowSeen] = useState(false)
  const selectedFolder = state.folders.includes(folder) ? folder : ''
  const snapshots = selectedFolder ? { [selectedFolder]: state.snapshots[selectedFolder] } : state.snapshots
  const available = Object.fromEntries(Object.entries(snapshots).filter(([, value]) => value))
  const all = githubItems(available)
  const rows = all.filter(item => showSeen || needsGitHubAttention(item, state.marks, state.now))
  const close = (): void => setUi({ waitingQueue: false })
  return <Modal title="Needs your attention" onClose={close} wide>
    <AttentionTabs />
    <div className="github-controls">
      <label><input autoFocus type="checkbox" checked={state.enabled} onChange={e => state.setEnabled(e.target.checked)} /> Watch workspace repositories</label>
      <button className="btn tiny ghost" disabled={!state.enabled || state.loading} onClick={() => void state.refresh()}>{state.loading ? 'Checking…' : 'Refresh'}</button>
    </div>
    {!state.enabled ? <p>Turn on watching to see review requests, feedback on your PRs, and failed checks here.</p> : <>
      <div className="github-controls">
        <select aria-label="GitHub workspace" value={selectedFolder} onChange={e => setFolder(e.target.value)}>
          <option value="">All workspaces</option>
          {workspaces.filter(w => w.cwd).map(w => <option key={w.id} value={w.cwd}>{w.name}</option>)}
        </select>
        <label><input type="checkbox" checked={showSeen} onChange={e => setShowSeen(e.target.checked)} /> Show acknowledged and snoozed</label>
      </div>
      <p className="github-hint">Uses your saved gh login. Checks every 90 seconds; refreshes are cached for one minute. Acknowledge and snooze apply only in Deck.</p>
      {Object.entries(available).map(([cwd, snapshot]) => <div className="github-status" key={cwd}>
        <span>{workspaces.find(w => w.cwd === cwd)?.name ?? cwd}{snapshot.repository ? ` · ${snapshot.repository}` : ''}{snapshot.account ? ` · @${snapshot.account}` : ''}</span>
        <span>{snapshot.checkedAt ? `Checked ${new Date(snapshot.checkedAt).toLocaleTimeString()}` : ''}</span>
        {snapshot.error ? <p role="status" className="github-error">{snapshot.error}{snapshot.items.length ? ' Showing the last successful results.' : ''}</p> : null}
        {snapshot.warning ? <p role="status">{snapshot.warning}</p> : null}
      </div>)}
      {!state.folders.length ? <p>Add a folder to a workspace to watch its GitHub repository.</p> : null}
      <div className="github-items">
        {rows.map(item => {
          const actionable = needsGitHubAttention(item, state.marks, state.now)
          const mark = state.marks[item.id]
          return <article className={`github-item ${actionable ? '' : 'is-acknowledged'}`} key={item.id}>
            <div className="github-item-heading"><strong>{item.title}</strong><span>{item.repository} #{item.number}</span></div>
            <div className="github-signals">{item.signals.map(signal => <button key={signal.kind} className="btn tiny ghost" onClick={() => window.harness.openExternal(signal.url)}>{signal.label}</button>)}</div>
            {!actionable ? <small>{mark.acknowledged ? 'Acknowledged' : `Snoozed until ${new Date(mark.snoozedUntil!).toLocaleTimeString()}`}</small> : null}
            <div className="github-actions">
              <button className="btn tiny" onClick={() => window.harness.openExternal(item.url)}>Open in GitHub</button>
              <button className="btn tiny ghost" onClick={() => state.acknowledge(item)}>Acknowledge</button>
              <button className="btn tiny ghost" onClick={() => state.snooze(item)}>Snooze 1 hour</button>
              {!actionable ? <button className="btn tiny ghost" onClick={() => state.restore(item)}>Restore</button> : null}
            </div>
          </article>
        })}
      </div>
      {!rows.length && !state.loading && state.folders.length > 0 ? <p>{Object.values(available).some(s => s.error) ? 'Some repositories could not be checked. Resolve the errors above and refresh.' : 'No GitHub items need your attention in the checked repositories.'}</p> : null}
    </>}
  </Modal>
}
