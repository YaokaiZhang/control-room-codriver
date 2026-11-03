"use client"

// Calls (ticket 10): the agent's calls on an order, with the live transcript, the
// tier, the state and the cost meter (model cost plus phone time, against what the
// same call would cost an operator). The order page re-reads while a call runs.

import { useEffect, useRef, useState, type FormEvent } from "react"
import type { BlockedCall, Call, CallLineView, CallState } from "@/lib/engine/calls"
import type { TurnCheck, TurnPath } from "@/lib/engine/voice-agent"
import type { Tone } from "@/lib/present/types"
import { CLOCK_EVENT } from "./demo-clock"
import { Icon } from "./icons"
import { More, Pill } from "./ui"

const STATE_LABEL: Record<CallState, string> = {
  ringing: "Ringing", answered: "Answered", declined: "Declined", no_answer: "No answer",
  availability: "Asking if now is good", callback_time: "Asking when to call back", tier1: "Keypad questions", tier2: "Voice agent", ended: "Ended",
}

const OUTCOME_LABEL: Record<NonNullable<Call["outcome"]>, { label: string; tone: Tone }> = {
  resolved: { label: "Resolved", tone: "ok" },
  callback: { label: "Callback scheduled", tone: "accent" },
  handover: { label: "Needs a person", tone: "warn" },
  unreachable: { label: "Unreachable", tone: "warn" },
}

/** True while the order has a call running or one about to start: the page keeps re-reading. */
export function callsAreLive(calls: Call[] = [], lines: CallLineView[] = []): boolean {
  return calls.some((call) => call.state !== "ended") || lines.some((line) => line.status === "to_call" || line.status === "callback_due")
}

const usd = (value: number) => value === 0 ? "$0" : `$${value < 0.01 ? value.toFixed(5) : value.toFixed(3)}`

function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

function demoTime(iso: string): string {
  return `${new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).format(new Date(iso))} UTC`
}

function PlayButton({ audioId }: { audioId: string }) {
  const [playing, setPlaying] = useState(false)
  const audio = useRef<HTMLAudioElement | null>(null)
  useEffect(() => () => audio.current?.pause(), [])
  const toggle = () => {
    if (playing) { audio.current?.pause(); setPlaying(false); return }
    audio.current ??= new Audio(`/api/phone/audio/${audioId}`)
    audio.current.currentTime = 0
    audio.current.onended = () => setPlaying(false)
    audio.current.play().then(() => setPlaying(true)).catch(() => setPlaying(false))
  }
  return <button type="button" className="call-play" onClick={toggle} aria-label={playing ? "Stop the prompt" : "Play the prompt"} aria-pressed={playing}>
    {playing ? <span className="call-play-stop" /> : <span className="call-play-tri" />}
  </button>
}

const PATH_LABEL: Record<TurnPath, string> = {
  voice: "Audio model",
  replaced: "Checked reply (the audio model's was not allowed)",
  fallback: "Fallback: transcribed, checked, spoken",
  text: "Checked reply (simulated callee, text only)",
}

const NEXT_LABEL: Record<TurnCheck["next"], string> = { continue: "Keep talking", resolved: "End: resolved", handover: "End: hand over to a person" }

/** Haiku's structured result for one tier-2 turn. */
function TurnCheckView({ check, cost }: { check: TurnCheck; cost: number }) {
  return <dl className="call-check call-line-text">
    {check.failed && <><dt>Check</dt><dd>Failed: safe reply, nothing recorded.</dd></>}
    {check.claims.length > 0 && <><dt>Said</dt><dd>{check.claims.join("; ")}</dd></>}
    {check.changes.length > 0 && <><dt>Change</dt><dd>{check.changes.map((change) => change.change).join("; ")} <span className="call-line-meta">Needs your yes</span></dd></>}
    {check.conflicts.length > 0 && <><dt>Conflict</dt><dd>{check.conflicts.join("; ")}</dd></>}
    {check.replyOk === false && <><dt>Reply</dt><dd>Not used{check.replyIssue ? `: ${check.replyIssue}` : ""}</dd></>}
    <dt>Next</dt><dd>{NEXT_LABEL[check.next]}{cost ? <span className="call-line-meta">Haiku · {usd(cost)}</span> : null}</dd>
  </dl>
}

