import { useEffect, useRef, useState } from 'react'
import { personalModelConfigured, type PersonalSettings, type PersonalSubscriptionStatus } from '@shared/personal-agent'
import { Icon } from './Icon'

const api = window.harness
const STEPS = ['How it thinks', 'Your rhythm', 'Your goals'] as const
const SUBSCRIPTIONS = [
  { id: 'chatgpt', name: 'ChatGPT subscription', cli: 'Codex', login: 'codex login' },
  { id: 'claude', name: 'Claude subscription', cli: 'Claude Code', login: 'claude auth login' }
] as const
type Subscription = (typeof SUBSCRIPTIONS)[number]['id']
const MAX_CONTEXT = 12000
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/
const detectedZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone
function validZone(value: string): boolean {
  if (!value.trim()) return false
  try { new Intl.DateTimeFormat('en', { timeZone: value.trim() }); return true } catch { return false }
}

interface SetupProps {
  settings: PersonalSettings
  busy: boolean
  /** Saves through the page's mutate path; false means the page is showing why. */
  onSave: (patch: Partial<PersonalSettings>) => Promise<boolean>
  onPlan: () => Promise<void>
  onOpenSettings: () => void
}

/** First-run setup: three short steps, each saved as it is finished. */
export function PersonalSetup({ settings, busy, onSave, onPlan, onOpenSettings }: SetupProps): React.JSX.Element {
  const [step, setStep] = useState(0)
  const skip = (): void => { void onSave({ onboarded: true }) }
  return <section className="personal-onboarding" aria-labelledby="personal-onboarding-title">
    <header className="personal-onboarding-head">
      <span className="personal-eyebrow">STEP {step + 1} OF {STEPS.length}</span>
      <h1 id="personal-onboarding-title">Meet your personal agent</h1>
      <p>Three quick choices and you’re ready. You can change any of them later in Agent settings.</p>
      <ol className="personal-progress" aria-label="Setup progress">
        {STEPS.map((title, index) => <li key={title} className={index < step ? 'done' : index === step ? 'current' : ''} aria-current={index === step ? 'step' : undefined}>
          <span>{index < step ? <Icon name="check" size={11} /> : index + 1}</span>{title}
        </li>)}
      </ol>
    </header>
    <div className="personal-card personal-onboarding-card">
      {step === 0 && <ThinkStep settings={settings} busy={busy} onSave={onSave} onOpenSettings={onOpenSettings} onNext={() => setStep(1)} onSkip={skip} />}
      {step === 1 && <RhythmStep settings={settings} busy={busy} onSave={onSave} onBack={() => setStep(0)} onNext={() => setStep(2)} onSkip={skip} />}
      {step === 2 && <GoalsStep settings={settings} busy={busy} onSave={onSave} onPlan={onPlan} onOpenSettings={onOpenSettings} onBack={() => setStep(1)} onSkip={skip} />}
    </div>
  </section>
}

function Footer({ busy, onSkip, onBack, children }: { busy: boolean; onSkip: () => void; onBack?: () => void; children: React.ReactNode }): React.JSX.Element {
  return <footer className="personal-onboarding-foot">
    <button type="button" className="personal-link" disabled={busy} onClick={onSkip}>Skip setup</button>
    <div className="personal-inline">{onBack && <button type="button" className="btn ghost" disabled={busy} onClick={onBack}>Back</button>}{children}</div>
  </footer>
}

