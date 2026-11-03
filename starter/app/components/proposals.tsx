"use client"

// Proposals (ticket 07): what the agent wants to do on an order, with the evidence,
// the contact and its type, who pays and the policy row, and the operator's
// decisions (approve, edit the script, dismiss, give an instruction) with history.
// Ticket 08: an approved customer contact takes the customer's answer ("Record the
// answer"), and a question to the operator takes the operator's ("Answer").
// Every action posts to /api/proposals and then fires CLOCK_EVENT, which every page
// that shows engine state already listens to ("engine state changed").

import Link from "next/link"
import { useState, type FormEvent } from "react"
import type { Proposal } from "@/lib/engine/proposals"
import type { ApprovalQueue, ProposalAction, Tone } from "@/lib/present/types"
import { fmtDateTime } from "@/lib/present/time"
import { CLOCK_EVENT } from "./demo-clock"
import { Icon } from "./icons"
import { CitedRow } from "./review"
import { More, Pill } from "./ui"

/** Sends one proposal action; resolves to the new approval queue or throws the engine's refusal. */
export async function sendProposalAction(body: ProposalAction): Promise<ApprovalQueue> {
  const response = await fetch("/api/proposals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  const data = await response.json().catch(() => null) as (ApprovalQueue & { error?: string }) | null
  if (!response.ok || !data) throw new Error(data?.error ?? "The proposal did not change")
  window.dispatchEvent(new Event(CLOCK_EVENT))
  return data
}

/** The proposal's state in a few words, and its tone. */
export function proposalState(proposal: Proposal): { label: string; tone: Tone } {
  if (proposal.status === "dismissed") return { label: proposal.history.at(-1)?.kind === "withdrawn" ? "Withdrawn" : "Dismissed", tone: "neutral" }
  if (proposal.status === "answered") return { label: "Answered", tone: "ok" }
  if (proposal.status === "proposed") return { label: "Waiting for your yes", tone: "warn" }
  if (proposal.kind === "customer_contact") return { label: "Contact handed to you", tone: "warn" }
  if (proposal.kind === "operator_question") return { label: "Question for you", tone: "warn" }
  if (proposal.kind === "call") return { label: "Agent will call", tone: "accent" }
  return { label: "Approved", tone: "ok" }
}

const KIND_ICON: Record<Proposal["kind"], string> = { call: "phone", operator_question: "message", customer_contact: "people", change: "file" }
const BY_LABEL: Record<string, string> = { agent: "Agent", policy: "Policy", operator: "Operator" }

export function PolicyLink({ proposal }: { proposal: Proposal }) {
  const tone: Tone = proposal.decision === "acts alone" ? "neutral" : "warn"
  return <Link className="policy-link" href={`/rules#${proposal.policyRow}`} title={`${proposal.policyRow}: ${proposal.decision}`}>
    <Pill tone={tone}>{proposal.policyRow}</Pill>
  </Link>
}

/** The contact's name without the trailing context ("…, order contact for CD-420449"). */
export function contactName(proposal: Proposal): string {
  return proposal.contact.name.split(",")[0]
}

/**
 * A proposal history line in plain words. Lines stored earlier name the call id
 * ("Call result (call-…): …") or quote the whole policy row ("Acts alone under site-routine: …").
 */
export function proposalEventText(text: string): string {
  const call = /^Call result \([^)]*\): /.exec(text)
  if (call) return `Answer: ${text.slice(call[0].length)}`
  const rule = /^Acts alone under ([a-z-]+): /.exec(text)
  if (rule) return `Allowed by rule: ${RULE_WORDS[rule[1]] ?? rule[1].replace(/-/g, " ")}`
  return text
}

const RULE_WORDS: Record<string, string> = {
  "site-routine": "routine site call", "driver-routine": "routine driver call", "operator-question": "question to the operator", "pickup-readiness": "pickup-readiness call",
}

const RULE_PREFIX = "Allowed by rule: "

