"use client"

// The mock phone (ticket 11): the Site or Driver persona's phone page. It polls
// /api/phone, rings for the live call on this phone (demo cases and calls the
// operator rang live), and sends the callee's moves back: answer, decline, ignore
// (let it ring out), keypad digits.
//
// Structure, so tier 2 (ticket 12, push-to-talk) slots in:
//   usePhone(as)        the phone's state and `send(input)`
//   usePromptAudio      plays the agent's prompts aloud, in order, once answered
//   PhoneApp            picks a screen by the call's mode (`phoneMode`):
//     idle    -> IdleScreen       (with the last call's result)
//     ringing -> RingingScreen    (caller ID, order, answer / decline / ignore)
//     tier1   -> KeypadScreen     (prompt caption, options, keypad)
//     tier2   -> Tier2Screen      (ticket 12: push-to-talk with the voice agent; mic opens when it shows;
//                                  a chime marks the transfer from the keypad)
//     ended   -> EndedScreen      (outcome, until the person taps Done)
// Answering is the user gesture that unlocks audio (and, in tier 2, the microphone).

import { useCallback, useEffect, useRef, useState } from "react"
import type { Call, CalleeInput } from "@/lib/engine/calls"
import type { PhonePersona, PhoneView } from "@/lib/engine/phone"
import { DriverJobsList } from "./jobs"
import { Icon } from "./icons"
import { Pill } from "./ui"

const POLL_MS = 1000
/** A WAV with no samples: played inside the Answer tap so the audio element may play later (iOS). */
const SILENCE = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA="

export type PhoneMode = "idle" | "ringing" | "tier1" | "tier2" | "ended"

/**
 * Which screen the phone shows. `ended` is a call this page saw end and the person has not
 * dismissed: its result shows first, even when the next queued call already rings behind it.
 */
export function phoneMode(call: Call | null, ended: Call | null): PhoneMode {
  if (ended) return "ended"
  if (call) return call.state === "ringing" ? "ringing" : call.state === "tier2" ? "tier2" : "tier1"
  return "idle"
}

/** The phone's state, polled; `send` posts a callee move and returns the refusal, if any. */
export function usePhone(as: PhonePersona) {
  const [view, setView] = useState<PhoneView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const busy = useRef(false)
  // Bumped by every move the phone sends: a poll that started before a move (or while it
  // was on its way) answers with the call as it was, and must not undo what the move showed.
  const epoch = useRef(0)
  const read = useCallback(async () => {
    if (busy.current) return
    busy.current = true
    const started = epoch.current
    try {
      const response = await fetch(`/api/phone?as=${as}`, { cache: "no-store" })
      if (started !== epoch.current) return
      if (response.ok) { setView(await response.json() as PhoneView); setError(null) }
      else setError("The phone lost its connection. Retrying.")
    } catch {
      setError("The phone lost its connection. Retrying.")
    } finally {
      busy.current = false
    }
  }, [as])
  useEffect(() => {
    setView(null)
    void read()
    const timer = setInterval(read, POLL_MS)
    return () => clearInterval(timer)
  }, [read])
  const send = useCallback(async (callId: string, input: CalleeInput): Promise<string | null> => {
    epoch.current++
    const response = await fetch("/api/phone", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ callId, input, as }) })
    const data = await response.json().catch(() => null) as (PhoneView & { error?: string }) | null
    epoch.current++
    if (!response.ok || !data) return data?.error ?? "The phone could not send that"
    setView(data)
    return null
  }, [as])
  /** A tier-2 turn: the recording as base64 WAV. Resolves once the agent answered (a few seconds). */
  const sendVoice = useCallback(async (callId: string, wav: string): Promise<string | null> => {
    epoch.current++
    const response = await fetch("/api/phone/voice", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ callId, audio: { data: wav, format: "wav" }, as }) })
    const data = await response.json().catch(() => null) as (PhoneView & { error?: string }) | null
    epoch.current++
    if (!response.ok || !data) return data?.error ?? "The agent did not get that. Hold the button and say it again."
    setView(data)
    return null
  }, [as])
  return { view, error, send, sendVoice }
}

/** In the prompt queue: the transfer chime, played where the call moves to the voice agent. */
const TRANSFER = "transfer"
const TRANSFER_MS = 1100

