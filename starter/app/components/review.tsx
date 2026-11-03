"use client"

// The reviewer's read of one order (ticket 06): what it read, what it found, and
// each finding's cited records with the quoted values highlighted. Cited records
// are also marked where they appear on the order page (`useCited`).

import { createContext, useContext, type ReactNode } from "react"
import type { CitedRecord, OrderReview, ReviewFinding } from "@/lib/engine/reviews"
import { humanize } from "@/lib/present/labels"
import { Icon } from "./icons"
import { More, Pill } from "./ui"

/** Record ids the order's findings cite. The order page provides it; rows read it to mark themselves. */
const CitedContext = createContext<ReadonlySet<string>>(new Set())

export function CitedProvider({ ids, children }: { ids: string[]; children: ReactNode }) {
  return <CitedContext.Provider value={new Set(ids)}>{children}</CitedContext.Provider>
}

export function useCited(): ReadonlySet<string> {
  return useContext(CitedContext)
}

/** Marks a record a reviewer finding cites, where the record is shown. */
export function CitedTag() {
  return <span className="cited-tag"><Pill tone="danger">Cited</Pill></span>
}

/** The anchor a cited record carries where it is shown on the order page. */
export function recordAnchor(recordId: string): string {
  return `rec-${recordId}`
}

/** Where on the order page a record of this kind is shown. Messages and notes carry their own anchor. */
const SECTION_OF_KIND: Record<string, string> = {
  message: "", order_notes: "", conversation: "",
  order: "facts", order_item: "facts", customer: "facts",
  order_endpoint_details: "route", time_windows: "route", transport_points: "route", transport_plans: "route", transport_segments: "route",
  endpoint_claims: "route", tracking_observations: "route", address: "route", site_profile: "route",
  alert: "work", work_items: "work", incidents: "work",
  work_assignments: "drivers", assignment_steps: "drivers",
  market_offers: "market",
  travel_reservations: "travel", travel_options: "travel", travel_confirmations: "travel",
  expenses: "costs",
  documents: "evidence-details", proofs: "evidence-details", custody_assets: "evidence-details",
  agent_proposals: "proposals", internal_notifications: "proposals",
  operational_event: "events",
}

function citedHref(cited: CitedRecord, samePage: boolean, orderId: string): string {
  const section = cited.kind ? SECTION_OF_KIND[cited.kind] : undefined
  const anchor = section === "" ? recordAnchor(cited.recordId) : section ?? "records"
  return samePage ? `#${anchor}` : `/orders/${encodeURIComponent(orderId)}#${anchor}`
}

/** A code value ("NEEDS_VERIFICATION") read as words; free text stays as written. */
function plain(text: string): string {
  return /^[A-Z0-9_]+$/.test(text.trim()) ? humanize(text) : text
}

/** Who said it, when that is a person or a party, not a system field ("CUSTOMER_ORDER_INPUT", "operator:ops-shift"). */
function speaker(statedBy: string | null | undefined): string | null {
  if (!statedBy || /^[A-Z0-9_]+$/.test(statedBy) || statedBy.includes(":")) return null
  return statedBy
}