/** The line, with the rule it names linked to the Rules page. */
export function ProposalEventText({ text, policyRow }: { text: string; policyRow: string }) {
  const plain = proposalEventText(text)
  if (!plain.startsWith(RULE_PREFIX)) return <>{plain}</>
  return <>{RULE_PREFIX}<Link href={`/rules#${policyRow}`}>{plain.slice(RULE_PREFIX.length)}</Link></>
}

function History({ proposal }: { proposal: Proposal }) {
  return <ol className="proposal-history">{proposal.history.map((event, i) => <li key={i}>
    <span className="proposal-history-at">{fmtDateTime(event.at)}</span>
    <span className="proposal-history-by">{BY_LABEL[event.by] ?? event.by} · {event.kind}</span>
    <span className="proposal-history-text"><ProposalEventText text={event.text} policyRow={proposal.policyRow} /></span>
  </li>)}</ol>
}

type Mode = null | "edit" | "instruct" | "dismiss" | "answer"

function answerLabel(proposal: Proposal): string {
  return proposal.kind === "customer_contact" ? `What ${contactName(proposal)} said` : "Your answer"
}

/** One proposal on the order page, with its decisions. */
export function ProposalCard({ proposal, orderId }: { proposal: Proposal; orderId: string }) {
  const [mode, setMode] = useState<Mode>(null)
  const [draft, setDraft] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const state = proposalState(proposal)
  const open = proposal.waitingOn !== null
  // A customer contact handed to the operator, or a question to the operator: the operator answers it here.
  const answerable = proposal.status === "approved" && proposal.waitingOn === "operator"
    && (proposal.kind === "customer_contact" || proposal.kind === "operator_question")
  const conflict = proposal.evidence.filter((cited) => cited.role === "conflict")

  async function run(body: ProposalAction) {
    setBusy(true)
    setError("")
    try {
      await sendProposalAction(body)
      setMode(null)
      setDraft("")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The proposal did not change")
    } finally {
      setBusy(false)
    }
  }

  function start(next: Mode) {
    setMode(next)
    setError("")
    setDraft(next === "edit" ? proposal.script : "")
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (mode === "edit") void run({ action: "editScript", proposalId: proposal.id, script: draft })
    if (mode === "instruct") void run({ action: "instruct", proposalId: proposal.id, text: draft })
    if (mode === "dismiss") void run({ action: "dismiss", proposalId: proposal.id, note: draft })
    if (mode === "answer") void run(proposal.kind === "customer_contact"
      ? { action: "recordAnswer", proposalId: proposal.id, answer: draft }
      : { action: "answerQuestion", proposalId: proposal.id, answer: draft })
  }

  return <article className={`proposal proposal-${proposal.status}`} id={proposal.id} aria-label={proposal.title}>
    <div className="proposal-head">
      <Icon name={KIND_ICON[proposal.kind]} className={`tone-${state.tone}`} />
      <div className="proposal-title">{proposal.title}</div>
      <Pill tone={state.tone}>{state.label}</Pill>
    </div>
    <div className="proposal-why">
      <p>{proposal.why}</p>
      <p className="check-detail">{contactName(proposal)}</p>
    </div>
    {mode === "edit"
      ? <form className="proposal-form" onSubmit={submit}>
        <label className="sr-only" htmlFor={`${proposal.id}-script`}>Script</label>
        <textarea id={`${proposal.id}-script`} value={draft} onChange={(event) => setDraft(event.target.value)} rows={4} autoFocus />
        <div className="proposal-actions">
          <button className="btn btn-primary btn-s" type="submit" disabled={busy || !draft.trim()}>Save script</button>
          <button className="btn btn-tertiary btn-s" type="button" onClick={() => setMode(null)} disabled={busy}>Cancel</button>
        </div>
      </form>
      : <blockquote className="proposal-script">{proposal.script}</blockquote>}
    {conflict.length > 0 && <More label={`Sources (${conflict.length})`}><ul className="cited-list">{conflict.map((cited, i) => <CitedRow key={`${cited.recordId}-${i}`} cited={cited} orderId={orderId} samePage />)}</ul></More>}

    {proposal.answer !== null && <>
      <h4 className="finding-sub">Answer</h4>
      <blockquote className="proposal-script proposal-answer">{proposal.answer}</blockquote>
    </>}

    {mode === "answer" && <form className="proposal-form" onSubmit={submit}>
      <label className="sr-only" htmlFor={`${proposal.id}-answer`}>{answerLabel(proposal)}</label>
      <textarea id={`${proposal.id}-answer`} value={draft} onChange={(event) => setDraft(event.target.value)} rows={3} autoFocus placeholder={answerLabel(proposal)} />
      <div className="proposal-actions">
        <button className="btn btn-primary btn-s" type="submit" disabled={busy || !draft.trim()}>{busy ? "Saving…" : "Save answer"}</button>
        <button className="btn btn-tertiary btn-s" type="button" onClick={() => setMode(null)} disabled={busy}>Cancel</button>
      </div>
    </form>}

    {(mode === "instruct" || mode === "dismiss") && <form className="proposal-form" onSubmit={submit}>
      <label className="sr-only" htmlFor={`${proposal.id}-${mode}`}>{mode === "instruct" ? "Instruction to the agent" : "Why dismiss"}</label>
      <textarea id={`${proposal.id}-${mode}`} value={draft} onChange={(event) => setDraft(event.target.value)} rows={3} autoFocus
        placeholder={mode === "instruct" ? "Instruction to the agent" : "Why dismiss (optional)"} />
      <div className="proposal-actions">
        <button className="btn btn-primary btn-s" type="submit" disabled={busy || (mode === "instruct" && !draft.trim())}>
          {mode === "instruct" ? (busy ? "Re-reviewing…" : "Send instruction") : "Dismiss proposal"}
        </button>
        <button className="btn btn-tertiary btn-s" type="button" onClick={() => setMode(null)} disabled={busy}>Cancel</button>
      </div>
    </form>}

    {mode === null && <div className="proposal-decide">
      {proposal.onApprove && <p className="proposal-will">{proposal.onApprove}</p>}
      <div className="proposal-actions">
        {proposal.status === "proposed" && <button className="btn btn-primary btn-s" type="button" disabled={busy}
          onClick={() => void run({ action: "approve", proposalId: proposal.id })}>Approve</button>}
        {answerable && <button className="btn btn-primary btn-s" type="button" disabled={busy} onClick={() => start("answer")}>
          {proposal.kind === "customer_contact" ? "Record the answer" : "Answer"}</button>}
        {open && <button className="btn btn-tertiary btn-s" type="button" disabled={busy} onClick={() => start("edit")}>Edit script</button>}
        {open && <button className="btn btn-tertiary btn-s" type="button" disabled={busy} onClick={() => start("dismiss")}>Dismiss</button>}
        <button className="btn btn-tertiary btn-s" type="button" disabled={busy} onClick={() => start("instruct")}>Give an instruction</button>
      </div>
    </div>}
    {error && <p className="proposal-error" role="alert">{error}</p>}
    <More label={`History (${proposal.history.length})`}><History proposal={proposal} /></More>
  </article>
}

