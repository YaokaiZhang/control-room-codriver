"use client"

// The situation card (ui-revision): what is wrong, in a bold headline; one or two
// sentences of situation and suggestion; the suggested step as the one primary button
// and "Choose another step" for the rest. Used in the queue preview, in the Briefing
// and at the top of the order page. Steps reuse the existing API actions and then fire
// CLOCK_EVENT ("engine state changed"), which every page that shows engine state hears.

import Link from "next/link"
import { useEffect, useRef, useState, type FormEvent } from "react"
import type { Situation, Step } from "@/lib/present/situation"
import { closeRecords } from "./close"
import { CLOCK_EVENT } from "./demo-clock"
import { Icon } from "./icons"
import { sendProposalAction } from "./proposals"

async function post(url: string, body: unknown, fallback: string): Promise<void> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  const data = await response.json().catch(() => null) as { error?: string } | null
  if (!response.ok) throw new Error(data?.error ?? fallback)
  window.dispatchEvent(new Event(CLOCK_EVENT))
}

/** Runs a step that needs no typed text. */
async function run(step: Step, orderId: string): Promise<void> {
  switch (step.do) {
    case "approve": await sendProposalAction({ action: "approve", proposalId: step.proposalId }); return
    case "dismiss": await sendProposalAction({ action: "dismiss", proposalId: step.proposalId }); return
    case "ring": await post("/api/calls", { action: "ringLive", orderId, line: step.line }, "The call did not start"); return
    case "confirm": await post("/api/publishing", { action: "confirm", orderId }, "Nothing changed"); return
    case "close": await closeRecords(orderId, step.records); return
    default: return
  }
}

/** Sends what the operator typed for an answer or a handover. */
async function submit(step: Step, text: string): Promise<void> {
  if (step.do === "answer") await sendProposalAction({ action: step.command, proposalId: step.proposalId, answer: text })
  if (step.do === "instruct") await sendProposalAction({ action: "instruct", proposalId: step.proposalId, text })
  if (step.do === "handover") await post("/api/calls", { action: "recordHandoverResult", callId: step.callId, result: text }, "The result was not saved")
}

const needsText = (step: Step): step is Extract<Step, { prompt: string }> => "prompt" in step

