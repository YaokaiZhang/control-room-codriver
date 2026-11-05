"use client"

import Link from "next/link"
import { useState } from "react"
import type { JourneyLeg, JourneyStep, ProposalView, RecordView, ThreadView } from "@/lib/present/types"
import { fmtClock, fmtDateTime, fmtDay, deskZoneName, relativeTo } from "@/lib/present/time"
import { Icon } from "../icons"
import { Route } from "../route-line"
import { ActorName, Empty, OrderLink, OrderLinks, Pill, Range, SectionHead, When } from "../ui"
import { CitedTag, recordAnchor, useCited } from "../review"
import { OrderFiles } from "./files"

const files = (count: number) => `${count} ${count === 1 ? "file" : "files"}`

/* ── Route ──────────────────────────────────────────────────────────────── */

export function RouteSection({ view }: { view: RecordView }) {
  if (!view.journey.groups.length) return null
  return <section className="sec" id="journey">
    <SectionHead title="Route" note={view.journey.plan && !view.journey.plan.active ? "Draft plan" : null} />
    <Route view={view} />
  </section>
}

/* ── Conversations ──────────────────────────────────────────────────────── */

export function ConversationsSection({ view }: { view: RecordView }) {
  const { threads, notes } = view
  const cited = useCited()
  return <section className="sec" id="conversations">
    <SectionHead title="Conversations" count={threads.length} />
    {threads.length === 0 && notes.length === 0 && <Empty>None</Empty>}
    <div className="rows">
      {threads.map((thread) => <ThreadRow key={thread.id} thread={thread} view={view} />)}
      {notes.map((note) => <div className={`row${cited.has(note.id) ? " is-cited" : ""}`} key={note.id} id={recordAnchor(note.id)}>
        <div className="row-main">
          <div className="row-title">Note from <ActorName actor={note.author} />{cited.has(note.id) && <CitedTag />}</div>
          <div className="row-preview">{note.body}</div>
        </div>
        <div className="row-side"><When at={note.at} withZone={false} /></div>
      </div>)}
    </div>
  </section>
}

function ThreadRow({ thread, view }: { thread: ThreadView; view: RecordView }) {
  const cited = useCited()
  const citesMessage = thread.messages.some((message) => cited.has(message.id))
  // A thread holding a cited message starts open so the highlighted message is on the page.
  const [open, setOpen] = useState(citesMessage)
  const last = thread.messages[thread.messages.length - 1]
  const count = thread.messages.length
  return <article className={`row${cited.has(thread.id) ? " is-cited" : ""}`} id={recordAnchor(thread.id)}>
    <div className="row-main">
      <div className="row-title">{thread.categoryLabel} <Pill tone={thread.tone}>{thread.statusLabel}</Pill>{(cited.has(thread.id) || citesMessage) && <CitedTag />}</div>
      <div className="row-sub">
        {thread.channelLabel}{thread.counterparty ? <> with <ActorName actor={thread.counterparty} /></> : ""} · {count} {count === 1 ? "message" : "messages"}
        {thread.waitingOn && ` · waiting on ${thread.waitingOn}`}{thread.owner && ` · ${thread.owner}`}
        {thread.relatedOrders.length > 0 && <> · also <OrderLinks orders={thread.relatedOrders} /></>}
      </div>
      {last && !open && <div className="row-preview"><b>{last.author.name}:</b> {last.body}</div>}
      {open && <ThreadMessages thread={thread} />}
      {count > 0 && <button type="button" className="btn-link" onClick={() => setOpen((value) => !value)}>{open ? "Hide messages" : `Read ${count === 1 ? "the message" : `all ${count} messages`}`}</button>}
    </div>
    <div className="row-side"><When at={thread.updatedAt} withZone={false} /></div>
  </article>
}

export function ThreadMessages({ thread }: { thread: ThreadView }) {
  const cited = useCited()
  return <div className="messages">{thread.messages.map((message) => <div className={`msg${message.internal ? " internal" : message.author.kind === "operator" || message.author.kind === "agent" ? " from-operator" : ""}${cited.has(message.id) ? " is-cited" : ""}`} key={message.id} id={recordAnchor(message.id)}>
    <div className="msg-meta">
      <b><ActorName actor={message.author} /></b>
      <span>{message.author.role}</span>
      <span>to {message.recipient.name}</span>
      <span>· {message.channelLabel}</span>
      {message.internal && <Pill tone="warn">Internal</Pill>}
      {message.author.kind === "agent" && <Pill tone="accent">Agent</Pill>}
      {cited.has(message.id) && <CitedTag />}
      {message.supersededBy && <a className="superseded-tag" href={`#${recordAnchor(message.supersededBy)}`} title="A newer change replaced this">Superseded</a>}
      {message.otherOrder && <Pill>Filed on <OrderLink order={message.otherOrder} /></Pill>}
      <time dateTime={message.at}>{fmtDateTime(message.at)}</time>
    </div>
    <p className="msg-body">{message.body}</p>
  </div>)}</div>
}