/** A short rising three-note chime: the call is being put through to the voice agent. */
function playTransfer(context: AudioContext | null) {
  if (!context || context.state !== "running") return
  const gain = context.createGain()
  gain.gain.value = 0.08
  gain.connect(context.destination)
  ;[523.25, 659.25, 783.99].forEach((frequency, i) => {
    const tone = context.createOscillator()
    tone.type = "sine"
    tone.frequency.value = frequency
    tone.connect(gain)
    tone.start(context.currentTime + i * 0.18)
    tone.stop(context.currentTime + i * 0.18 + 0.32)
  })
}

/**
 * Plays the agent's prompts aloud through one audio element, oldest first, each once.
 * Before the call is answered nothing plays; on a call first seen mid-way, only its
 * latest prompt plays. `stop()` cuts the current prompt (a key press answers it).
 * Where the call moves to tier 2 a transfer chime plays before the voice agent speaks.
 */
function usePromptAudio(call: Call | null, answered: boolean) {
  const audio = useRef<HTMLAudioElement | null>(null)
  const chime = useRef<AudioContext | null>(null)
  const played = useRef(new Set<string>())
  const queue = useRef<string[]>([])
  const seen = useRef(new Set<string>())
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [playing, setPlaying] = useState(false)

  const next = useCallback(() => {
    const element = audio.current
    const id = queue.current.shift()
    if (!element || !id) { setPlaying(false); return }
    if (id === TRANSFER) {
      setPlaying(true)
      playTransfer(chime.current)
      timer.current = setTimeout(() => { timer.current = undefined; next() }, TRANSFER_MS)
      return
    }
    element.src = `/api/phone/audio/${id}`
    element.play().then(() => setPlaying(true)).catch(() => next())
  }, [])

  useEffect(() => {
    if (!call || !answered) return
    const lines = call.transcript.map((line, i) => ({ key: `${call.id}:${i}`, line })).filter(({ line }) => line.by === "agent" && line.audioId)
    if (!seen.current.has(call.id)) {
      seen.current.add(call.id)
      // First sight of a call already in progress (a reload): only the latest prompt is still useful.
      if (call.state !== "ringing") for (const { key } of lines.slice(0, -1)) played.current.add(key)
      if (call.state === "tier2") played.current.add(`${call.id}:transfer`)
    }
    let added = false
    for (const { key, line } of lines) {
      if (played.current.has(key)) continue
      played.current.add(key)
      if (line.tier === 2 && !played.current.has(`${call.id}:transfer`)) {
        played.current.add(`${call.id}:transfer`)
        queue.current.push(TRANSFER)
      }
      queue.current.push(line.audioId!)
      added = true
    }
    if (added && audio.current && (audio.current.paused || audio.current.ended) && timer.current === undefined) next()
  }, [call, answered, next])

  const unlock = useCallback(() => {
    const element = audio.current
    if (!element) return
    element.src = SILENCE
    element.play().catch(() => {})
    // The Answer tap also lets the chime play later.
    const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    try { chime.current ??= Context ? new Context() : null } catch { chime.current = null }
    void chime.current?.resume().catch(() => {})
  }, [])
  const stop = useCallback(() => {
    queue.current = []
    clearTimeout(timer.current)
    timer.current = undefined
    audio.current?.pause()
    setPlaying(false)
  }, [])
  useEffect(() => () => { clearTimeout(timer.current); void chime.current?.close().catch(() => {}) }, [])
  return { audio, playing, unlock, stop, onEnded: next }
}

/** A soft two-tone ring while the phone rings (only once the page may make sound), and a buzz where phones vibrate. */
function useRingTone(ringing: boolean) {
  useEffect(() => {
    if (!ringing) return
    const Context = typeof window !== "undefined" ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) : undefined
    let context: AudioContext | null = null
    try { context = Context ? new Context() : null } catch { context = null }
    const ring = () => {
      navigator.vibrate?.([400, 200, 400])
      if (!context || context.state !== "running") { void context?.resume().catch(() => {}); return }
      const gain = context.createGain()
      gain.gain.value = 0.06
      gain.connect(context.destination)
      for (const [frequency, start] of [[440, 0], [480, 0], [440, 0.6], [480, 0.6]]) {
        const tone = context.createOscillator()
        tone.frequency.value = frequency
        tone.connect(gain)
        tone.start(context.currentTime + start)
        tone.stop(context.currentTime + start + 0.4)
      }
    }
    ring()
    const timer = setInterval(ring, 3000)
    return () => { clearInterval(timer); navigator.vibrate?.(0); void context?.close().catch(() => {}) }
  }, [ringing])
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(timer)
  }, [active])
  return now
}

