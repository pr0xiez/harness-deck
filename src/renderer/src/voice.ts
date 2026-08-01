import { create } from 'zustand'
import type { VoiceSettings } from '@shared/types'
import { voiceBaseUrl, voiceModel, voiceProvider } from '@shared/voice'
import { createSpeechGate, type SpeechGate } from './speech'
import { isLive, useDeck } from './store'
import { getTerminal } from './terminals'

const api = window.harness

/**
 * Dictation: hold the microphone, hand the recording to a transcription
 * service, then type the text into whatever had focus — an agent's prompt line
 * or the broadcast box. Recording and metering happen here; the network call
 * and the API key stay in the main process.
 */

export type VoiceStatus = 'idle' | 'starting' | 'listening' | 'transcribing' | 'error'

/** A text field that can receive dictation while it has focus. */
export interface VoiceSink {
  id: string
  label: string
  isFocused: () => boolean
  insert: (text: string) => void
  /** Called instead of Enter when "press enter" is on. */
  submit?: () => void
}

export type VoiceTarget =
  | { kind: 'pane'; paneId: string; label: string }
  | { kind: 'sink'; sinkId: string; label: string }

/** What the HUD should offer to open when something went wrong. */
export type VoiceAction = 'settings' | 'privacy' | null

interface VoiceState {
  status: VoiceStatus
  /** Smoothed microphone loudness, 0–1, for the meter. */
  level: number
  message: string | null
  failed: boolean
  action: VoiceAction
  target: VoiceTarget | null
  startedAt: number | null
  lastText: string | null
  toggle: () => void
  stop: () => void
  cancel: () => void
  dismiss: () => void
}

/**
 * A lower bar than SPEECH_LEVEL: anything under this never reaches the service.
 * Asked to transcribe silence, a chat model will cheerfully invent a whole
 * prompt, and that text would be typed straight into an agent.
 */
const AUDIBLE_LEVEL_MIN = 0.03
const AUDIBLE_LEVEL_MAX = 0.08
const AUDIBLE_NOISE_MULTIPLE = 5
/**
 * ...and it has to last. A chair creak or the click of the stream opening can
 * be as loud as a quiet word, but neither sustains.
 */
const MIN_VOICED_MS = 150
/** Silence that ends a recording once you have started talking. */
const SILENCE_MS = 1700
/** Give up waiting for a first word — usually a muted or wrong input device. */
const NO_SPEECH_MS = 10_000
const MAX_MS = 120_000

/** Container formats every OpenAI-compatible endpoint accepts, best first. */
const MIME_CANDIDATES: Array<{ mimeType: string; ext: string }> = [
  { mimeType: 'audio/webm;codecs=opus', ext: 'webm' },
  { mimeType: 'audio/webm', ext: 'webm' },
  { mimeType: 'audio/ogg;codecs=opus', ext: 'ogg' },
  { mimeType: 'audio/mp4', ext: 'mp4' }
]

const sinks = new Map<string, VoiceSink>()

/** Lets a text field claim dictation while it is focused. Returns an unregister. */
export function registerVoiceSink(sink: VoiceSink): () => void {
  sinks.set(sink.id, sink)
  return () => {
    if (sinks.get(sink.id) === sink) sinks.delete(sink.id)
  }
}

function pickFormat(): { mimeType: string; ext: string } {
  const supported = MIME_CANDIDATES.find(
    (candidate) =>
      typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(candidate.mimeType)
  )
  // An empty mimeType lets Chromium pick; it lands on webm/opus.
  return supported ?? { mimeType: '', ext: 'webm' }
}

/** True when the service takes audio inside a chat message rather than a file. */
function wantsWav(voice: VoiceSettings): boolean {
  return voiceProvider(voice.provider).audio === 'wav'
}

/** Speech models want 16 kHz mono; it also keeps the base64 payload small. */
const WAV_SAMPLE_RATE = 16000

interface Meter {
  read: () => number
  close: () => void
}

function createMeter(stream: MediaStream): Meter {
  const context = new AudioContext()
  const analyser = context.createAnalyser()
  analyser.fftSize = 1024
  analyser.smoothingTimeConstant = 0.6
  context.createMediaStreamSource(stream).connect(analyser)
  const samples = new Uint8Array(analyser.fftSize)

  return {
    read: () => {
      analyser.getByteTimeDomainData(samples)
      let sum = 0
      for (let i = 0; i < samples.length; i += 1) {
        const deviation = (samples[i] - 128) / 128
        sum += deviation * deviation
      }
      return Math.sqrt(sum / samples.length)
    },
    close: () => void context.close().catch(() => undefined)
  }
}

