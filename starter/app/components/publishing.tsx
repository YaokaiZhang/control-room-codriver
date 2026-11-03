"use client"

// Publishing (spec .scratch/publishing) on the order: the call results waiting for the
// operator's yes, each as a rewrite (what the records said, what the call says now) with
// the call's transcript, and the order's stage on the driver market. Actions post to
// /api/publishing and then fire CLOCK_EVENT ("engine state changed").

import { useState } from "react"
import type { Call } from "@/lib/engine/calls"
import type { Publication, SolvedChange } from "@/lib/engine/publishing"
import { fmtDateTime } from "@/lib/present/time"
import { Transcript } from "./calls"
import { CLOCK_EVENT } from "./demo-clock"
import { Icon } from "./icons"
import { More, Pill } from "./ui"

async function sendPublishing(action: "confirm" | "publish", orderId: string): Promise<void> {
  const response = await fetch("/api/publishing", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, orderId }) })
  const data = await response.json().catch(() => null) as { error?: string } | null
  if (!response.ok) throw new Error(data?.error ?? "Nothing changed")
  window.dispatchEvent(new Event(CLOCK_EVENT))
}

function Rewrite({ change, call }: { change: SolvedChange; call: Call | null }) {
  return <li className="rewrite">
    <div className="rewrite-point">{change.point}</div>
    <dl className="rewrite-diff">
      <dt>Before</dt>
      <dd>{change.before.length
        ? <ul>{change.before.map((row) => <li key={row.recordId}><span className="rewrite-old">{row.text}</span> <span className="source-id">{row.recordId}</span></li>)}</ul>
        : <span className="rewrite-none">Nothing on record</span>}</dd>
      <dt>Now</dt>
      <dd className="rewrite-new">{change.after}</dd>
    </dl>
    {change.call && <p className="rewrite-meta">
      {change.call.who}{change.call.endedAt ? `, ${fmtDateTime(change.call.endedAt, null, false)}` : ""}
    </p>}
    {call && <More label="Transcript"><Transcript call={call} /></More>}
  </li>
}

/** The yes publishes only an order not published yet; one on the market or further along keeps its stage. */
const confirmLabel = (publication: Publication) => publication.inFlow && !publication.published ? "Approve and publish" : "Approve"

const STAGE_TEXT = (publication: Publication): string => {
  if (publication.stage === "market") {
    const since = publication.published ? ` since ${fmtDateTime(publication.published.at, null, false)}` : ""
    return publication.check?.demanding && !publication.plan ? `On the market${since}, hidden until its travel plan is ready` : `On the market${since}`
  }
  if (publication.stage === "confirm") return "Not on the market yet, waiting for your yes"
  if (publication.stage === "unposted") return "Not on the market yet"
  return "Driver booked"
}

/** The order's publishing state and, when Solved, the rewrites to approve. `bare`: the situation card above holds the buttons. */
export function PublishingBlock({ orderId, publication, group, calls, bare = false }: { orderId: string; publication: Publication; group: string; calls: Call[]; bare?: boolean }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const act = (action: "confirm" | "publish") => {
    setBusy(true)
    setError("")
    sendPublishing(action, orderId).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Nothing changed")).finally(() => setBusy(false))
  }
  const pending = group === "solved" ? publication.pending : []
  // The rewrites already show what the calls settled; an order past the market has only its changes.
  const changes = group === "solved" && !pending.length ? publication.changes : []
  const review = pending.length > 0 || changes.length > 0
  const canPublish = publication.stage === "unposted" && group === "normal"
  if (publication.stage === "posted" && !review) return null
  return <div className="checks-block publishing" id="publishing">
    <h3>{review ? "Waiting for your yes" : "Driver market"}</h3>
    {(publication.stage !== "unposted" || canPublish) && <p className="publishing-stage"><Icon name="offer" className={publication.stage === "market" ? "tone-accent" : "tone-neutral"} />{STAGE_TEXT(publication)}</p>}
    {publication.check?.demanding && <p className="publishing-filter">{publication.check.reasons.map((reason) => <Pill key={reason} tone="warn">{reason}</Pill>)}</p>}
    {review && <>
      <ol className="rewrites">
        {pending.map((change) => <Rewrite key={change.effectId} change={change} call={calls.find((call) => call.id === change.call?.id) ?? null} />)}
        {changes.map((change) => <li className="rewrite" key={change.proposalId}>
          <div className="rewrite-point">{change.title}</div>
          <p className="rewrite-new">{change.change}</p>
          <p className="rewrite-meta">{change.who}</p>
        </li>)}
      </ol>
      {!bare && <div className="publishing-actions">
        <button type="button" className="btn btn-primary btn-s" disabled={busy} onClick={() => act("confirm")}><Icon name="check" />{confirmLabel(publication)}</button>
      </div>}
    </>}
    {canPublish && <div className="publishing-actions">
      <button type="button" className="btn btn-tertiary btn-s" disabled={busy} onClick={() => act("publish")}><Icon name="offer" />Publish now</button>
    </div>}
    {error && <p className="publishing-error" role="alert">{error}</p>}
  </div>
}