const clock = (seconds: number) => {
  const s = Math.max(0, Math.round(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

const PHONE_LABEL: Record<PhonePersona, string> = { site: "Site phone", driver: "Driver phone" }

/** The whole phone page body: which phone (Operator may switch), the screen, the queue. */
export function PhoneApp({ persona }: { persona: PhonePersona | "operator" }) {
  const [as, setAs] = useState<PhonePersona>(persona === "operator" ? "site" : persona)
  const { view, error, send, sendVoice } = usePhone(as)
  const call = view?.current ?? null
  const [ended, setEnded] = useState<Call | null>(null)
  const [ignored, setIgnored] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const lastLive = useRef<string | null>(null)

  // A call this page saw live that has now ended shows its result until Done (the next call waits behind it).
  // `justEnded`: the poll that shows the call gone is the same render that shows its result (no frame in between).
  const justEnded = lastLive.current && view?.last?.id === lastLive.current && call?.id !== lastLive.current ? view.last : null
  useEffect(() => {
    if (justEnded) { setEnded(justEnded); lastLive.current = null; return }
    if (call && !ended) lastLive.current = call.id
  }, [call, justEnded, ended])
  const mode = phoneMode(call, ended ?? justEnded)
  const answered = !!call && call.state !== "ringing"
  const prompts = usePromptAudio(call, answered)
  useRingTone(mode === "ringing" && ignored !== call?.id)

  const act = async (input: CalleeInput) => {
    if (!call) return
    setRefusal(null)
    if (input.type === "answer") prompts.unlock()
    if (input.type === "key") prompts.stop()
    const refused = await send(call.id, input)
    if (refused) setRefusal(refused)
  }
  /** Hanging up silences the agent at once; the call ends even while the agent is still answering. */
  const hangUp = () => { prompts.stop(); void act({ type: "hang_up" }) }

  return <>
    {persona === "operator" && <div className="phone-switch" role="group" aria-label="Which phone">
      {(["site", "driver"] as const).map((name) => <button key={name} type="button" aria-pressed={as === name} onClick={() => { setAs(name); setEnded(null); lastLive.current = null }}>{PHONE_LABEL[name]}</button>)}
    </div>}
    <section className={`phone phone-${mode}`} aria-label={`Mock ${PHONE_LABEL[as].toLowerCase()}`} data-mode={mode}>
      {!view ? <p className="phone-wait">Connecting…</p>
        : mode === "ringing" && call ? <RingingScreen call={call} view={view} ignored={ignored === call.id} onIgnore={() => setIgnored(call.id)} act={act} />
        : mode === "tier1" && call ? <KeypadScreen call={call} playing={prompts.playing} act={act} hangUp={hangUp} />
        : mode === "tier2" && call ? <Tier2Screen call={call} playing={prompts.playing} stopPrompt={prompts.stop} hangUp={hangUp} sendVoice={sendVoice} />
        : mode === "ended" && (ended ?? justEnded) ? <EndedScreen call={(ended ?? justEnded)!} next={call} onDone={() => setEnded(null)} />
        : <IdleScreen persona={as} last={view.last} />}
      {/* One element plays every prompt, so the Answer tap unlocks it for the whole call. */}
      <audio ref={prompts.audio} id="phone-audio" preload="auto" onEnded={prompts.onEnded} />
    </section>
    {(refusal || error) && <p className="phone-error" role="alert">{refusal ?? error}</p>}
    {view && view.queued.length > 0 && <section className="phone-queue" aria-label="Calls waiting">
      <h2>Waiting ({view.queued.length})</h2>
      <ul>{view.queued.map((row) => <li key={row.id}><Icon name="waiting" className="tone-accent" /><span><b>{row.reference}</b> · {row.callee.name ? row.callee.name.split(",")[0] : row.callee.handle}</span></li>)}</ul>
      <p>The phone takes one call at a time. The next one rings when this call ends.</p>
    </section>}
    {as === "driver" && <DriverJobsList />}
    <p className="picker-note">Mock phone. No real numbers are dialled.</p>
  </>
}

function CallerId({ call }: { call: Call }) {
  return <div className="phone-caller">
    <span className="phone-avatar"><Icon name="bot" size={30} /></span>
    <b className="phone-from">Bahn control room</b>
    <span className="phone-ref">{call.reference}{call.car ? ` · ${call.car}` : ""}</span>
    <span className="phone-to">Delivery assistant{call.attempt > 1 ? ` · attempt ${call.attempt}` : ""}</span>
  </div>
}

function RingingScreen({ call, view, ignored, onIgnore, act }: { call: Call; view: PhoneView; ignored: boolean; onIgnore: () => void; act: (input: CalleeInput) => void }) {
  const now = useNow(true)
  const left = view.ringsOutAt ? Math.ceil((new Date(view.ringsOutAt).getTime() - now) / 1000) : null
  return <div className="phone-screen">
    <span className="phone-status"><span className="phone-ring-dot" aria-hidden="true" />{ignored ? "Ringing silently" : "Incoming call"}</span>
    {/* The call's reason is the operator's wording (a rule that failed); the agent explains it on the call. */}
    <CallerId call={call} />
    <div className="phone-actions">
      <button type="button" className="btn btn-tertiary phone-decline" onClick={() => act({ type: "decline" })}><Icon name="close" />Decline</button>
      <button type="button" className="btn btn-primary phone-answer" onClick={() => act({ type: "answer" })}><Icon name="phone" />Answer</button>
    </div>
    {!ignored ? <button type="button" className="btn-link phone-ignore" onClick={onIgnore}>Ignore and let it ring</button>
      : <p className="phone-hint">{left !== null ? (left > 0 ? `Rings out in ${left} s, then the agent calls back later.` : "Ringing out…") : "Rings until answered."}</p>}
  </div>
}

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"]

function KeypadScreen({ call, playing, act, hangUp }: { call: Call; playing: boolean; act: (input: CalleeInput) => void; hangUp: () => void }) {
  const now = useNow(true)
  const answeredAt = call.transcript.find((line) => line.by === "callee")?.wallAt ?? call.lastWallAt
  const asking = call.expecting?.type === "key" ? call.expecting : null
  const said = [...call.transcript].reverse().find((line) => line.by === "agent")
  const [sent, setSent] = useState<string | null>(null)
  useEffect(() => setSent(null), [call.transcript.length])
  const press = (digit: string) => { if (!asking || sent) return; setSent(digit); act({ type: "key", digit }) }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (KEYS.includes(event.key) && !(event.target instanceof HTMLInputElement)) press(event.key) }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })
  return <div className="phone-screen phone-in-call">
    <div className="phone-call-head">
      <span><b>{call.reference}</b> · Bahn control room</span>
      <span className="phone-timer">{clock((now - new Date(answeredAt).getTime()) / 1000)}</span>
    </div>
    {playing && <div className="phone-call-pills"><Pill tone="accent">Speaking</Pill></div>}
    <p className="phone-prompt" aria-live="polite">{said?.text ?? "…"}</p>
    {asking && <ul className="phone-options" aria-label="Keypad options">
      {asking.options.map((option) => <li key={option.digit}><kbd>{option.digit}</kbd>{option.label}</li>)}
    </ul>}
    <div className="phone-keypad" role="group" aria-label="Keypad">
      {KEYS.map((digit) => <button key={digit} type="button" disabled={!asking || !!sent} aria-pressed={sent === digit} onClick={() => press(digit)}>{digit}</button>)}
    </div>
    {!asking && <p className="phone-hint">{call.transcript.at(-1)?.by === "callee" ? "One moment…" : "The agent is speaking…"}</p>}
    <button type="button" className="btn btn-tertiary phone-hangup" onClick={hangUp}><Icon name="close" />Hang up</button>
  </div>
}

