import { shortcutLabel } from '../shortcuts'
import { useVoice } from '../voice'
import { Icon } from './Icon'

interface Props {
  /** `toolbar` gets a label, `inline` is icon-only for tight rows. */
  variant?: 'toolbar' | 'inline'
}

const DICTATE_KEY = shortcutLabel('toggle-dictation')

const TITLES: Record<string, string> = {
  idle: `Dictate into the focused prompt (${DICTATE_KEY})`,
  starting: 'Opening the microphone…',
  listening: `Listening — click or press ${DICTATE_KEY} to stop`,
  transcribing: 'Transcribing…',
  error: `Dictate into the focused prompt (${DICTATE_KEY})`
}

export function MicButton({ variant = 'toolbar' }: Props): React.JSX.Element {
  const status = useVoice((s) => s.status)
  const toggle = useVoice((s) => s.toggle)
  const busy = status === 'listening' || status === 'transcribing' || status === 'starting'

  const className =
    variant === 'toolbar'
      ? `ghost-btn mic-btn ${busy ? 'on' : ''} ${status}`
      : `icon-btn mic-btn ${busy ? 'on' : ''} ${status}`

  return (
    <button
      className={className}
      title={TITLES[status]}
      aria-pressed={status === 'listening'}
      onClick={toggle}
    >
      <Icon name={status === 'listening' ? 'stop' : 'mic'} />
      {variant === 'toolbar' ? (
        <span>{status === 'listening' ? 'Stop' : status === 'transcribing' ? 'Writing…' : 'Dictate'}</span>
      ) : null}
    </button>
  )
}