/**
 * Chat models take WAV, not Opus, and MediaRecorder cannot produce it. Rather
 * than tap raw frames — an audio worklet cannot be loaded from a file:// page —
 * the recording is decoded and re-rendered at the rate speech models expect.
 */
async function toWav(blob: Blob): Promise<Blob> {
  const context = new AudioContext()
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer())
    const offline = new OfflineAudioContext(
      1,
      Math.max(1, Math.ceil(decoded.duration * WAV_SAMPLE_RATE)),
      WAV_SAMPLE_RATE
    )
    const source = offline.createBufferSource()
    source.buffer = decoded
    source.connect(offline.destination)
    source.start()
    const rendered = await offline.startRendering()
    return encodeWav([rendered.getChannelData(0)], WAV_SAMPLE_RATE)
  } finally {
    void context.close().catch(() => undefined)
  }
}

/** 16-bit PCM mono in a RIFF container. */
function encodeWav(frames: Float32Array[], sampleRate: number): Blob {
  const count = frames.reduce((total, frame) => total + frame.length, 0)
  const buffer = new ArrayBuffer(44 + count * 2)
  const view = new DataView(buffer)
  const ascii = (at: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(at + i, text.charCodeAt(i))
  }

  ascii(0, 'RIFF')
  view.setUint32(4, 36 + count * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, count * 2, true)

  let at = 44
  for (const frame of frames) {
    for (let i = 0; i < frame.length; i += 1) {
      const sample = Math.max(-1, Math.min(1, frame[i]))
      view.setInt16(at, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
      at += 2
    }
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

interface Recording {
  stream: MediaStream
  recorder: MediaRecorder
  meter: Meter
  chunks: Blob[]
  format: { mimeType: string; ext: string }
  target: VoiceTarget
  frame: number
  cancelled: boolean
  settled: boolean
  /** Tracks levels and speech time against this room's noise. */
  gate: SpeechGate
}

let active: Recording | null = null
/** The recording whose transcription is in flight, so it can be abandoned. */
let pending: Recording | null = null

export const useVoice = create<VoiceState>(() => ({
  status: 'idle',
  level: 0,
  message: null,
  failed: false,
  action: null,
  target: null,
  startedAt: null,
  lastText: null,
  toggle: () => {
    const { status } = useVoice.getState()
    if (status === 'listening') finishRecording(false)
    else if (status === 'idle' || status === 'error') void beginRecording()
  },
  stop: () => {
    if (useVoice.getState().status === 'listening') finishRecording(false)
  },
  cancel: () => {
    if (useVoice.getState().status === 'listening') return finishRecording(true)
    // Giving up mid-transcription must not type the text in after the fact.
    if (pending) pending.cancelled = true
    useVoice.setState({ status: 'idle', message: null, failed: false, action: null, level: 0 })
  },
  dismiss: () =>
    useVoice.setState({ status: 'idle', message: null, failed: false, action: null, level: 0 })
}))

let dismissTimer: number | undefined

function fail(message: string, action: VoiceAction = null): void {
  window.clearTimeout(dismissTimer)
  useVoice.setState({ status: 'error', message, failed: true, action, level: 0, target: null })
  dismissTimer = window.setTimeout(() => {
    if (useVoice.getState().message === message) useVoice.getState().dismiss()
  }, 9000)
}

function note(message: string): void {
  window.clearTimeout(dismissTimer)
  useVoice.setState({ status: 'error', message, failed: false, action: null, level: 0, target: null })
  dismissTimer = window.setTimeout(() => {
    if (useVoice.getState().message === message) useVoice.getState().dismiss()
  }, 4000)
}

/** The focused text field if one claimed dictation, otherwise the focused pane. */
function resolveTarget(): VoiceTarget | null {
  for (const sink of sinks.values()) {
    if (sink.isFocused()) return { kind: 'sink', sinkId: sink.id, label: sink.label }
  }
  const state = useDeck.getState()
  const workspace = state.workspaces.find((w) => w.id === state.activeWorkspaceId)
  const pane = workspace?.panes.find((p) => p.id === workspace.activePaneId)
  if (!pane) return null
  const profile = state.profiles.find((p) => p.id === pane.profileId)
  return {
    kind: 'pane',
    paneId: pane.id,
    label: pane.name || pane.processTitle || profile?.name || pane.command
  }
}

function micErrorMessage(err: unknown): { message: string; action: VoiceAction } {
  const name = err instanceof DOMException ? err.name : ''
  const platform = useDeck.getState().info?.platform
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    if (platform === 'win32') {
      return {
        message: 'Windows is blocking microphone access for desktop apps.',
        action: 'privacy'
      }
    }
    return { message: 'Microphone access was denied by the system.', action: null }
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return { message: 'No microphone found.', action: null }
  }
  if (name === 'NotReadableError') {
    return { message: 'The microphone is in use by another app.', action: null }
  }
  return { message: err instanceof Error ? err.message : String(err), action: null }
}

async function beginRecording(): Promise<void> {
  if (active) return
  if (!useDeck.getState().hydrated) {
    fail('Still starting up — try again in a moment.')
    return
  }
  const voice = useDeck.getState().settings.voice

  const target = resolveTarget()
  if (!target) {
    fail('Nothing to dictate into — focus a pane or the broadcast box first.')
    return
  }
  if (!voiceBaseUrl(voice)) {
    fail('No transcription endpoint set for the custom provider.', 'settings')
    return
  }

  useVoice.setState({ status: 'starting', message: null, failed: false, action: null, target })

  const keyState = await api.voice.keyState(voice.provider)
  if (!keyState.hasKey && voice.provider !== 'custom') {
    fail('Dictation needs a transcription API key.', 'settings')
    return
  }

  if (!(await api.voice.requestMicAccess())) {
    fail('Microphone access is turned off for this app in System Settings.')
    return
  }

  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    })
  } catch (err) {
    const { message, action } = micErrorMessage(err)
    fail(message, action)
    return
  }

  // The hotkey may have been pressed again while permission was pending.
  if (useVoice.getState().status !== 'starting') {
    stream.getTracks().forEach((track) => track.stop())
    return
  }

  const format = pickFormat()
  let recorder: MediaRecorder
  try {
    recorder = new MediaRecorder(stream, format.mimeType ? { mimeType: format.mimeType } : undefined)
  } catch (err) {
    stream.getTracks().forEach((track) => track.stop())
    fail(`This machine cannot record audio: ${err instanceof Error ? err.message : String(err)}`)
    return
  }

  const recording: Recording = {
    stream,
    recorder,
    meter: createMeter(stream),
    chunks: [],
    format,
    target,
    frame: 0,
    cancelled: false,
    settled: false,
    gate: createSpeechGate()
  }
  active = recording

  recorder.ondataavailable = (event) => {
    if (event.data.size) recording.chunks.push(event.data)
  }
  recorder.onerror = () => {
    recording.cancelled = true
    fail('The recorder stopped unexpectedly.')
  }
  recorder.onstop = () => settle(recording)
  recorder.start(250)
  const startedAt = Date.now()
  useVoice.setState({ status: 'listening', startedAt, level: 0 })

  let heardAt: number | null = null
  let lastTick = startedAt
  const watch = (): void => {
    if (active !== recording) return
    const rms = recording.meter.read()
    const level = Math.min(1, rms * 4.5)
    if (Math.abs(level - useVoice.getState().level) > 0.015) useVoice.setState({ level })

    const now = Date.now()
    if (recording.gate.sample(rms, now - startedAt, now - lastTick)) heardAt = now
    lastTick = now

    const settings = useDeck.getState().settings.voice
    if (now - startedAt > MAX_MS) return finishRecording(false)
    if (settings.autoStop) {
      if (heardAt && now - heardAt > SILENCE_MS) return finishRecording(false)
      if (!heardAt && now - startedAt > NO_SPEECH_MS) {
        finishRecording(true)
        fail('No sound reached the microphone — check which input device is selected.')
        return
      }
    }
    recording.frame = requestAnimationFrame(watch)
  }
  recording.frame = requestAnimationFrame(watch)
}

