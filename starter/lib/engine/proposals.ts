// Proposals (ticket 07): what the agent wants to do on an order, with its evidence,
// the contact and its type, who pays and the policy row that decides whether the
// agent acts alone, needs a yes, or may only propose.
//
// - Every reviewer finding becomes one proposal (id "p-" + the finding's stable id).
//   It names the review run it was drafted from (`runId`, spec .scratch/traceability),
//   and every stored event on it records that run and the finding in `data`.
//   Its kind follows the contact type: a site or driver -> a routine `call` (acts
//   alone, so it starts approved by the policy), the operator -> an
//   `operator_question` (acts alone, waits for the operator), the customer side ->
//   a `customer_contact` (propose only: approving hands the contact to the operator).
// - A site call needs a contact on record (the endpoint contact, then the site
//   profile's pickup email). Without one there is no call and no proposal: the
//   finding is listed as `unreachable` (couldn't check).
// - `change` proposals (needs a yes) come from the engine's own machinery through
//   the `proposeChange` command: call results (ticket 10), customer answers (08).
// - The operator's decisions are append-only events in the store. A proposal's
//   status, script, instructions and history are folded from them. The first stored
//   event of a finding's proposal keeps a copy of the draft, so the proposal and its
//   history survive a later review that no longer raises the finding.
//
// Pure: bundle, review and stored events in, proposals out.

import { createHash } from "node:crypto"
import { rows, str, type Bundle } from "@/lib/present/bundle"
import {
  CONTACT_TYPE_LABEL, isCustomerSide, policyFor, policyRow, type AskRole, type ContactType, type Decision, type PolicyRowId,
} from "@/lib/reviewer/policy"
import { customerOwnsSite, customerSideOf, endpointContactType, endpointSite } from "./contacts"
import { nextChecksOf } from "./due"
import { statementsBy, type EffectSpec } from "./effects"
import type { CitedRecord, OrderReview, ReviewFinding } from "./reviews"

export type ProposalKind = "call" | "operator_question" | "customer_contact" | "change"
export type ProposalStatus = "proposed" | "approved" | "answered" | "dismissed"
export type ProposalEventKind = "proposed" | "approved" | "edited" | "dismissed" | "instructed" | "answered" | "withdrawn"

/** Who acted: the reviewer or call agent, the approval policy, or the operator. */
export type Actor = "agent" | "policy" | "operator"

export type ProposalEvent = { at: string; by: Actor; kind: ProposalEventKind; text: string }

export type ProposalContact = {
  name: string
  type: ContactType
  typeLabel: string
  role: AskRole
  /** Phone or email for a site, the driver ID for a driver; null for the operator and the customer side (never contacted by the agent). */
  handle: string | null
  /** The record that names the contact. */
  recordId: string | null
}

/** What the agent wants to do, before the operator's decisions are applied. */
export type ProposalDraft = {
  id: string
  orderId: string
  reference: string
  kind: ProposalKind
  findingId: string | null
  title: string
  /** What the agent wants to do, in one sentence. */
  action: string
  /** The drafted question or script; the operator can edit it. */
  script: string
  why: string
  evidence: CitedRecord[]
  contact: ProposalContact
  whoPays: string
  policyRow: PolicyRowId
  decision: Decision
  /** For a change proposal: what approving writes to the order. */
  change: string | null
  /**
   * For a change proposal: the effect event approving writes (ticket 09). Absent:
   * the change is committed as an attributed claim by whoever said it (see `changeEffect`).
   */
  effect?: EffectSpec | null
  /** Where the proposal came from, e.g. "reviewer" or a call id. */
  source: string
  /** A finding's proposal: the agent run of the review it was drafted from (null untraced; absent on drafts stored before tracing). */
  runId?: string | null
  proposedAt: string
}

export type Proposal = Omit<ProposalDraft, "proposedAt"> & {
  status: ProposalStatus
  /**
   * Who the proposal waits on: "operator" (a yes, a customer contact handed over, a
   * question), "agent" (a routine call to make), or null (decided).
   */
  waitingOn: "operator" | "agent" | null
  /** What approving will do, shown before a (batch) approval; null when the proposal cannot be approved. */
  onApprove: string | null
  /** The operator's instructions on this proposal, oldest first; fed to the order's next review run. */
  instructions: { at: string; text: string }[]
  /** The answer the operator recorded (a customer's answer, or the operator's own to a question); null until answered. */
  answer: string | null
  history: ProposalEvent[]
}