/* ── Evidence ───────────────────────────────────────────────────────────── */

export function EvidenceSection({ view }: { view: RecordView }) {
  const { proofs, documents, custody } = view
  const total = proofs.length + documents.length + custody.assets.length
  return <section className="sec" id="evidence">
    <SectionHead title="Evidence" count={total} />
    {total === 0 && <Empty>None yet</Empty>}
    {total > 0 && <div className="evidence">
      {proofs.map((proof) => <Pill key={proof.id} tone={proof.tone} dot>{proof.kindLabel} · {proof.statusLabel.toLowerCase()}{proof.fileCount ? ` · ${files(proof.fileCount)}` : ""}</Pill>)}
      {documents.map((document) => <Pill key={document.id} tone={document.tone} dot>{document.kindLabel}{document.medium ? ` (${document.medium})` : ""} · {document.statusLabel.toLowerCase()}</Pill>)}
      {custody.assets.map((asset) => <Pill key={asset.id} tone={asset.nextAction ? "warn" : "neutral"} dot>{asset.kindLabel} · holder {asset.holder}</Pill>)}
    </div>}
    <OrderFiles orderId={view.header.id} />
  </section>
}

/* ── Prior agent work ───────────────────────────────────────────────────── */

export function DecisionsSection({ view }: { view: RecordView }) {
  const { proposals } = view
  if (!proposals.length) return null
  return <section className="sec" id="decisions">
    <SectionHead title="Prior agent work" count={proposals.length} />
    <div className="rows">{proposals.map((proposal) => <ProposalRow key={proposal.id} proposal={proposal} />)}</div>
  </section>
}

function ProposalRow({ proposal }: { proposal: ProposalView }) {
  return <article className="row">
    <div className="row-main">
      <div className="row-title">{proposal.summary} <Pill tone={proposal.tone} dot>{proposal.statusLabel}</Pill></div>
      <div className="row-sub">
        {proposal.agent.name} · {proposal.commandLabel.toLowerCase()}
        {proposal.review && <> · {proposal.review.decisionLabel.toLowerCase()} by {proposal.review.reviewer.name}</>}
        {proposal.execution && <> · {proposal.execution.statusLabel.toLowerCase()}</>}
      </div>
    </div>
    <div className="row-side"><When at={proposal.createdAt} withZone={false} /></div>
  </article>
}

export function ProposalCards({ view }: { view: RecordView }) {
  const { proposals, notifications } = view
  return <div>
    {proposals.map((proposal) => <article className="proposal" key={proposal.id}>
      <div className="proposal-head"><Pill tone={proposal.tone} dot>{proposal.statusLabel}</Pill><span>{proposal.agent.name} · {proposal.commandLabel.toLowerCase()} · <When at={proposal.createdAt} /></span></div>
      <p className="proposal-summary">{proposal.summary}</p>
      {proposal.rationale && <p className="proposal-text">{proposal.rationale}</p>}
      {proposal.review && <dl className="proposal-block">
        <dt>Recorded review</dt><dd>{proposal.review.decisionLabel} by {proposal.review.reviewer.name}, {fmtDateTime(proposal.review.at)}</dd>
        {proposal.review.note && <><dt>Note</dt><dd>{proposal.review.note}</dd></>}
      </dl>}
      {proposal.execution && <dl className="proposal-block">
        <dt>Execution</dt><dd>{proposal.execution.statusLabel}{proposal.execution.at ? `, ${fmtDateTime(proposal.execution.at)}` : ""}</dd>
        {proposal.execution.error && <><dt>Error</dt><dd className="tone-danger">{proposal.execution.error}</dd></>}
      </dl>}
      {(proposal.dependency || proposal.superseded) && <p className="proposal-foot">{[proposal.dependency, proposal.superseded].filter(Boolean).join(" · ")}</p>}
    </article>)}
    {notifications.length > 0 && <>
      <p className="sub">Internal room activity</p>
      <div className="rows">{notifications.map((note) => <div className="row" key={note.id}>
        <div className="row-main"><div className="row-title">{note.activityLabel} <span className="row-sub-inline">in {note.destination} by {note.actor.name}</span></div><div className="row-preview">{note.preview}</div></div>
        <div className="row-side"><When at={note.at} withZone={false} /> · {note.deliveryLabel}</div>
      </div>)}</div>
    </>}
  </div>
}