/** Shortest recording worth sending, seconds. */
const MIN_TALK_SECONDS = 0.5

/**
 * Push-to-talk recording: the microphone opens once per call (asked when tier 2 starts,
 * or on the first press), each hold records one clip, and the clip goes out as a 16 kHz
 * mono WAV (what the ear and the audio model both accept).
 */
function useRecorder(active: boolean) {
  const stream = useRef<MediaStream | null>(null)
  const recorder = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  const startedAt = useRef(0)
  const [recording, setRecording] = useState(false)
  const [micError, setMicError] = useState<string | null>(null)

  const open = useCallback(async (): Promise<MediaStream | null> => {
    if (stream.current) return stream.current
    if (!navigator.mediaDevices?.getUserMedia) { setMicError("This browser has no microphone access. Hang up and a colleague will follow up."); return null }
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
      setMicError(null)
      return stream.current
    } catch {
      setMicError("Allow the microphone to talk to the agent, then hold the button again.")
      return null
    }
  }, [])

  useEffect(() => {
    if (!active) return
    void open()
    return () => { stream.current?.getTracks().forEach((track) => track.stop()); stream.current = null }
  }, [active, open])

  const start = useCallback(async () => {
    if (recorder.current) return
    const media = await open()
    if (!media) return
    chunks.current = []
    const next = new MediaRecorder(media)
    next.ondataavailable = (event) => { if (event.data.size) chunks.current.push(event.data) }
    recorder.current = next
    startedAt.current = Date.now()
    next.start()
    setRecording(true)
  }, [open])

  /** Stops the recording; the clip as base64 WAV, or null when it was too short. */
  const stop = useCallback(async (): Promise<string | null> => {
    const current = recorder.current
    recorder.current = null
    setRecording(false)
    if (!current || current.state === "inactive") return null
    const stopped = new Promise<void>((resolve) => { current.onstop = () => resolve() })
    current.stop()
    await stopped
    if ((Date.now() - startedAt.current) / 1000 < MIN_TALK_SECONDS) return null
    return toWavBase64(new Blob(chunks.current, { type: current.mimeType }))
  }, [])

  return { recording, micError, start, stop }
}

