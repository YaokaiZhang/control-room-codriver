// What the engine says about one order: the rule results, the agent work they
// plan, the group the order is in and how urgent it is. Pure: the rules' evaluation
// and the order's review in, a verdict out. Later tickets add inputs (proposals,
// calls) and fold them into `verdictFor`.

import type { Evaluation, Fleet, RuleContext } from "./rules"

/** `done` is shown as "Finished": delivered or cancelled with nothing open. */
export type Group = "needs_action" | "in_progress" | "solved" | "normal" | "done"
export const GROUPS: Group[] = ["needs_action", "in_progress", "solved", "normal", "done"]

/** A record a rule read, so the UI can link to it. `collection` is the dataset file name. */
export type SourceRef = {
  collection: string; id: string; label: string
  /** The operator's verb when the record can be closed from the app ("Accept", "Mark done"); set on the CLOSE rule's open records. */
  close?: string
}

/**
 * What a rule asks for first when it fails (or, for a weak rule, when it plans a call):
 * - `site_call` / `driver_call`: a routine tier-1 call, no approval needed;
 * - `reviewer_pass`: the reviewer reads the order's records;
 * - `show_person`: the order goes to Needs action with the evidence;
 * - `operator_proposal`: the agent drafts the next step as a proposal to the operator
 *   (a customer-side contact or an operator question, proposals.ts), which puts the
 *   order in Needs action until the operator decides it (spec story 69).
 */
export type FirstAction = "site_call" | "driver_call" | "reviewer_pass" | "show_person" | "operator_proposal"

/**
 * `pass`: checked and fine. `fail`: the rule fired. `unknown`: it could not be
 * checked (a weak signal, or a strong rule missing its inputs); listed under
 * "couldn't check". Weak rules never fail.
 */
export type Outcome = "pass" | "fail" | "unknown"

export type RuleId = "R1" | "R3" | "R7" | "R10" | "R11" | "R12" | "R13" | "R4" | "R5" | "R6" | "CLOSE" | "NEXT"

export type RuleResult = {
  id: RuleId
  strength: "strong" | "weak"
  /** What the rule checks, as a line on the "checked" list. */
  title: string
  outcome: Outcome
  /** What the rule found, in one sentence. */
  detail: string
  /** The first action this rule takes when it fires, or null when it has nothing to do. */
  firstAction: FirstAction | null
  sources: SourceRef[]
}

/** Who a planned call goes to: the order's pickup endpoint contact, only when it is a third party (never the customer side, ADR 0001). */
export type Callee = { name: string | null; handle: string; role: string | null; endpointId: string }

/** Agent work the rules planned. Calls are tier 1 and need no approval. */
export type PlannedAction = {
  kind: "site_call" | "driver_call" | "reviewer_pass"
  /** The rules that asked for it. */
  ruleIds: RuleId[]
  /** What each of those rules read (its sources): a call on the rule asks about these records. */
  sources?: Partial<Record<RuleId, SourceRef[]>>
  reason: string
  callee: Callee | null
}

export type UrgencyReason = "action_due" | "promise_at_risk" | "pickup_unready"

export type Urgency = {
  urgent: boolean
  reasons: { kind: UrgencyReason; text: string; at: string | null }[]
  /** The earliest deadline the rules know of (pickup, promise, due check), for ranking. */
  dueAt: string | null
}

export type Verdict = {
  group: Group
  /** One line: why the order is in Needs action or In progress; what was checked otherwise. */
  reason: string
  rules: RuleResult[]
  planned: PlannedAction[]
  urgency: Urgency
}

/** What grouping needs from the order's review (ticket 06). */
export type ReviewSignal = { status: "reviewed" | "not_reviewed"; recordsRead: number; findings: { title: string }[] }

/** What grouping needs from the order's proposals (ticket 07, lib/engine/proposals.ts). */
export type ProposalSignal = {
  id?: string
  title: string
  kind: "call" | "operator_question" | "customer_contact" | "change"
  status: "proposed" | "approved" | "answered" | "dismissed"
  waitingOn: "operator" | "agent" | null
  contact: { name: string }
}

/**
 * What grouping needs from the order's calls (ticket 10, lib/engine/calls.ts): one
 * entry per call line. A call running, a callback scheduled or due keeps the order
 * In progress; an open tier-3 `handover` (ticket 14) or `needs_person` (no answer
 * after every attempt) sends it to Needs action, the handover first in the reason. `carried`: call proposals a running call or callback speaks for.
 */
export type CallSignal = {
  lines: { status: "to_call" | "calling" | "callback" | "callback_due" | "handover" | "needs_person" | "done" | "on_request"; text: string }[]
  carried: Set<string>
}

/**
 * The order's proposals, findings the agent cannot act on for lack of a contact, its
 * calls, and `solved`: what each call result the agent committed and the operator
 * has not confirmed yet says (publishing.ts).
 */
export type WorkSignal = { proposals: ProposalSignal[]; unreachable: { title: string }[]; calls?: CallSignal; solved?: string[] }

const sentence = (text: string) => text.replace(/[.]$/, "")

function waitingText(proposal: ProposalSignal): string {
  if (proposal.status === "proposed") return `Waiting for your yes: ${sentence(proposal.title)}.`
  if (proposal.kind === "customer_contact") return `Customer contact is with you: ${sentence(proposal.title)}.`
  if (proposal.kind === "operator_question") return `Question for you: ${sentence(proposal.title)}.`
  return `Waiting on you: ${sentence(proposal.title)}.`
}