/** "Overdue 2 d", "Due in 3 h": the order's earliest deadline against the demo clock. */
export function dueText(dueAt: string | null | undefined, now: string | null | undefined): string | null {
  if (!dueAt || !now) return null
  const minutes = Math.round((new Date(dueAt).getTime() - new Date(now).getTime()) / 60000)
  const span = (m: number) => m < 60 ? `${Math.max(1, m)} min` : m < 36 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`
  return minutes < 0 ? `Overdue ${span(-minutes)}` : `Due in ${span(minutes)}`
}

type Props = {
  orderId: string
  situation: Situation
  /** The car and reference above the headline; left out on the order page, which is the order. */
  car?: string | null
  reference?: string | null
  due?: string | null
  urgent?: boolean
  /** On the order page and in the queue preview: open steps jump to the evidence shown below the card. */
  samePage?: boolean
  /** The order page's lead card: larger type, no link on the headline. */
  lead?: boolean
}

/**
 * Brings the evidence at an anchor into view on this page and marks it for a moment. An anchor
 * this page does not carry (no open items, say) falls back to the checks.
 */
function reveal(anchor: string) {
  const target = document.getElementById(anchor) ?? document.getElementById("checks")
  if (!target) return
  target.scrollIntoView({ behavior: "smooth", block: "center" })
  target.classList.remove("is-revealed")
  void target.offsetWidth
  target.classList.add("is-revealed")
}

export function SituationCard({ orderId, situation, car, reference, due, urgent = false, samePage = false, lead = false }: Props) {
  const [writing, setWriting] = useState<Extract<Step, { prompt: string }> | null>(null)
  const [draft, setDraft] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [menu, setMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const href = `/orders/${encodeURIComponent(orderId)}`

  useEffect(() => {
    if (!menu) return
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !menuRef.current?.contains(event.target as Node)) setMenu(false)
    }
    document.addEventListener("click", close)
    document.addEventListener("keydown", close)
    return () => { document.removeEventListener("click", close); document.removeEventListener("keydown", close) }
  }, [menu])

  async function act(step: Step) {
    setMenu(false)
    setError("")
    if (needsText(step)) { setWriting(step); setDraft(""); return }
    setBusy(true)
    try { await run(step, orderId) } catch (cause) { setError(cause instanceof Error ? cause.message : "Nothing changed") } finally { setBusy(false) }
  }

  async function send(event: FormEvent) {
    event.preventDefault()
    if (!writing) return
    setBusy(true)
    setError("")
    try { await submit(writing, draft); setWriting(null) } catch (cause) { setError(cause instanceof Error ? cause.message : "Nothing changed") } finally { setBusy(false) }
  }

  const stepHref = (step: Step) => step.do === "open" ? `${href}#${step.anchor}` : href
  const button = (step: Step, primary: boolean) => step.do === "open" && samePage && !step.full
    ? <button key={step.label} type="button" className={`btn btn-s ${primary ? "btn-primary" : "btn-quiet"}`} onClick={() => reveal(step.anchor)}>{step.label}</button>
    : step.do === "open"
    ? <Link key={step.label} className={`btn btn-s ${primary ? "btn-primary" : "btn-quiet"}`} href={stepHref(step)}>{step.label}</Link>
    : <button key={step.label} type="button" className={`btn btn-s ${primary ? "btn-primary" : "btn-quiet"}`} disabled={busy} onClick={() => void act(step)}>{busy && primary ? "Working…" : step.label}</button>

  const { step, others } = situation
  return <article className={`sit${lead ? " sit-lead" : ""}`} aria-label={situation.headline}>
    {(car || reference || due) && <div className="sit-meta">
      {(car || reference) && <Link className="sit-car" href={href}>{car}{car && reference ? <span> · {reference}</span> : reference}</Link>}
      {due && <span className={`sit-due${urgent ? " is-urgent" : ""}`}>{due}</span>}
    </div>}
    <h3 className="sit-head">{lead ? situation.headline : <Link href={href}>{situation.headline}</Link>}</h3>
    {situation.body && <p className="sit-body">{situation.body}</p>}
    {writing ? <form className="sit-form" onSubmit={send}>
      <label className="sr-only" htmlFor={`${orderId}-sit-text`}>{writing.prompt}</label>
      <textarea id={`${orderId}-sit-text`} rows={3} autoFocus value={draft} onChange={(event) => setDraft(event.target.value)}
        placeholder={writing.prompt} />
      <div className="sit-actions">
        <button type="submit" className="btn btn-s btn-primary" disabled={busy || !draft.trim()}>{busy ? "Saving…" : "Save"}</button>
        <button type="button" className="btn btn-s btn-quiet" disabled={busy} onClick={() => setWriting(null)}>Cancel</button>
      </div>
    </form> : (step || others.length > 0) && <div className="sit-actions">
      {step && button(step, true)}
      {others.length > 0 && <div className="sit-more" ref={menuRef}>
        <button type="button" className="btn btn-s btn-quiet" aria-expanded={menu} aria-haspopup="menu" onClick={() => setMenu((open) => !open)}>
          {step ? <><span className="sit-long">Choose another step</span><span className="sit-short">Other steps</span></> : "Choose a step"}<Icon name="chevron" size={12} className="sit-chev" />
        </button>
        {menu && <ul className="sit-menu" role="menu">{others.map((other) => <li key={other.label} role="none">
          {other.do === "open" && samePage && !other.full
            ? <button role="menuitem" type="button" onClick={() => { setMenu(false); reveal(other.anchor) }}>{other.label}</button>
            : other.do === "open"
            ? <Link role="menuitem" href={stepHref(other)} onClick={() => setMenu(false)}>{other.label}</Link>
            : <button role="menuitem" type="button" disabled={busy} onClick={() => void act(other)}>{other.label}</button>}
        </li>)}</ul>}
      </div>}
    </div>}
    {error && <p className="sit-error" role="alert">{error}</p>}
  </article>
}