/* ── Activity ───────────────────────────────────────────────────────────── */

export function ActivitySection({ view }: { view: RecordView }) {
  const [all, setAll] = useState(false)
  const events = view.history.flatMap((day) => day.events)
  const shown = all ? events : events.slice(0, 6)
  return <section className="sec" id="history">
    <SectionHead title="Activity" count={view.historyTotal} note={events.length ? `times in ${deskZoneName(events[0].at)}` : null} />
    {events.length === 0 && <Empty>No events recorded.</Empty>}
    <div className="events">{shown.map((event) => <div className="event" key={event.id}>
      <time dateTime={event.at} title={fmtDateTime(event.at)}>{fmtDay(event.at)} {fmtClock(event.at)}</time>
      <div className="event-text"><b>{event.text}</b>{event.actor && <span className="actor"> · {event.actor}</span>}{event.shared && <span className="actor"> · shared bundle</span>}{all && event.detail && <small>{event.detail}</small>}</div>
    </div>)}</div>
    {events.length > 6 && <button type="button" className="btn-link" onClick={() => setAll((value) => !value)}>{all ? "Show the latest only" : `Show all ${events.length} events`}</button>}
  </section>
}

/* ── Detailed route, for the records panel ──────────────────────────────── */

export function RouteDetails({ view }: { view: RecordView }) {
  const { journey } = view
  return <div>
    {journey.plan && <p className="rec-note">{journey.plan.statusLabel} plan{journey.plan.version ? ` v${journey.plan.version}` : ""}{journey.plan.active ? "" : ", not activated"}{journey.plan.activatedAt ? `, activated ${fmtDateTime(journey.plan.activatedAt)}` : ""}</p>}
    {journey.groups.map((group) => {
      const legsFrom = new Map(group.legs.map((leg) => [leg.fromStepId, leg]))
      return <div className="journey-group" key={group.itemId}>
        {journey.groups.length > 1 && <p className="journey-group-head">{group.roleLabel}: {group.vehicle}</p>}
        <div className="journey">{group.steps.map((step, index) => {
          const leg = legsFrom.get(step.id)
          return <div key={step.id}>
            <StepView step={step} live={leg?.status === "IN_PROGRESS"} last={index === group.steps.length - 1 && !leg} />
            {leg && <LegView leg={leg} view={view} />}
          </div>
        })}</div>
      </div>
    })}
  </div>
}