function finishRecording(cancelled: boolean): void {
  const recording = active
  if (!recording) return
  recording.cancelled = cancelled
  cancelAnimationFrame(recording.frame)
  if (!cancelled) useVoice.setState({ status: 'transcribing', level: 0 })
  if (recording.recorder.state === 'inactive') return settle(recording)
  try {
    recording.recorder.stop()
  } catch {
    settle(recording)
  }
}

/** Releases the microphone and either transcribes or drops the recording. */
function settle(recording: Recording): void {
  if (recording.settled) return
  recording.settled = true
  cancelAnimationFrame(recording.frame)
  recording.meter.close()
  recording.stream.getTracks().forEach((track) => track.stop())
  if (active === recording) active = null

  if (recording.cancelled) {
    // A failure message set on the way here outlives the cancellation.
    if (useVoice.getState().status !== 'error') {
      useVoice.setState({ status: 'idle', level: 0, target: null })
    }
    return
  }
  const blob = new Blob(recording.chunks, { type: recording.format.mimeType || 'audio/webm' })
  void transcribeAndDeliver(recording, blob)
}

/** Did this recording hold anything louder than the room for long enough? */
export function heardSomething(levels: {
  peak: number
  noiseFloor: number
  voicedMs: number
}): boolean {
  const threshold = Math.min(
    AUDIBLE_LEVEL_MAX,
    Math.max(AUDIBLE_LEVEL_MIN, levels.noiseFloor * AUDIBLE_NOISE_MULTIPLE)
  )
  return levels.voicedMs >= MIN_VOICED_MS && levels.peak > threshold
}

