import { useEffect, useState } from 'react'
import type { VoiceKeyState } from '@shared/types'
import { Field } from './ui'

const api = window.harness

export function OpenRouterKey(): React.JSX.Element {
  const [state, setState] = useState<VoiceKeyState | null>(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    let live = true
    void api.openRouter.keyState().then(value => { if (live) setState(value) })
      .catch(() => { if (live) setError('Could not check the OpenRouter key.') })
    return () => { live = false }
  }, [])
  const save = async (value: string | null): Promise<void> => {
    setSaving(true)
    setError('')
    try { setState(await api.openRouter.setKey(value)); setDraft('') }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not save the key.') }
    finally { setSaving(false) }
  }
  const hint = state?.source === 'stored' ? 'Saved on this machine, encrypted with the OS keychain.'
    : state?.source === 'env' ? 'Using OPENROUTER_API_KEY from Deck’s shell.'
    : 'Paste a key or export OPENROUTER_API_KEY. WSL panes can use the key from their login shell.'
  return <>
    <Field label="OpenRouter API key" hint={hint}>
      <div className="row">
        <input type="password" autoComplete="off" value={draft} placeholder={state?.hasKey ? 'Key configured' : 'sk-or-…'}
          onChange={e => setDraft(e.target.value)} />
        <button className="btn subtle" disabled={saving || !draft.trim()} onClick={() => void save(draft)}>Save key</button>
        {state?.source === 'stored' ? <button className="btn ghost" disabled={saving} onClick={() => void save(null)}>Forget key</button> : null}
      </div>
    </Field>
    {error ? <p role="alert" className="oc-note bad">{error}</p> : null}
    <p className="oc-note">Agent usage is billed to OpenRouter credits. Claude and ChatGPT subscriptions do not cover it.
      {' '}<button className="btn ghost" onClick={() => void api.openExternal('https://openrouter.ai/settings/keys')}>Get a key</button>
    </p>
  </>
}