function ThinkStep({ settings, busy, onSave, onOpenSettings, onNext, onSkip }: {
  settings: PersonalSettings; busy: boolean; onSave: SetupProps['onSave']; onOpenSettings: () => void; onNext: () => void; onSkip: () => void
}): React.JSX.Element {
  const [choice, setChoice] = useState<Subscription | null>(null)
  const [status, setStatus] = useState<PersonalSubscriptionStatus>()
  const [checking, setChecking] = useState(false)
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState(false)
  const run = useRef(0)
  useEffect(() => () => { run.current++ }, [])
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1400)
    return () => window.clearTimeout(timer)
  }, [copied])
  const option = SUBSCRIPTIONS.find(s => s.id === choice)
  const check = async (provider: Subscription): Promise<void> => {
    const current = ++run.current
    setChoice(provider); setStatus(undefined); setSaved(false); setChecking(true)
    let value: PersonalSubscriptionStatus
    try { value = await api.personal.subscriptionStatus(provider, 'auto') }
    catch { value = { available: false, signedIn: false, message: 'Could not check sign-in. Check your CLI installation and try again.' } }
    if (current !== run.current) return
    setStatus(value); setChecking(false)
    if (!value.signedIn) return
    const ok = await onSave({ provider, cliEnvironment: value.environment ?? 'auto', ...(provider !== settings.provider ? { subscriptionModel: '' } : {}) })
    if (current === run.current) setSaved(ok)
  }
  const later = async (): Promise<void> => {
    if (!choice) return
    if (await onSave({ provider: choice, ...(choice !== settings.provider ? { subscriptionModel: '' } : {}) })) onNext()
  }
  const openRouter = !choice && settings.provider === 'openrouter'
  const ready = (!!choice && saved) || (openRouter && personalModelConfigured(settings))
  return <>
    <h2>How should it think?</h2>
    <p className="personal-muted">Use a subscription you already have. Deck works through its signed-in CLI, so there’s no API key and no extra billing.</p>
    <div className="personal-choices" role="group" aria-label="Subscription">
      {SUBSCRIPTIONS.map(s => <button type="button" key={s.id} className={`personal-choice${choice === s.id ? ' selected' : ''}`} aria-pressed={choice === s.id} disabled={busy} onClick={() => void check(s.id)}>
        <strong>{s.name}</strong><small>Through {s.cli}</small>
      </button>)}
    </div>
    <button type="button" className="personal-link" onClick={onOpenSettings}>Advanced: OpenRouter credits</button>
    {openRouter && <p className="personal-muted" role="status">{personalModelConfigured(settings) ? `Using OpenRouter credits with ${settings.model}.` : 'Choose an OpenRouter model in Agent settings to continue.'}</p>}
    {option && <div className="personal-signin">
      <p role="status">{checking ? `Checking your ${option.cli} sign-in…` : status?.signedIn ? <><Icon name="check" size={12} /> {status.message}</> : status?.message}</p>
      {status && !status.signedIn && <>
        <p className="personal-muted">Sign in from a Deck terminal pane, choosing your subscription rather than an API key. Then check again.</p>
        <div className="personal-command"><code>{option.login}</code><button type="button" className="btn subtle tiny" onClick={() => void api.clipboard.write(option.login).then(ok => { if (ok) setCopied(true) })}><Icon name="copy" size={12} />{copied ? 'Copied' : 'Copy'}</button></div>
        <div className="personal-inline"><button type="button" className="btn subtle" disabled={busy || checking} onClick={() => void check(option.id)}>Check again</button><button type="button" className="btn ghost" disabled={busy || checking} onClick={() => void later()}>I’ll sign in later</button></div>
      </>}
    </div>}
    <Footer busy={busy} onSkip={onSkip}><button type="button" className="btn primary" disabled={busy || !ready} onClick={onNext}>Continue</button></Footer>
  </>
}