async function transcribeAndDeliver(recording: Recording, recorded: Blob): Promise<void> {
  const voice = useDeck.getState().settings.voice
  pending = recording

  // Never pay to transcribe silence, and never let a model guess at it.
  if (!heardSomething(recording.gate)) {
    pending = null
    note('Nothing came through the microphone — check which input device is selected.')
    return
  }

  let blob = recorded
  let ext = recording.format.ext
  if (wantsWav(voice)) {
    try {
      blob = await toWav(recorded)
      ext = 'wav'
    } catch (err) {
      fail(`Could not convert the recording: ${err instanceof Error ? err.message : String(err)}`)
      pending = null
      return
    }
  }

  const result = await api.voice.transcribe({
    audio: await blob.arrayBuffer(),
    mimeType: blob.type || 'audio/webm',
    fileName: `dictation.${ext}`,
    provider: voice.provider,
    baseUrl: voiceBaseUrl(voice),
    model: voiceModel(voice),
    language: voice.language.trim() || undefined,
    prompt: voice.prompt.trim() || undefined
  })

  if (pending === recording) pending = null
  if (recording.cancelled) return

  if (result.error) {
    fail(result.error, result.status === 401 || result.status === 403 ? 'settings' : null)
    return
  }
  deliver(recording.target, result.text ?? '')
}

function copyInstead(text: string, why: string): void {
  api.clipboard.write(text)
  fail(`${why} — the transcript is on the clipboard.`)
}

function deliver(target: VoiceTarget, raw: string): void {
  // Newlines would submit half a prompt to a TUI, so dictation is one line.
  const text = raw.replace(/\s+/g, ' ').trim()
  if (!text) {
    note('No speech in that recording.')
    return
  }

  const voice = useDeck.getState().settings.voice

  if (target.kind === 'sink') {
    const sink = sinks.get(target.sinkId)
    if (!sink) return copyInstead(text, 'That box is gone')
    sink.insert(text)
    if (voice.submit) sink.submit?.()
  } else {
    const pane = useDeck
      .getState()
      .workspaces.flatMap((w) => w.panes)
      .find((p) => p.id === target.paneId)
    if (!pane) return copyInstead(text, 'That pane is gone')
    if (!isLive(pane)) return copyInstead(text, 'That pane is not running')
    // Dictating into a build you locked is the same accident as typing into it,
    // and the words are worth keeping either way.
    if (pane.readOnly) return copyInstead(text, 'That pane is read-only')
    api.pty.write(target.paneId, text)
    if (voice.submit) window.setTimeout(() => api.pty.write(target.paneId, '\r'), 80)
    getTerminal(target.paneId)?.term.focus()
  }

  window.clearTimeout(dismissTimer)
  useVoice.setState({
    status: 'idle',
    level: 0,
    message: null,
    failed: false,
    action: null,
    target: null,
    lastText: text
  })
}