/**
 * The one place groups are decided. Rules first (ticket 03), then the reviewer's
 * findings as proposals under the approval policy (ticket 07):
 * - a strong fail shown to a person, or a proposal waiting on the operator (a yes, a
 *   customer contact handed over, a question) -> Needs action;
 * - else planned agent work or a routine call the agent will make -> In progress
 *   (a done review fulfils the rules' reviewer pass);
 * - else finished with nothing open -> Done (shown as "Finished");
 * - else call results the agent committed and the operator has not confirmed -> Solved
 *   (confirm before publishing);
 * - else Normal, which says what the reviewer read.
 * Decided proposals (dismissed, answered, an approved change) no longer hold an order.
 * A finding with no contact on record is a gap ("couldn't check"), not a decision.
 */
export function verdictFor(evaluation: Evaluation, review: ReviewSignal | null = null, work: WorkSignal = { proposals: [], unreachable: [] }): Verdict {
  const { rules, urgency, finished } = evaluation
  const reviewed = review?.status === "reviewed"
  const planned = reviewed ? evaluation.planned.filter((action) => action.kind !== "reviewer_pass") : evaluation.planned
  const decisions = rules.filter((row) => row.outcome === "fail" && row.firstAction === "show_person")
  const forOperator = work.proposals.filter((proposal) => proposal.waitingOn === "operator")
  const lines = work.calls?.lines ?? []
  const handovers = lines.filter((line) => line.status === "handover")
  const forPerson = lines.filter((line) => line.status === "needs_person")
  if (decisions.length || forOperator.length || handovers.length || forPerson.length) {
    const reason = [...handovers.map((line) => line.text), ...forOperator.map(waitingText), ...forPerson.map((line) => line.text), ...decisions.map((row) => row.detail)].join(" ")
    return { group: "needs_action", reason, rules, planned, urgency }
  }
  const carried = work.calls?.carried ?? new Set<string>()
  const forAgent = work.proposals.filter((proposal) => proposal.waitingOn === "agent" && !(proposal.id && carried.has(proposal.id)))
  const calling = lines.filter((line) => line.status === "calling" || line.status === "callback" || line.status === "callback_due")
  if (planned.length || forAgent.length || calling.length) {
    const reason = [
      ...calling.map((line) => line.text),
      ...forAgent.map((proposal) => `Agent will call ${proposal.contact.name}: ${sentence(proposal.title)}.`),
      ...planned.map((action) => action.reason),
    ].join(" ")
    return { group: "in_progress", reason, rules, planned, urgency }
  }
  const results = lines.filter((line) => line.status === "done" && line.text).map((line) => line.text)
  const decided = work.proposals.length
  const readNote = reviewed
    ? decided ? `Reviewer read ${review.recordsRead} records; ${decided === 1 ? "its proposal is" : `all ${decided} proposals are`} decided.` : `Reviewer read ${review.recordsRead} records, no conflict.`
    : null
  const unreachable = work.unreachable.map((finding) => `Reviewer: ${sentence(finding.title)}, but no contact is on record, so it couldn't be checked.`)
  const gaps = rules.filter((row) => row.outcome === "unknown").length + work.unreachable.length
  if (finished && gaps === 0) return { group: "done", reason: ["Finished with nothing open.", readNote, ...results].filter(Boolean).join(" "), rules, planned, urgency }
  const solved = work.solved ?? []
  if (solved.length) {
    const head = `The agent's calls settled ${solved.length === 1 ? "an open point" : `${solved.length} open points`}; waiting for your yes on the change.`
    return { group: "solved", reason: [head, ...solved.map((text) => `${sentence(text)}.`)].join(" "), rules, planned, urgency }
  }
  // Normal is "passed the rules and the reviewer" (spec "Grouping"): a strong rule whose
  // first action is a reviewer pass fired, and the done review found nothing to act on.
  // The reason says so rather than claiming every check passed.
  const cleared = reviewed ? rules.filter((row) => row.outcome === "fail" && row.firstAction === "reviewer_pass") : []
  const clearedNote = cleared.map((row) => `The reviewer cleared “${row.title}”: ${sentence(row.detail)}.`)
  const others = rules.length - cleared.length
  const gapNote = `${gaps === 1 ? "one gap" : `${gaps} gaps`} couldn't be checked`
  const ruleNote = cleared.length
    ? gaps ? `Nothing else to act on; ${gapNote}.` : `The other ${others} checks passed.`
    : gaps ? `The rules found nothing to act on; ${gapNote}.` : `All ${rules.length} checks passed.`
  return { group: "normal", reason: [...results, readNote, ...clearedNote, ...unreachable, ruleNote].filter(Boolean).join(" "), rules, planned, urgency }
}

const URGENT_FIRST = (a: Urgency, b: Urgency) => Number(b.urgent) - Number(a.urgent)
  || (a.dueAt ?? "9").localeCompare(b.dueAt ?? "9")

/** Needs action order: urgent first, then the soonest deadline, then by reference. */
export function compareUrgency(a: { urgency: Urgency; reference: string }, b: { urgency: Urgency; reference: string }): number {
  return URGENT_FIRST(a.urgency, b.urgency) || a.reference.localeCompare(b.reference)
}

export type { Evaluation, Fleet, RuleContext }
