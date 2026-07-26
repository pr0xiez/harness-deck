import { useEffect, useState } from 'react'
import { useDeck } from '../store'
import { useVoice } from '../voice'
import { Icon } from './Icon'

const api = window.harness

/** Per-bar weights so the meter reads as a level, not seven identical blocks. */
const BARS = [0.45, 0.7, 1, 0.85, 1, 0.7, 0.45]

/** Floating status pill: what is being recorded, and how to stop or fix it. */
export function VoiceHud(): React.JSX.Element | null {
  const status = useVoice((s) => s.status)
  const level = useVoice((s) => s.level)
  const message = useVoice((s) => s.message)
  const failed = useVoice((s) => s.failed)
  const action = useVoice((s) => s.action)
  const target = useVoice((s) => s.target)
  const startedAt = useVoice((s) => s.startedAt)
  const stop = useVoice((s) => s.stop)
  const cancel = useVoice((s) => s.cancel)
  const dismiss = useVoice((s) => s.dismiss)
  const setUi = useDeck((s) => s.setUi)
  // The broadcast bar owns the bottom of the deck; sit above it when it is open.
  const raised = useDeck((s) => s.ui.broadcast)
  const [seconds, setSeconds] = useState(0)

  const listening = status === 'listening'

  useEffect(() => {
    if (!listening || !startedAt) {
      setSeconds(0)
      return
    }
    const tick = (): void => setSeconds(Math.floor((Date.now() - startedAt) / 1000))
    tick()
    const id = window.setInterval(tick, 250)
    return () => window.clearInterval(id)
  }, [listening, startedAt])

  // Esc drops the recording. Only while listening — panes need Esc otherwise.
  useEffect(() => {
    if (!listening) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      cancel()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [listening, cancel])

  if (status === 'idle') return null

  return (
    <div
      className={`voice-hud ${status} ${failed ? 'is-error' : ''} ${raised ? 'raised' : ''}`}
      role="status"
    >
      <span className={`voice-orb ${listening ? 'live' : ''}`}>
        <Icon name="mic" size={13} />
      </span>

      {listening ? (
        <>
          <span className="voice-meter" aria-hidden>
            {BARS.map((weight, index) => (
              <i
                key={index}
                style={{ transform: `scaleY(${Math.max(0.12, Math.min(1, level * weight * 1.6))})` }}
              />
            ))}
          </span>
          <span className="voice-text">
            Listening<span className="voice-target"> → {target?.label ?? 'prompt'}</span>
          </span>
          <span className="voice-clock">{seconds}s</span>
          <button className="btn tiny" onClick={stop}>
            Stop
          </button>
          <button className="btn tiny ghost" onClick={cancel} title="Discard (Esc)">
            Cancel
          </button>
        </>
      ) : null}

      {status === 'starting' ? <span className="voice-text">Opening the microphone…</span> : null}

      {status === 'transcribing' ? (
        <>
          <span className="voice-text">Transcribing…</span>
          <span className="voice-progress" aria-hidden />
        </>
      ) : null}

      {status === 'error' && message ? (
        <>
          <span className="voice-text">{message}</span>
          {action === 'settings' ? (
            <button
              className="btn tiny"
              onClick={() => {
                dismiss()
                setUi({ settings: true })
              }}
            >
              Settings
            </button>
          ) : null}
          {action === 'privacy' ? (
            <button
              className="btn tiny"
              onClick={() => api.openExternal('ms-settings:privacy-microphone')}
            >
              Open privacy settings
            </button>
          ) : null}
          <button className="icon-btn tiny" onClick={dismiss} title="Dismiss">
            <Icon name="close" size={12} />
          </button>
        </>
      ) : null}
    </div>
  )
}