export function Transcript({ call }: { call: Call }) {
  const start = new Date(call.transcript[0]?.wallAt ?? call.startedAt).getTime()
  const end = useRef<HTMLLIElement | null>(null)
  const live = call.state !== "ended"
  useEffect(() => { if (live) end.current?.scrollIntoView({ block: "nearest" }) }, [live, call.transcript.length])
  return <ol className="call-transcript" aria-live={live ? "polite" : "off"}>
    {call.transcript.map((line, i) => <li key={i} className={`call-line call-line-${line.by}${line.check ? " call-line-check" : ""}`} ref={i === call.transcript.length - 1 ? end : undefined}>
      <span className="call-line-at">{clock((new Date(line.wallAt).getTime() - start) / 1000)}</span>
      <span className="call-line-by">{line.check ? "Check" : line.by === "agent" ? "Agent" : line.by === "callee" ? "Callee" : ""}{line.tier > 1 && line.by === "agent" && !line.check ? ` · tier ${line.tier}` : ""}</span>
      {line.check ? <TurnCheckView check={line.check} cost={line.cost} /> : <span className="call-line-text">
        {line.text}
        {line.path && <span className="call-line-meta">{PATH_LABEL[line.path]}{line.cost ? ` · ${usd(line.cost)}` : ""}</span>}
        {!line.path && line.tier > 1 && line.by === "callee" && line.cost > 0 && <span className="call-line-meta">Transcribed · {usd(line.cost)}</span>}
      </span>}
      {line.audioId ? <PlayButton audioId={line.audioId} /> : <span />}
    </li>)}
  </ol>
}

/**
 * A tier-3 handover (ticket 14): what the agent could not settle, and the operator's
 * way to close it by recording what they learned (committed as the call's result).
 */
function HandoverView({ call }: { call: Call }) {
  const handover = call.handover!
  const closed = handover.closed
  const [writing, setWriting] = useState(false)
  const [draft, setDraft] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const response = await fetch("/api/calls", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "recordHandoverResult", callId: call.id, result: draft }) })
    const data = await response.json().catch(() => null) as { error?: string } | null
    setBusy(false)
    if (!response.ok) { setError(data?.error ?? "The result was not saved"); return }
    setWriting(false)
    window.dispatchEvent(new Event(CLOCK_EVENT))
  }
  return <section className={`call-handover-box${closed ? " is-closed" : ""}`} aria-label="Handover">
    <h4 className="call-handover-title">{closed ? "Handover closed" : "Handed over to you"}</h4>
    <dl className="call-check call-handover">
      <dt>Summary</dt><dd>{handover.summary}</dd>
      <dt>Open question</dt><dd>{handover.question}</dd>
      <dt>Next step</dt><dd>{handover.nextStep}</dd>
      {closed && <><dt>You learned</dt><dd>{closed.result}<span className="call-line-meta">{demoTime(closed.at)}</span></dd></>}
    </dl>
    {!closed && !writing && <div className="proposal-actions">
      <button type="button" className="btn btn-primary btn-s" onClick={() => setWriting(true)}>Record what you learned</button>
    </div>}
    {!closed && writing && <form className="call-handover-form" onSubmit={submit}>
      <label className="sr-only" htmlFor={`${call.id}-result`}>What you learned</label>
      <textarea id={`${call.id}-result`} value={draft} onChange={(event) => setDraft(event.target.value)} rows={3} autoFocus
        placeholder="What you learned" />
      <div className="proposal-actions">
        <button className="btn btn-primary btn-s" type="submit" disabled={busy || !draft.trim()}>{busy ? "Saving…" : "Save and close the handover"}</button>
        <button className="btn btn-tertiary btn-s" type="button" onClick={() => setWriting(false)} disabled={busy}>Cancel</button>
      </div>
    </form>}
    {error && <p className="call-ring-error" role="alert">{error}</p>}
  </section>
}