/**
 * `--voice-check` support: records for a moment and reports what the audio and
 * transcription round trip actually did, so the pipeline can be verified
 * without a UI.
 */
export function installVoiceCheck(): void {
  const host = window as unknown as {
    __deckVoiceCheck?: (
      ms: number,
      override?: { baseUrl?: string; model?: string }
    ) => Promise<Record<string, unknown>>
  }
  // A thrown error would reach the main process as an empty object, so the
  // reason is reported in the JSON instead.
  host.__deckVoiceCheck = async (ms, override) => {
    try {
      return await runVoiceCheck(ms, override)
    } catch (err) {
      return { error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }
    }
  }
}

async function runVoiceCheck(
  ms: number,
  override?: { baseUrl?: string; model?: string }
): Promise<Record<string, unknown>> {
  {
    // Harness detection can take seconds, and settings only exist after it.
    const deadline = Date.now() + 20_000
    while (!useDeck.getState().hydrated && Date.now() < deadline) {
      await new Promise((resume) => window.setTimeout(resume, 100))
    }

    const saved = useDeck.getState().settings.voice
    // An endpoint given on the command line stands in for the settings, so the
    // round trip can be pointed at a local server without changing anything.
    const voice = override?.baseUrl
      ? {
          ...saved,
          provider: 'custom' as const,
          baseUrl: override.baseUrl,
          model: override.model || saved.model
        }
      : saved
    const format = pickFormat()
    const report: Record<string, unknown> = {
      hydrated: useDeck.getState().hydrated,
      provider: voice.provider,
      baseUrl: voiceBaseUrl(voice),
      model: voiceModel(voice),
      format: `${format.mimeType || '(browser default)'}${wantsWav(voice) ? ' → 16 kHz mono WAV' : ''}`,
      keyState: await api.voice.keyState(voice.provider),
      micAccess: await api.voice.requestMicAccess()
    }

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } })
    } catch (err) {
      report.error = `getUserMedia: ${micErrorMessage(err).message}`
      return report
    }

    report.device = stream.getAudioTracks()[0]?.label || '(unnamed)'
    const meter = createMeter(stream)
    const recorder = new MediaRecorder(
      stream,
      format.mimeType ? { mimeType: format.mimeType } : undefined
    )
    const chunks: Blob[] = []
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data)
    }

    const SAMPLE_MS = 50
    const gate = createSpeechGate()
    const startedAt = Date.now()
    const sampler = window.setInterval(() => {
      gate.sample(meter.read(), Date.now() - startedAt, SAMPLE_MS)
    }, SAMPLE_MS)

    const recorded = await new Promise<Blob>((done) => {
      recorder.onstop = () => done(new Blob(chunks, { type: format.mimeType || 'audio/webm' }))
      recorder.start(250)
      window.setTimeout(() => recorder.stop(), ms)
    })

    window.clearInterval(sampler)
    meter.close()
    stream.getTracks().forEach((track) => track.stop())

    const blob = wantsWav(voice) ? await toWav(recorded) : recorded
    report.recordedMs = ms
    report.bytes = blob.size
    report.recordedBytes = recorded.size
    report.peakLevel = Number(gate.peak.toFixed(4))
    report.noiseFloor = Number(gate.noiseFloor.toFixed(4))
    report.voicedMs = gate.voicedMs
    // Dictation stops here when nothing was heard; the check carries on so the
    // rest of the round trip still gets exercised.
    report.silenceGate = heardSomething(gate) ? 'passed' : 'would skip: nothing heard'

    const canTranscribe =
      /^https?:\/\//.test(voiceBaseUrl(voice)) &&
      ((report.keyState as { hasKey: boolean }).hasKey || voice.provider === 'custom')
    if (canTranscribe) {
      report.transcription = await api.voice.transcribe({
        audio: await blob.arrayBuffer(),
        mimeType: blob.type || 'audio/webm',
        fileName: `voice-check.${wantsWav(voice) ? 'wav' : format.ext}`,
        provider: voice.provider,
        baseUrl: voiceBaseUrl(voice),
        model: voiceModel(voice),
        language: voice.language.trim() || undefined
      })
    } else {
      report.transcription = 'skipped — no key or endpoint configured'
    }

    return report
  }
}