function StepView({ step, live, last }: { step: JourneyStep; live: boolean; last: boolean }) {
  const icon = step.role === "PICKUP" ? "pin" : step.role === "DELIVERY" ? "flag" : "yard"
  return <div className={`step${step.recorded ? " done" : ""}${live ? " live" : ""}${last ? " last" : ""}`}>
    <span className="step-marker"><Icon name={step.recorded ? "check" : icon} size={13} /></span>
    <div>
      <div className="step-head">
        <span className="step-role">{step.roleLabel}</span>
        <span className="step-name">{step.site ? <Link className="name-link" href={`/sites/${step.site.id}`}>{step.place.name}</Link> : step.place.name}</span>
        <span className="step-kind">{step.place.kindLabel}</span>
      </div>
      <p className="step-addr">{step.place.addressLine ?? <span className="tone-warn">Street not supplied</span>}{step.place.city ? `, ${step.place.city}` : ""}{step.place.country ? `, ${step.place.country}` : ""}</p>
      <dl className="facts-grid">
        {step.windows.map((window) => <div className="fact" key={window.purpose + window.start}>
          <dt>{window.label}</dt>
          <dd><Range start={window.start} end={window.end} zone={window.zone} /><small>{window.sourceLabel}{window.deadline ? ` · outer limit ${fmtDateTime(window.deadline, window.zone)}` : ""}</small></dd>
        </div>)}
        {step.recorded && <div className="fact tone-ok"><dt>{step.recorded.label}</dt><dd><When at={step.recorded.at} />{step.recorded.actor && <small>{step.recorded.actor}</small>}</dd></div>}
        {step.contact && <div className={`fact tone-${step.contact.tone}`}>
          <dt>Contact</dt>
          <dd>{step.contact.name ?? "Not supplied"}{step.contact.role ? ` (${step.contact.role})` : ""} · {step.contact.statusLabel.toLowerCase()}
            {(step.contact.handle || step.contact.confirmedAt) && <small>{[step.contact.handle, step.contact.confirmedAt ? `confirmed ${fmtDateTime(step.contact.confirmedAt)}` : null].filter(Boolean).join(" · ")}</small>}
          </dd>
        </div>}
        {step.access && <div className={`fact tone-${step.access.tone}`}>
          <dt>Access</dt>
          <dd>{step.access.statusLabel}{step.access.confirmedAt && <small>confirmed {fmtDateTime(step.access.confirmedAt)}</small>}</dd>
        </div>}
        {step.site?.hours && <div className="fact"><dt>Site hours</dt><dd>{step.site.hours}{step.site.advanceNoticeMinutes ? <small>{step.site.advanceNoticeMinutes} min notice</small> : null}</dd></div>}
        {step.site?.handoverMode && <div className="fact"><dt>Handover</dt><dd>{step.site.handoverMode}{step.site.contactEmail && <small>{step.site.contactEmail}</small>}</dd></div>}
      </dl>
      {step.access?.instruction && <p className="step-instruction">{step.access.instruction}</p>}
      {step.site?.accessNote && step.site.accessNote !== step.access?.instruction && <p className="step-instruction">{step.site.accessNote}</p>}
      {step.site?.releaseRule && <p className="step-instruction">{step.site.releaseRule}</p>}
      {step.claims.length > 0 && <div className="step-notes">{step.claims.map((claim) => <p key={claim.id}><Pill tone={claim.tone}>{claim.statusLabel}</Pill> {claim.claim}{claim.source ? ` (${claim.source})` : ""}</p>)}</div>}
      {step.notes.length > 0 && <div className="step-notes">{step.notes.map((note) => <p key={note}>{note}</p>)}</div>}
      {step.proofs.length > 0 && <div className="step-proofs">{step.proofs.map((proof) => <Pill key={proof.id} tone={proof.tone} dot>{proof.kindLabel} · {proof.statusLabel.toLowerCase()}{proof.fileCount ? ` · ${files(proof.fileCount)}` : ""}</Pill>)}</div>}
    </div>
  </div>
}

function LegView({ leg, view }: { leg: JourneyLeg; view: RecordView }) {
  const assignment = leg.assignment
  const tracking = leg.tracking
  const age = tracking?.receivedAt ? relativeTo(tracking.receivedAt, view.snapshotAt) : null
  return <div className="legrow">
    <span className="legrow-marker"><Icon name="car" size={15} /></span>
    <div className="legrow-body">
      <div className="legrow-main">
        {leg.distanceKm != null && <span><b>{leg.distanceKm} km</b></span>}
        <Pill tone={leg.tone}>{leg.statusLabel}</Pill>
        {assignment
          ? <span><b><ActorName actor={assignment.driver} /></b> · {assignment.statusLabel.toLowerCase()}{assignment.fee ? ` · ${assignment.fee}` : ""}</span>
          : <span>No driver</span>}
      </div>
      {assignment?.positioning && <p className="legrow-track">{assignment.positioning}{assignment.priorOrder && <> (<OrderLink order={assignment.priorOrder} />)</>}</p>}
      {assignment && assignment.steps.length > 0 && <div className="legrow-steps">{assignment.steps.map((step) => <span key={step.id}>
        <Icon name={step.status === "COMPLETED" ? "check" : "chevron"} size={12} className={step.status === "COMPLETED" ? "tone-ok" : undefined} /> {step.title} · <span className={`tone-${step.tone}`}>{step.statusLabel.toLowerCase()}</span>{step.scheduledStart ? ` · ${fmtDateTime(step.scheduledStart)}` : ""}{step.note ? ` · ${step.note}` : ""}
      </span>)}</div>}
      {tracking && <p className="legrow-track"><b>ETA {fmtDateTime(tracking.eta)}</b>{tracking.remainingKm != null ? ` · ${tracking.remainingKm} km left` : ""}{age ? ` · ${age.text}` : ""}</p>}
      {leg.inference && <p className="legrow-track">{leg.inference.note ?? `ETA ${fmtDateTime(leg.inference.eta)}`}</p>}
    </div>
  </div>
}

