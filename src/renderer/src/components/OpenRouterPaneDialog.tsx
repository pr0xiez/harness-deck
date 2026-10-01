import { useState } from 'react'
import { agentLaunch } from '@shared/agent-session'
import { validateRouterModel } from '@shared/openrouter'
import { useDeck } from '../store'
import { Field, Modal } from './ui'
import { OpenRouterKey } from './OpenRouterKey'

const api = window.harness
const memoryKey = (id: string) => `hd.router.launch:${id}`
function remembered(id: string): { provider?: string; model?: string } {
  try { return JSON.parse(localStorage.getItem(memoryKey(id)) || '{}') ?? {} } catch { return {} }
}

export function OpenRouterPaneDialog({ workspaceId, profileId, onClose }: {
  workspaceId: string; profileId: string; onClose: () => void
}): React.JSX.Element {
  const profile = useDeck(s => s.profiles.find(p => p.id === profileId))
  const addPane = useDeck(s => s.addPane)
  const saved = remembered(profileId)
  const [provider, setProvider] = useState(saved.provider === 'openrouter' ? 'openrouter' : 'direct')
  const [model, setModel] = useState(typeof saved.model === 'string' ? saved.model : '')
  const [models, setModels] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const claude = profileId.endsWith(':claude')
  const loadModels = async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const answer = await api.openRouter.models()
      setModels(answer.models.filter(id => id.startsWith(claude ? 'anthropic/' : 'openai/')))
      setError(answer.error ?? '')
    } catch { setError('Could not load models. Enter a model ID manually.') }
    finally { setLoading(false) }
  }
  const open = (): void => {
    if (!profile) return
    const launch = agentLaunch(profile)
    if (!launch) { setError('This launcher does not support provider options.'); return }
    let chosen = model.trim()
    if (provider === 'openrouter') {
      try { chosen = validateRouterModel(chosen) }
      catch (err) { setError((err as Error).message); return }
    }
    try { localStorage.setItem(memoryKey(profileId), JSON.stringify({ provider, model: chosen })) } catch { /* Optional memory. */ }
    addPane(workspaceId, profile, {
      ...(provider === 'openrouter' ? { openRouter: { model: chosen } }
        : chosen ? launch.apply([...launch.args, '--model', chosen]) : {}),
      ...(provider === 'openrouter' ? { name: `${profile.name} · OpenRouter · ${chosen.split('/').pop()}` }
        : chosen ? { name: `${profile.name} · ${chosen}` } : {})
    })
    onClose()
  }
  return <Modal title={`${profile?.name ?? 'Agent'} pane`} onClose={onClose} footer={<>
    <button className="btn ghost" onClick={onClose}>Cancel</button>
    <button className="btn primary" onClick={open}>Open pane</button>
  </>}>
    <Field label="Provider">
      <select value={provider} onChange={e => { setProvider(e.target.value); setModel(''); setError('') }}>
        <option value="direct">Existing CLI configuration</option>
        <option value="openrouter">OpenRouter</option>
      </select>
    </Field>
    {provider === 'openrouter' ? <OpenRouterKey /> : null}
    <Field label="Model" hint={provider === 'openrouter'
      ? 'Use a complete OpenRouter model ID. Load available models or enter one below.'
      : 'Optional. Leave empty to use the CLI’s configured model and authentication.'}>
      <input value={model} list="router-models" spellCheck={false}
        placeholder={provider === 'openrouter' ? (claude ? '~anthropic/claude-sonnet-latest' : 'openai/…') : 'CLI default'}
        onChange={e => setModel(e.target.value)} />
      <datalist id="router-models">{models.map(id => <option key={id} value={id} />)}</datalist>
    </Field>
    {provider === 'openrouter' ? <button className="btn" disabled={loading} onClick={() => void loadModels()}>
      {loading ? 'Loading models…' : 'Load available models'}
    </button> : null}
    {error ? <p className="oc-note bad" role="alert">{error}</p> : null}
  </Modal>
}