/** One stored operator decision (or an engine-made proposal), as the store keeps it. */
export type StoredProposalEvent = {
  proposalId: string
  orderId: string
  at: string
  by: Actor
  kind: ProposalEventKind
  text: string
  /**
   * `draft` on a proposal's first stored event; `script` on an edit; `title` on an instruction; `answer`, `question` and `from` on an answer;
   * `runId` (null untraced) and `findingId` on every event of a finding's proposal (spec .scratch/traceability).
   */
  data: { draft?: ProposalDraft; script?: string; title?: string; answer?: string; question?: string; from?: string; runId?: string | null; findingId?: string } | null
}

/** A finding the agent cannot act on: no contact on record (listed as couldn't check). */
export type Unreachable = { findingId: string; title: string; reason: string }

export type OrderProposals = { proposals: Proposal[]; unreachable: Unreachable[] }

function shortHash(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 12)
}

export function proposalIdFor(findingId: string): string {
  return `p-${findingId.replace(/^f-/, "")}`
}

export function changeProposalId(orderId: string, title: string, change: string): string {
  return `chg-${shortHash(orderId, title, change)}`
}

function kindFor(type: ContactType): ProposalKind {
  if (isCustomerSide(type)) return "customer_contact"
  if (type === "operator") return "operator_question"
  return "call"
}

/**
 * The contact the agent would reach for a site: the cited endpoint's contact, else the
 * order's pickup endpoint contact, then the site profile's pickup email; with that
 * contact's type from the records (a fallback can land on the customer side).
 */
function siteContact(bundle: Bundle, recordId: string): { handle: string | null; type: ContactType } {
  const endpoints = rows(bundle, "order_endpoint_details")
  const cited = endpoints.find((row) => row.id === recordId)
  const endpoint = cited ?? endpoints.find((row) => row.details.boundary === "PICKUP") ?? null
  const handle = str(endpoint?.details.contact_handle)
  if (endpoint && handle) return { handle, type: endpointContactType(bundle, endpoint) }
  const siteId = (endpoint ? endpointSite(bundle, endpoint) : null) ?? (bundle.sites.has(recordId) ? recordId : bundle.order.pickupSiteId)
  const site = siteId ? bundle.sites.get(siteId) : undefined
  return { handle: str(site?.details.pickup_contact_email), type: customerOwnsSite(bundle, siteId) ? "customer_owned_site" : "third_party_site" }
}

function driverHandle(bundle: Bundle, recordId: string, quote: string): string | null {
  const assignments = rows(bundle, "work_assignments")
  const cited = assignments.find((row) => row.id === recordId)
  if (cited) return str(cited.details.driver_id)
  if (/^drv-/.test(quote)) return quote
  return str(assignments.find((row) => row.details.order_id === bundle.order.id)?.details.driver_id)
}

/** The contact's name, with the handle when the name does not already carry it. */
function who(contact: ProposalContact): string {
  return contact.handle && !contact.name.includes(contact.handle) ? `${contact.name} (${contact.handle})` : contact.name
}

function actionText(kind: ProposalKind, contact: ProposalContact): string {
  if (kind === "call") return `Call ${who(contact)} and ask the question below.`
  if (kind === "operator_question") return "Ask you the question below in the app."
  if (kind === "customer_contact") return `Hand you the contact with ${contact.name}: you make it with the script below and record the answer.`
  return "Change the order."
}