export function EvidenceDetails({ view }: { view: RecordView }) {
  const { proofs, documents, custody, siteVisits } = view
  return <div>
    {proofs.length > 0 && <><p className="sub">Proofs</p><div className="rows">{proofs.map((proof) => <div className="row" key={proof.id}>
      <div className="row-main"><div className="row-title">{proof.kindLabel} <Pill tone={proof.tone}>{proof.statusLabel}</Pill></div>
        <div className="row-sub">{proof.pointLabel ? `${proof.pointLabel} · ` : ""}{proof.required ? "required" : "optional"}{proof.fileCount ? ` · ${files(proof.fileCount)}` : " · no files"}{proof.submittedAt ? ` · submitted ${fmtDateTime(proof.submittedAt)}` : " · nothing submitted"}{proof.reviewedAt ? ` · reviewed ${fmtDateTime(proof.reviewedAt)}` : ""}{proof.note ? ` · ${proof.note}` : ""}</div></div>
    </div>)}</div></>}
    {documents.length > 0 && <><p className="sub">Documents</p><div className="rows">{documents.map((document) => <div className="row" key={document.id}>
      <div className="row-main"><div className="row-title">{document.kindLabel}{document.medium ? ` (${document.medium})` : ""} <Pill tone={document.tone}>{document.statusLabel}</Pill></div>
        <div className="row-sub">{document.required ? "required" : "optional"}{document.signatureScope ? ` · signatures: ${document.signatureScope}` : ""}{document.fileCount ? ` · ${files(document.fileCount)}` : " · no file"}{document.updatedAt ? ` · updated ${fmtDateTime(document.updatedAt)}` : ""}{document.note ? ` · ${document.note}` : ""}</div></div>
    </div>)}</div></>}
    {custody.assets.length > 0 && <><p className="sub">Keys and papers</p><div className="rows">{custody.assets.map((asset) => <div className="row" key={asset.id}>
      <div className="row-main"><div className="row-title">{asset.label}</div>
        <div className="row-sub">Holder {asset.holder} · basis {asset.basis}{asset.relatedOrder && <> · linked to <OrderLink order={asset.relatedOrder} /></>}{asset.owner ? ` · next check by ${asset.owner}` : ""}{asset.dueAt ? ` ${fmtDateTime(asset.dueAt)}` : ""}</div>
        {asset.nextAction && <div className="row-preview">{asset.nextAction}</div>}
        {asset.events.map((event) => <div className="row-sub" key={event.id}>{fmtDateTime(event.at)} · {event.kindLabel} · {event.verification}{event.note ? ` · ${event.note}` : ""}</div>)}
      </div>
    </div>)}</div></>}
    {custody.reports.length > 0 && <><p className="sub">Custody reports</p><div className="rows">{custody.reports.map((report) => <div className="row" key={report.id}>
      <div className="row-main"><div className="row-title"><ActorName actor={report.driver} /> reported the vehicle {report.security}</div><div className="row-sub">Continuity: {report.continuity} · location evidence: {report.location}{report.parking ? ` · ${report.parking}` : ""}</div></div>
      <div className="row-side"><When at={report.at} /></div>
    </div>)}</div></>}
    {siteVisits.length > 0 && <><p className="sub">Site visits</p><div className="rows">{siteVisits.map((visit) => <div className="row" key={visit.id}>
      <div className="row-main"><div className="row-title">{visit.site ?? "Site"}: {visit.outcome}</div><div className="row-sub">{visit.verifiedBySite ? "Verified by the site" : "Not verified by the site"}{visit.leftAt ? ` · left ${fmtClock(visit.leftAt)}` : ""}</div></div>
      <div className="row-side"><When at={visit.at} /></div>
    </div>)}</div></>}
    {proofs.length + documents.length + custody.assets.length + custody.reports.length + siteVisits.length === 0 && <p className="empty">Nothing recorded.</p>}
  </div>
}

export function HistoryDays({ view }: { view: RecordView }) {
  return <div>{view.history.map((day) => <div className="history-day" key={day.key}>
    <h3>{day.label}</h3>
    {day.events.map((event) => <div className="event" key={event.id}>
      <time dateTime={event.at} title={fmtDateTime(event.at)}>{fmtClock(event.at)}</time>
      <div className="event-text"><b>{event.text}</b>{event.actor && <span className="actor"> · {event.actor}</span>}{event.shared && <span className="actor"> · shared bundle</span>}{event.detail && <small>{event.detail}</small>}</div>
    </div>)}
  </div>)}</div>
}