/** The proposals block on the order page. */
export function ProposalsBlock({ orderId, proposals }: { orderId: string; proposals: Proposal[] }) {
  if (!proposals.length) return null
  const waiting = proposals.filter((proposal) => proposal.waitingOn === "operator").length
  return <div className="checks-block proposals" id="agent-proposals">
    <h3>Proposals{waiting ? ` · ${waiting} waiting for you` : ""}</h3>
    {proposals.map((proposal) => <ProposalCard key={proposal.id} proposal={proposal} orderId={orderId} />)}
  </div>
}

/**
 * Proposals in the queue preview. The situation card above holds the buttons; a proposal
 * waiting for the operator shows its script and the records that disagree, so it can be
 * decided without opening the order.
 */
export function CompactProposals({ orderId, proposals }: { orderId: string; proposals: Proposal[] }) {
  if (!proposals.length) return null
  return <div className="checks-block">
    <h3>Proposals</h3>
    <ul className="checks-list">{proposals.map((proposal) => {
      const state = proposalState(proposal)
      const waiting = proposal.waitingOn === "operator"
      const conflict = waiting ? proposal.evidence.filter((cited) => cited.role === "conflict") : []
      return <li className="check" key={proposal.id} id={proposal.id}>
        <Icon name={KIND_ICON[proposal.kind]} className={`tone-${state.tone}`} />
        <div>
          <div className="check-title">{proposal.title} <Pill tone={state.tone}>{state.label}</Pill></div>
          {waiting ? <>
            <blockquote className="proposal-script">{proposal.answer ?? proposal.script}</blockquote>
            {proposal.status === "proposed" && proposal.onApprove && <p className="proposal-will">{proposal.onApprove}</p>}
            {conflict.length > 0 && <More label={`Sources (${conflict.length})`}><ul className="cited-list">{conflict.map((cited, i) => <CitedRow key={`${cited.recordId}-${i}`} cited={cited} orderId={orderId} samePage={false} />)}</ul></More>}
          </> : null}
        </div>
      </li>
    })}</ul>
  </div>
}