/** A finding as the proposal the agent drafts, or why it cannot become one. `runId`: the run of the review that raised it. */
export function draftFromFinding(bundle: Bundle, finding: ReviewFinding, proposedAt: string, runId: string | null = null): ProposalDraft | Unreachable {
  // The records decide the type: a contact they show on the customer side is never called,
  // whatever the finding says, and neither is a fallback contact that lands there.
  let type = customerSideOf(bundle, finding.ask.contactRecordId) ?? finding.ask.contactType
  let handle: string | null = null
  if (kindFor(type) === "call") {
    if (finding.ask.role === "driver" || type === "driver") handle = driverHandle(bundle, finding.ask.contactRecordId, finding.ask.contactQuote)
    else {
      const reached = siteContact(bundle, finding.ask.contactRecordId)
      if (isCustomerSide(reached.type)) type = reached.type
      else handle = reached.handle
    }
  }
  const kind = kindFor(type)
  if (kind === "call" && !handle) {
    return { findingId: finding.id, title: finding.title, reason: `No contact on record for ${finding.ask.name}: no call, couldn't check.` }
  }
  const contact: ProposalContact = {
    name: finding.ask.name, type, typeLabel: CONTACT_TYPE_LABEL[type], role: finding.ask.role, handle, recordId: finding.ask.contactRecordId,
  }
  const row = policyFor(type, "question")
  return {
    id: proposalIdFor(finding.id), orderId: bundle.order.id, reference: bundle.order.reference, kind, findingId: finding.id,
    title: finding.title, action: actionText(kind, contact), script: finding.question, why: finding.why, evidence: finding.cited,
    contact, whoPays: finding.whoPays, policyRow: row.id, decision: row.decision, change: null, source: "reviewer", runId, proposedAt,
  }
}

/** A change the agent wants to make: needs an operator's yes (policy row order-change). */
export function changeDraft(bundle: Bundle, input: {
  title: string; change: string; why: string; source: string; contact?: { name: string; type: ContactType; role: AskRole; recordId?: string | null }
  evidence?: CitedRecord[]; whoPays?: string; effect?: EffectSpec | null
}, proposedAt: string): ProposalDraft {
  const type = input.contact?.type ?? "operator"
  const row = policyFor(type, "change")
  const contact: ProposalContact = {
    name: input.contact?.name ?? "Operator", type, typeLabel: CONTACT_TYPE_LABEL[type], role: input.contact?.role ?? "operator",
    handle: null, recordId: input.contact?.recordId ?? null,
  }
  return {
    id: changeProposalId(bundle.order.id, input.title, input.change), orderId: bundle.order.id, reference: bundle.order.reference,
    kind: "change", findingId: null, title: input.title, action: `Change the order: ${input.change}`, script: input.change, why: input.why,
    evidence: input.evidence ?? [], contact, whoPays: input.whoPays ?? `${bundle.customer.id} ${bundle.customer.name} pays for the order.`,
    policyRow: row.id, decision: row.decision, change: input.change, source: input.source, proposedAt,
    ...(input.effect ? { effect: input.effect } : {}),
  }
}

/**
 * The effect event approving a change writes: its own `effect`, else the change as
 * an attributed claim by whoever said it (the customer side, a site or driver on a
 * call, the operator).
 */
export function changeEffect(proposal: Pick<ProposalDraft, "change" | "title" | "effect" | "contact">): EffectSpec {
  if (proposal.effect) return proposal.effect
  const claim = proposal.change ?? proposal.title
  if (isCustomerSide(proposal.contact.type)) return { type: "customer_answer_recorded", from: `${proposal.contact.name} (${proposal.contact.typeLabel.toLowerCase()})`, question: proposal.title, answer: claim }
  if (proposal.contact.type === "operator") return { type: "operator_answer_recorded", question: proposal.title, answer: claim }
  return { type: "call_result_recorded", with: `${proposal.contact.name} (${proposal.contact.typeLabel.toLowerCase()})`, claim }
}

function onApproveText(draft: ProposalDraft): string {
  if (draft.kind === "customer_contact") return "Hands you the contact to make yourself."
  if (draft.kind === "change") return "Writes this to the order."
  if (draft.kind === "operator_question") return "Puts the question to you."
  return `The agent calls ${draft.contact.name.split(",")[0]}.`
}

function waitingOn(kind: ProposalKind, status: ProposalStatus): Proposal["waitingOn"] {
  if (status === "dismissed" || status === "answered") return null
  if (status === "proposed") return "operator"
  if (kind === "call") return "agent"
  if (kind === "change") return null
  return "operator"
}

/** A policy row in a few plain words, for the history line its approval writes. */
const RULE_WORDS: Partial<Record<string, string>> = {
  "site-routine": "routine site call", "driver-routine": "routine driver call", "operator-question": "question to the operator",
  "pickup-readiness": "pickup-readiness call",
}