/** Any recording the browser made, decoded and resampled to a 16 kHz mono 16-bit WAV, base64. */
async function toWavBase64(blob: Blob): Promise<string> {
  const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  const context = new Context()
  const decoded = await context.decodeAudioData(await blob.arrayBuffer())
  void context.close()
  const rate = 16_000
  const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * rate)), rate)
  const source = offline.createBufferSource()
  source.buffer = decoded
  source.connect(offline.destination)
  source.start()
  const samples = (await offline.startRendering()).getChannelData(0)
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2))
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)) }
  text(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); text(8, "WAVE")
  text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  text(36, "data"); view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true)
  const bytes = new Uint8Array(view.buffer)
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/**
 * Tier 2 (ticket 12): the voice agent. The person holds the talk button (or Space)
 * while speaking; on release the clip goes to the agent, which answers aloud. The
 * conversation so far shows under the latest reply.
 */
function Tier2Screen({ call, playing, stopPrompt, hangUp, sendVoice }: {
  call: Call; playing: boolean; stopPrompt: () => void; hangUp: () => void
  sendVoice: (callId: string, wav: string) => Promise<string | null>
}) {
  const now = useNow(true)
  const answeredAt = call.transcript.find((line) => line.by === "callee")?.wallAt ?? call.lastWallAt
  const listening = call.expecting?.type === "speech"
  const { recording, micError, start, stop } = useRecorder(true)
  const [sending, setSending] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const holding = useRef(false)
  const startedTier2 = call.transcript.findIndex((line) => line.tier === 2)
  const lines = call.transcript.slice(startedTier2).filter((line) => line.by !== "system")
  const said = [...lines].reverse().find((line) => line.by === "agent")
  const canTalk = listening && !sending

  const press = () => {
    if (!canTalk || holding.current) return
    holding.current = true
    setNote(null)
    stopPrompt()
    void start()
  }
  const release = async () => {
    if (!holding.current) return
    holding.current = false
    setSending(true)
    const wav = await stop().catch(() => null)
    if (!wav) { setSending(false); setNote("Hold the button while you speak, then let go."); return }
    const refused = await sendVoice(call.id, wav)
    setSending(false)
    // A turn refused because the call ended (hung up meanwhile) needs no note: the call is gone.
    if (refused && !/moved on|not listening|not on the/.test(refused)) setNote(refused)
  }
  useEffect(() => {
    const down = (event: KeyboardEvent) => { if (event.code === "Space" && !event.repeat && !(event.target instanceof HTMLButtonElement)) { event.preventDefault(); press() } }
    const up = (event: KeyboardEvent) => { if (event.code === "Space") { event.preventDefault(); void release() } }
    window.addEventListener("keydown", down)
    window.addEventListener("keyup", up)
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up) }
  })

  const status = recording ? "Listening to you" : sending ? "The agent is thinking…" : playing ? "The agent is speaking" : listening ? "Your turn" : "The agent is speaking"
  return <div className="phone-screen phone-in-call phone-tier2">
    <div className="phone-call-head">
      <span><b>{call.reference}</b> · Bahn control room</span>
      <span className="phone-timer">{clock((now - new Date(answeredAt).getTime()) / 1000)}</span>
    </div>
    <div className="phone-call-pills"><Pill tone={recording ? "warn" : "accent"}>{status}</Pill></div>
    <p className="phone-prompt" aria-live="polite">{said?.text ?? "…"}</p>
    <div className="phone-talk-wrap">
      <button type="button" className="phone-talk" data-recording={recording || undefined} disabled={!canTalk && !recording}
        aria-pressed={recording} aria-describedby="phone-talk-hint"
        onPointerDown={(event) => { event.currentTarget.setPointerCapture?.(event.pointerId); press() }}
        onPointerUp={() => void release()} onPointerCancel={() => void release()}
        onContextMenu={(event) => event.preventDefault()}>
        <Icon name="mic" size={28} />
        <span>{recording ? "Release to send" : sending ? "Sending…" : "Hold to talk"}</span>
      </button>
      <p className="phone-hint" id="phone-talk-hint">{micError ?? note ?? (canTalk ? "Hold while you speak (or hold Space), then let go." : "Wait for the agent to finish.")}</p>
    </div>
    {lines.length > 1 && <ol className="phone-convo" aria-label="Conversation so far">
      {lines.slice(0, -1).slice(-4).map((line, i) => <li key={i} className={`phone-convo-${line.by}`}><b>{line.by === "agent" ? "Agent" : "You"}</b> {line.text}</li>)}
    </ol>}
    <button type="button" className="btn btn-tertiary phone-hangup" onClick={hangUp}><Icon name="close" />Hang up</button>
  </div>
}