/** The field text with every occurrence of the quote marked (case- and spacing-insensitive). */
export function Highlighted({ text, quote }: { text: string; quote: string }) {
  const wanted = quote.trim().replace(/^["']|["']$/g, "").replace(/[.]$/, "")
  if (!wanted) return <>{text}</>
  const pattern = new RegExp(wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"), "gi")
  const parts: ReactNode[] = []
  let at = 0
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0
    if (start > at) parts.push(text.slice(at, start))
    parts.push(<mark className="quote-mark" key={start}>{match[0]}</mark>)
    at = start + match[0].length
  }
  if (parts.length === 0) return <>{text} <mark className="quote-mark">{quote}</mark></>
  if (at < text.length) parts.push(text.slice(at))
  return <>{parts}</>
}

/** One cited record: the value with the quote marked, who said it and when; the row opens the record. */
export function CitedRow({ cited, orderId, samePage }: { cited: CitedRecord; orderId: string; samePage: boolean }) {
  const value = cited.value && cited.value.length <= 600 ? plain(cited.value) : null
  const quote = plain(cited.quote)
  // A short value ("Aalborg", "Unconfirmed") needs its field to read; a sentence does not.
  const field = cited.field && (value ?? quote).length <= 40 ? `${humanize(cited.field)}: ` : ""
  const meta = [cited.local, speaker(cited.statedBy)].filter(Boolean).join(" · ")
  return <li className={`cited cited-${cited.role}`}>
    <a className="cited-link" href={citedHref(cited, samePage, orderId)} title={`Open ${cited.recordId}`}>
      <p className="cited-value">{field && <span className="cited-field">{field}</span>}{value ? <Highlighted text={value} quote={quote} /> : <mark className="quote-mark">{quote}</mark>}</p>
      {meta && <div className="cited-meta">{meta}</div>}
    </a>
  </li>
}

const ROLE_LABEL: Record<string, string> = { site: "Site", driver: "Driver", operator: "Operator", customer: "Customer" }

function FindingCard({ finding, orderId, samePage }: { finding: ReviewFinding; orderId: string; samePage: boolean }) {
  const conflict = finding.cited.filter((cited) => cited.role === "conflict")
  return <article className="finding" id={finding.id}>
    <div className="finding-title"><Icon name="alert" className="tone-danger" />{finding.title}</div>
    <dl className="finding-facts">
      <div><dt>Ask</dt><dd>{finding.ask.name} <span className="finding-role">({ROLE_LABEL[finding.ask.role] ?? finding.ask.role})</span></dd></div>
      <div><dt>Question</dt><dd className="finding-question">{finding.question}</dd></div>
      <div><dt>Why</dt><dd>{finding.why}</dd></div>
    </dl>
    {conflict.length > 0 && <More label={`Sources (${conflict.length})`}><ul className="cited-list">{conflict.map((cited, i) => <CitedRow key={`${cited.recordId}-${i}`} cited={cited} orderId={orderId} samePage={samePage} />)}</ul></More>}
  </article>
}

/** One line on what the reviewer did, for the compact preview and the panel head. */
export function reviewLine(review: OrderReview): string {
  if (review.status !== "reviewed") return "Not reviewed yet"
  return review.findings.length ? `${review.findings.length} ${review.findings.length === 1 ? "finding" : "findings"}` : "Nothing to add"
}

/** `shown`: findings already shown as proposals (with their evidence); the rest are listed here. */
export function ReviewBlock({ orderId, review, compact = false, shown = new Set() }: { orderId: string; review: OrderReview; compact?: boolean; shown?: ReadonlySet<string> }) {
  const rest = review.findings.filter((finding) => !shown.has(finding.id))
  const reviewed = review.status === "reviewed"
  return <div className="checks-block review" id="review">
    <h3>Reviewer</h3>
    <div className="check">
      <Icon name="bot" className={reviewed ? (review.findings.length ? "tone-danger" : "tone-ok") : "tone-neutral"} />
      <div>
        <div className="check-title">{reviewLine(review)}</div>
        {reviewed
          ? review.summary && <More label="Full analysis"><div className="check-detail">{review.summary}</div></More>
          : review.reason && !/^not reviewed yet\.?$/i.test(review.reason.trim()) && <div className="check-detail">{review.reason.replace(/^not reviewed yet:?\s*/i, "").replace(/^./, (c) => c.toUpperCase())}</div>}
      </div>
    </div>
    {!compact && rest.map((finding) => <FindingCard key={finding.id} finding={finding} orderId={orderId} samePage />)}
    {compact && rest.length > 0 && <ul className="checks-list">{rest.map((finding) => <li className="check" key={finding.id}>
      <Icon name="alert" className="tone-danger" />
      <div><div className="check-title">{finding.title}</div><div className="check-detail">Ask {finding.ask.name}: {finding.question}</div></div>
    </li>)}</ul>}
  </div>
}