/** Folds a draft and its stored events into the proposal as it stands. */
export function foldProposal(draft: ProposalDraft, events: StoredProposalEvent[], withdrawnAt: string | null = null): Proposal {
  const row = policyRow(draft.policyRow)
  const history: ProposalEvent[] = [{ at: draft.proposedAt, by: "agent", kind: "proposed", text: draft.action }]
  let status: ProposalStatus = "proposed"
  if (row.decision === "acts alone") {
    status = "approved"
    history.push({ at: draft.proposedAt, by: "policy", kind: "approved", text: `Allowed by rule: ${RULE_WORDS[row.id] ?? row.action.toLowerCase()}` })
  }
  let script = draft.script
  const instructions: Proposal["instructions"] = []
  let answer: string | null = null
  for (const event of events) {
    if (event.kind === "proposed") continue
    history.push({ at: event.at, by: event.by, kind: event.kind, text: event.text })
    if (event.kind === "approved") status = "approved"
    if (event.kind === "dismissed") status = "dismissed"
    if (event.kind === "answered") { status = "answered"; answer = event.data?.answer ?? event.text }
    if (event.kind === "edited" && event.data?.script) script = event.data.script
    if (event.kind === "instructed") instructions.push({ at: event.at, text: event.text })
  }
  if (withdrawnAt && status === "proposed") {
    status = "dismissed"
    history.push({ at: withdrawnAt, by: "agent", kind: "withdrawn", text: "The latest review no longer raises this; withdrawn." })
  }
  const { proposedAt: _proposedAt, ...rest } = draft
  return {
    ...rest, script, status, waitingOn: waitingOn(draft.kind, status),
    onApprove: status === "proposed" ? onApproveText({ ...draft, script }) : null,
    instructions, answer, history,
  }
}

/** The source of a proposal drafted from the NEXT rule (a next check that came due). */
export const NEXT_CHECK_SOURCE = "rule:NEXT"

const humanise = (code: string) => code.toLowerCase().replace(/_/g, " ")

/** A next check whose open question is with the customer side (the customer was asked; a seller hold is the customer's to clear). */
const CUSTOMER_WAIT = /^(CUSTOMER|SELLER)_/

/**
 * The next step for each next check the NEXT rule handed to the operator (first action
 * `operator_proposal`, spec story 69): a customer-side contact when the open question is
 * with the customer (propose only, ADR 0001; CD-420458, CD-420009), else a question to
 * the operator (Ops' own review, CD-420326). Each cites the thread whose check came due.
 */
export function nextCheckDrafts(bundle: Bundle, rules: { id: string; outcome: string; firstAction: string | null; detail: string; sources: { id: string }[] }[]): ProposalDraft[] {
  const rule = rules.find((row) => row.id === "NEXT" && row.outcome === "fail" && row.firstAction === "operator_proposal")
  if (!rule) return []
  const due = new Set(rule.sources.map((source) => source.id))
  return nextChecksOf(bundle).filter((check) => due.has(check.conversationId)).map((check) => {
    const waiting = check.waitingOn ?? "OPERATOR_FOLLOWUP"
    const customer = CUSTOMER_WAIT.test(waiting)
    const type: ContactType = customer ? "paying_customer" : "operator"
    const kind = kindFor(type)
    const thread = `${humanise(check.category)} thread`
    const what = humanise(waiting.replace(CUSTOMER_WAIT, ""))
    const contact: ProposalContact = customer
      ? { name: bundle.customer.name, type, typeLabel: CONTACT_TYPE_LABEL[type], role: "customer", handle: null, recordId: bundle.customer.id }
      : { name: "Operator", type, typeLabel: CONTACT_TYPE_LABEL[type], role: "operator", handle: null, recordId: null }
    const row = policyFor(type, "question")
    return {
      id: `nx-${shortHash(bundle.order.id, check.conversationId)}`, orderId: bundle.order.id, reference: bundle.order.reference, kind, findingId: null,
      title: customer ? `Follow up with the customer on the ${what}` : `Next check due on the ${thread}: ${what}`,
      action: actionText(kind, contact),
      script: customer
        ? `We are following up on order ${bundle.order.reference}: is the ${what} settled now?`
        : `The ${thread} on ${bundle.order.reference} waits on ${what} and its next check is due. What is the next step?`,
      why: rule.detail,
      evidence: [{
        recordId: check.conversationId, role: "conflict", kind: "conversations", field: "next_check_at", quote: check.at,
        value: `Waiting on ${humanise(waiting)}, next check ${check.at}`, at: check.at, local: null, statedBy: null,
      }],
      contact, whoPays: `${bundle.customer.id} ${bundle.customer.name} pays for the order.`,
      policyRow: row.id, decision: row.decision, change: null, source: NEXT_CHECK_SOURCE, proposedAt: check.at,
    }
  })
}