/**
 * Batch approval for the queue: every proposal waiting for a yes, each row with its
 * script and what approving will do, chosen rows approved in one click.
 */
export function BatchApproval({ queue, onClose }: { queue: ApprovalQueue; onClose: () => void }) {
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(queue.waiting.map((proposal) => proposal.id)))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [done, setDone] = useState<number | null>(null)
  const toggle = (id: string) => setChosen((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const ids = queue.waiting.filter((proposal) => chosen.has(proposal.id)).map((proposal) => proposal.id)

  async function approve() {
    setBusy(true)
    setError("")
    try {
      await sendProposalAction({ action: "approveBatch", proposalIds: ids })
      setDone(ids.length)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Nothing was approved")
    } finally {
      setBusy(false)
    }
  }

  return <section className="batch" aria-label="Approve in batch">
    <div className="batch-head">
      <h2 className="batch-title">Waiting for your yes</h2>
      <button type="button" className="btn btn-tertiary btn-s" onClick={onClose}>Close</button>
    </div>
    {done !== null && <p className="batch-done" role="status"><Icon name="check" /> Approved {done} {done === 1 ? "proposal" : "proposals"}.</p>}
    {queue.waiting.length === 0 && <p className="queue-note">No proposal is waiting for a yes.</p>}
    <ol className="batch-list">{queue.waiting.map((proposal) => <li key={proposal.id} className="batch-row">
      <label className="batch-check">
        <input type="checkbox" checked={chosen.has(proposal.id)} onChange={() => toggle(proposal.id)} />
        <span className="sr-only">Include {proposal.reference}: {proposal.title}</span>
      </label>
      <div className="batch-body">
        <div className="batch-row-head">
          <Link className="name-link" href={`/orders/${encodeURIComponent(proposal.orderId)}#${proposal.id}`}>{proposal.reference}</Link>
          <PolicyLink proposal={proposal} />
        </div>
        <div className="batch-row-title">{proposal.title}</div>
        <blockquote className="proposal-script">{proposal.script}</blockquote>
        <p className="proposal-will">{proposal.onApprove}</p>
      </div>
    </li>)}</ol>
    {error && <p className="proposal-error" role="alert">{error}</p>}
    {queue.waiting.length > 0 && <div className="batch-actions">
      <button type="button" className="btn btn-primary" disabled={busy || ids.length === 0} onClick={() => void approve()}>
        {busy ? "Approving…" : `Approve ${ids.length} ${ids.length === 1 ? "proposal" : "proposals"}`}
      </button>
      <span className="hint">{ids.length} of {queue.waiting.length} chosen</span>
    </div>}
  </section>
}