function CallCard({ call }: { call: Call }) {
  const live = call.state !== "ended"
  const handedOver = !!call.handover && !call.handover.closed
  const outcome = call.outcome === "handover" && call.handover ? (handedOver ? { label: "Handed over", tone: "warn" as Tone } : { label: "Handover closed", tone: "ok" as Tone })
    : call.outcome ? OUTCOME_LABEL[call.outcome] : null
  const name = call.callee.name ? call.callee.name.split(",")[0] : call.callee.handle
  return <article className={`call${live ? " call-running" : ""}`} id={call.id} aria-label={`${call.line === "site" ? "Site" : "Driver"} call to ${name}`}>
    <div className="call-head">
      <Icon name="phone" className={live ? "tone-accent" : "tone-neutral"} />
      <div>
        <div className="call-title">{call.line === "site" ? "Site call" : "Driver call"} to {name}</div>
        <div className="call-sub">{demoTime(call.startedAt)}{call.attempt > 1 ? ` · attempt ${call.attempt}` : ""}</div>
      </div>
      <div className="call-pills">
        {live ? <Pill tone="accent" dot>{STATE_LABEL[call.state]}</Pill> : outcome && <Pill tone={outcome.tone}>{outcome.label}</Pill>}
      </div>
    </div>
    <p className="call-reason">About: {call.reason.replace(/^Callback \(attempt \d+\)\. /, "")}</p>
    {live && call.answerer === "live" && call.state === "ringing" && <p className="call-reason tone-accent">Ringing on the {PHONE_NAME[call.line]} page</p>}
    {call.summary && !call.handover && <p className="call-summary">{call.summary}{call.callbackAt && call.outcome === "callback" ? ` Callback at ${demoTime(call.callbackAt)}.` : ""}</p>}
    {call.handover && <HandoverView call={call} />}
    {live || handedOver ? <Transcript call={call} /> : <More label="Transcript"><Transcript call={call} /></More>}
  </article>
}

const PHONE_NAME: Record<CallLineView["line"], string> = { site: "Site phone", driver: "Driver phone" }

/** Lines the operator can ring live now: something left to ask, or a callback waiting (ticket 11). */
const ringable = (line: CallLineView) => !!line.callee && (line.status === "to_call" || line.status === "callback" || line.status === "callback_due" || line.status === "on_request")

/** "Ring live": starts the line's call now, ringing on the Site or Driver phone page instead of the simulated person. */
function RingLive({ orderId, line }: { orderId: string; line: CallLineView }) {
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null })
  const ring = async () => {
    setState({ busy: true, error: null })
    const response = await fetch("/api/calls", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "ringLive", orderId, line: line.line }) })
    const data = await response.json().catch(() => null) as { error?: string } | null
    setState({ busy: false, error: response.ok ? null : data?.error ?? "The call did not start" })
    if (response.ok) window.dispatchEvent(new Event(CLOCK_EVENT))
  }
  const name = line.callee?.name ? line.callee.name.split(",")[0] : line.callee?.handle
  return <div className="call-ring-live">
    <button type="button" className="btn btn-tertiary btn-s" onClick={ring} disabled={state.busy}><Icon name="phone" />{state.busy ? "Ringing…" : `Ring ${name} live`}</button>
    {state.error && <span className="call-ring-error" role="alert">{state.error}</span>}
  </div>
}

/** The order's calls and call lines; `compact` (queue preview) shows one line per line. */
export function CallsBlock({ orderId, calls = [], lines = [], blocked = [], compact = false }: { orderId?: string; calls?: Call[]; lines?: CallLineView[]; blocked?: BlockedCall[]; compact?: boolean }) {
  if (!calls.length && !blocked.length && !lines.some(ringable)) return null
  const waiting = lines.filter((line) => (line.status === "callback" || line.status === "callback_due") && line.text)
  if (compact) {
    return <div className="checks-block"><h3>Calls</h3><ul className="checks-list">
      {lines.filter((line) => line.latest || line.status !== "done").map((line) => <li className="check" key={line.line}>
        <Icon name="phone" className={line.status === "calling" ? "tone-accent" : line.status === "handover" ? "tone-warn" : "tone-neutral"} />
        <div className="check-title">{line.text || (line.latest?.summary ?? "")}</div>
      </li>)}
    </ul></div>
  }
  const ordered = [...calls].reverse()
  return <div className="checks-block" id="calls">
    <h3>Calls</h3>
    {waiting.map((line) => <p className="call-waiting" key={line.line}><Icon name="waiting" className="tone-accent" />{line.text}</p>)}
    {orderId && lines.filter(ringable).map((line) => <RingLive key={`ring-${line.line}`} orderId={orderId} line={line} />)}
    {blocked.map((row, i) => <p className="call-waiting" key={`b${i}`}><Icon name="note" className="tone-neutral" />{row.text}</p>)}
    {ordered.slice(0, 1).map((call) => <CallCard key={call.id} call={call} />)}
    {ordered.length > 1 && <More label={`Earlier calls (${ordered.length - 1})`}>{ordered.slice(1).map((call) => <CallCard key={call.id} call={call} />)}</More>}
  </div>
}