const OUTCOME_TEXT: Record<NonNullable<Call["outcome"]>, string> = {
  resolved: "Done. The answers are on the order.",
  callback: "The agent will call back.",
  handover: "A colleague from the control room will follow up.",
  unreachable: "No more attempts. A person follows up.",
}

function EndedScreen({ call, next, onDone }: { call: Call; next: Call | null; onDone: () => void }) {
  return <div className="phone-screen">
    <span className="phone-status">Call ended · {clock(call.cost.phoneSeconds + call.cost.ringSeconds)}</span>
    <CallerId call={call} />
    {call.outcome && <p className="phone-outcome"><Icon name={call.outcome === "resolved" ? "check" : "waiting"} className={call.outcome === "resolved" ? "tone-ok" : "tone-accent"} />{OUTCOME_TEXT[call.outcome]}</p>}
    {call.summary && <p className="phone-reason">{call.summary}</p>}
    {call.handover && <p className="phone-reason"><b>Open question:</b> {call.handover.question}</p>}
    <button type="button" className="btn btn-primary" onClick={onDone}>{next ? `Done · next call ${next.reference}` : "Done"}</button>
  </div>
}

function IdleScreen({ persona, last }: { persona: PhonePersona; last: Call | null }) {
  const who = persona === "driver" ? "the assigned driver" : "a pickup or delivery place"
  return <div className="phone-idle">
    <span className="phone-icon"><Icon name="phone" size={28} /></span>
    <b>No calls right now</b>
    <p>When the agent calls {who}, the call rings here with the caller and the order reference.</p>
    {last && <p className="phone-last">Last call: {last.reference}, {last.outcome === "resolved" ? "resolved" : last.outcome === "callback" ? "callback scheduled" : "handed to a person"}.</p>}
  </div>
}