function RhythmStep({ settings, busy, onSave, onBack, onNext, onSkip }: {
  settings: PersonalSettings; busy: boolean; onSave: SetupProps['onSave']; onBack: () => void; onNext: () => void; onSkip: () => void
}): React.JSX.Element {
  const detected = detectedZone()
  const [timeZone, setTimeZone] = useState(settings.timeZone || detected)
  const [times, setTimes] = useState({ morning: settings.morning, checkIn: settings.checkIn, evening: settings.evening })
  const [weekdaysOnly, setWeekdaysOnly] = useState(settings.weekdaysOnly)
  const [proactive, setProactive] = useState(true)
  const [nudges, setNudges] = useState(true)
  const problem = !validZone(timeZone) ? 'Enter a time zone such as America/New_York.'
    : !Object.values(times).every(t => TIME.test(t)) ? 'Choose a time for each check-in.'
      : !(times.morning < times.checkIn && times.checkIn < times.evening) ? 'Keep the times in order: morning plan, then check-in, then evening review.' : ''
  const save = async (): Promise<void> => {
    if (problem) return
    if (await onSave({ timeZone: timeZone.trim(), ...times, weekdaysOnly, proactive, nudges, notifications: true })) onNext()
  }
  return <form className="personal-form" onSubmit={e => { e.preventDefault(); void save() }}>
    <h2>Your rhythm</h2>
    <p className="personal-muted">Short check-ins at the moments that matter: a morning plan, a midday check-in, and an evening review.</p>
    <label>Time zone<input value={timeZone} maxLength={100} onChange={e => setTimeZone(e.target.value)} placeholder="America/New_York" /></label>
    {timeZone.trim() !== detected && <button type="button" className="personal-link" onClick={() => setTimeZone(detected)}>Use this computer’s time zone ({detected})</button>}
    <div className="personal-schedule">{(['morning', 'checkIn', 'evening'] as const).map(key => <label key={key}>{key === 'morning' ? 'Morning plan' : key === 'checkIn' ? 'Check-in' : 'Evening review'}<input type="time" required value={times[key]} onChange={e => setTimes(t => ({ ...t, [key]: e.target.value }))} /></label>)}</div>
    {problem && <p className="oc-note bad" role="alert">{problem}</p>}
    <label className="personal-check"><input type="checkbox" checked={weekdaysOnly} onChange={e => setWeekdaysOnly(e.target.checked)} />Weekdays only</label>
    <label className="personal-check"><input type="checkbox" checked={proactive} onChange={e => setProactive(e.target.checked)} />Daily check-ins</label>
    <label className="personal-check"><input type="checkbox" checked={nudges} disabled={!proactive} onChange={e => setNudges(e.target.checked)} />Nudges for meetings, waiting agents and due tasks</label>
    <p className="personal-muted">Desktop notifications are on. Keep Deck running (minimized is fine); check-ins pause during focus blocks and you can snooze them anytime.</p>
    <Footer busy={busy} onSkip={onSkip} onBack={onBack}><button className="btn primary" disabled={busy || !!problem}>Save & continue</button></Footer>
  </form>
}

function GoalsStep({ settings, busy, onSave, onPlan, onOpenSettings, onBack, onSkip }: {
  settings: PersonalSettings; busy: boolean; onSave: SetupProps['onSave']; onPlan: () => Promise<void>; onOpenSettings: () => void; onBack: () => void; onSkip: () => void
}): React.JSX.Element {
  const [goals, setGoals] = useState('')
  const existing = settings.context.trimEnd()
  const room = Math.max(0, MAX_CONTEXT - (existing ? existing.length + 2 : 0))
  const finish = async (plan: boolean): Promise<void> => {
    const text = goals.trim()
    const context = text ? (existing ? `${existing}\n\n${text}` : text) : undefined
    const ok = await onSave({ onboarded: true, ...(context !== undefined ? { context } : {}) })
    if (ok && plan) await onPlan()
  }
  return <>
    <h2>What are you working toward?</h2>
    <p className="personal-muted">Goals, responsibilities, and the boundaries worth protecting. Optional, and you can add more anytime.</p>
    <div className="personal-form">
      <label>Your goals<textarea rows={5} maxLength={room} value={goals} onChange={e => setGoals(e.target.value)} placeholder="Ship the beta by November. Protect mornings for deep work. Be direct with me." /></label>
      {existing && <p className="personal-muted">This is added to the goals you’ve already saved.</p>}
    </div>
    <div className="personal-onboarding-note">
      <p><strong>Gmail & Calendar are optional.</strong> Connect them later in Agent settings so your agent can plan around meetings and mail.</p>
      <button type="button" className="btn ghost" onClick={onOpenSettings}>Open Agent settings</button>
    </div>
    <Footer busy={busy} onSkip={onSkip} onBack={onBack}>
      <button type="button" className="btn subtle" disabled={busy} onClick={() => void finish(false)}>Finish</button>
      <button type="button" className="btn primary" disabled={busy || !personalModelConfigured(settings)} onClick={() => void finish(true)}>Finish & plan my day</button>
    </Footer>
  </>
}
