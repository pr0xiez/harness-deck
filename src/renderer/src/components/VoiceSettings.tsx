import { useEffect, useState } from 'react'
import type { VoiceKeyState, VoiceProvider } from '@shared/types'
import { voiceProvider, VOICE_PROVIDERS } from '@shared/voice'
import { useDeck } from '../store'
import { Field, Kbd, Toggle } from './ui'

const api = window.harness

function keyLine(state: VoiceKeyState | null, provider: VoiceProvider): string {
  if (!state) return 'checking…'
  if (state.source === 'env') return `using ${state.envVar} from your shell`
  if (state.source === 'stored') {
    return state.encrypted
      ? 'saved to this machine, encrypted by the OS keychain'
      : 'saved to this machine — no keychain available, so it is only obfuscated'
  }
  const info = voiceProvider(provider)
  return `not set — paste one, or export ${info.envVars.join(' / ')}`
}

/** The Voice input section of the settings dialog. */
export function VoiceSettings(): React.JSX.Element {
  const voice = useDeck((s) => s.settings.voice)
  const updateVoice = useDeck((s) => s.updateVoice)
  const [keyState, setKeyState] = useState<VoiceKeyState | null>(null)
  const [draftKey, setDraftKey] = useState('')
  const info = voiceProvider(voice.provider)
  const keysUrl = info.keysUrl

  useEffect(() => {
    setKeyState(null)
    setDraftKey('')
    void api.voice.keyState(voice.provider).then(setKeyState)
  }, [voice.provider])

  const saveKey = async (value: string | null): Promise<void> => {
    setKeyState(await api.voice.setKey(voice.provider, value))
    setDraftKey('')
  }

  return (
    <section className="settings-wide">
      <h3>Voice input</h3>
      <p className="field-hint voice-lead">
        <Kbd>Ctrl</Kbd>+<Kbd>Shift</Kbd>+<Kbd>M</Kbd> records you and types the transcript into the
        focused pane — or into the broadcast box when that has focus. Audio is sent to the service
        below and nothing is kept on disk.
      </p>

      <div className="voice-grid">
        <Field label="Service">
          <select
            value={voice.provider}
            onChange={(event) => updateVoice({ provider: event.target.value as VoiceProvider })}
          >
            {VOICE_PROVIDERS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Model">
          <input
            value={voice.model}
            list="voice-models"
            placeholder={info.model}
            onChange={(event) => updateVoice({ model: event.target.value })}
          />
          <datalist id="voice-models">
            {info.models.map((model) => (
              <option key={model} value={model} />
            ))}
          </datalist>
        </Field>

        <Field label="Endpoint" hint={info.hint}>
          <input
            value={voice.baseUrl}
            placeholder={info.baseUrl || 'http://127.0.0.1:8000/v1'}
            onChange={(event) => updateVoice({ baseUrl: event.target.value })}
          />
        </Field>

        <Field label="API key" hint={keyLine(keyState, voice.provider)}>
          <div className="row">
            <input
              type="password"
              value={draftKey}
              autoComplete="off"
              placeholder={keyState?.hasKey ? '••••••••••••' : 'sk-…'}
              onChange={(event) => setDraftKey(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && draftKey.trim()) void saveKey(draftKey)
              }}
            />
            <button
              className="btn subtle"
              disabled={!draftKey.trim()}
              onClick={() => void saveKey(draftKey)}
            >
              Save
            </button>
            {keyState?.source === 'stored' ? (
              <button className="btn ghost" onClick={() => void saveKey(null)}>
                Forget
              </button>
            ) : null}
          </div>
        </Field>

        <Field label="Language" hint="ISO code such as en or sv. Blank lets the model decide.">
          <input
            value={voice.language}
            placeholder="auto"
            onChange={(event) => updateVoice({ language: event.target.value })}
          />
        </Field>

        <Field
          label="Vocabulary hint"
          hint="Names the model keeps mangling — repo names, flags, people."
        >
          <input
            value={voice.prompt}
            placeholder="Prisma, Neon, SqFt, xterm"
            onChange={(event) => updateVoice({ prompt: event.target.value })}
          />
        </Field>
      </div>

      <Toggle
        label="Stop recording when I stop talking"
        hint="Otherwise it records until you press the shortcut again."
        checked={voice.autoStop}
        onChange={(autoStop) => updateVoice({ autoStop })}
      />
      <Toggle
        label="Press Enter after dictating"
        hint="Sends the prompt straight away instead of letting you edit it first."
        checked={voice.submit}
        onChange={(submit) => updateVoice({ submit })}
      />

      {keysUrl ? (
        <button className="link" onClick={() => api.openExternal(keysUrl)}>
          Get a key from {keysUrl.replace(/^https?:\/\//, '')}
        </button>
      ) : null}
    </section>
  )
}