/**
 * The records an answer to a proposal replaces: a rule-made proposal's cited records
 * (the thread whose check it followed up), else the conflict evidence `party` stated.
 */
export function answeredBy(proposal: Pick<ProposalDraft, "source" | "evidence">, party: (statedBy: string) => boolean): string[] {
  if (proposal.source === NEXT_CHECK_SOURCE) return [...new Set(proposal.evidence.filter((cited) => cited.role === "conflict").map((cited) => cited.recordId))]
  return statementsBy(proposal.evidence, party)
}

/** Every proposal on one order: from the current review's findings and the rules, plus stored ones (decided earlier, or engine-made). */
export function proposalsFor(bundle: Bundle, review: OrderReview, stored: StoredProposalEvent[], fromRules: ProposalDraft[] = []): OrderProposals {
  const drafts = new Map<string, ProposalDraft>(fromRules.map((draft) => [draft.id, draft]))
  const unreachable: Unreachable[] = []
  const current = new Set<string>()
  if (review.status === "reviewed") {
    for (const finding of review.findings) {
      const draft = draftFromFinding(bundle, finding, review.reviewAt, review.runId)
      if ("reason" in draft) { unreachable.push(draft); continue }
      if (drafts.has(draft.id)) continue
      drafts.set(draft.id, draft)
      current.add(draft.id)
    }
  }
  const byProposal = new Map<string, StoredProposalEvent[]>()
  for (const event of stored) {
    const list = byProposal.get(event.proposalId) ?? []
    list.push(event)
    byProposal.set(event.proposalId, list)
    const kept = event.data?.draft
    if (!kept) continue
    const fromReview = drafts.get(event.proposalId)
    // A later review (after an effect event) raises the same finding: it was still proposed when first stored.
    drafts.set(event.proposalId, fromReview ? { ...fromReview, proposedAt: kept.proposedAt } : kept)
  }
  const proposals = [...drafts.values()].map((draft) => {
    const events = byProposal.get(draft.id) ?? []
    // A finding's proposal the latest review no longer raises is withdrawn (if still undecided).
    const gone = draft.findingId !== null && review.status === "reviewed" && !current.has(draft.id)
    return foldProposal(draft, events, gone ? review.reviewAt : null)
  })
  return { proposals, unreachable }
}

/** The operator's instructions on an order, as the reviewer's prior state reads them. */
export function instructionsFor(stored: StoredProposalEvent[]): { id: string; at: string; by: string; text: string }[] {
  const out: { id: string; at: string; by: string; text: string }[] = []
  const seen = new Map<string, number>()
  for (const event of stored) {
    if (event.kind !== "instructed") continue
    const n = (seen.get(event.proposalId) ?? 0) + 1
    seen.set(event.proposalId, n)
    const title = event.data?.title ?? event.data?.draft?.title
    out.push({ id: `${event.proposalId}-i${n}`, at: event.at, by: "operator", text: title ? `On "${title}": ${event.text}` : event.text })
  }
  return out
}

/** The answers the operator recorded on an order, as the reviewer's prior state reads them. */
export function answersFor(stored: StoredProposalEvent[]): { id: string; at: string; from: string; question: string; answer: string }[] {
  return stored.filter((event) => event.kind === "answered").map((event) => ({
    id: `${event.proposalId}-a`, at: event.at, from: event.data?.from ?? "operator",
    question: event.data?.question ?? event.data?.draft?.script ?? "", answer: event.data?.answer ?? event.text,
  }))
}
