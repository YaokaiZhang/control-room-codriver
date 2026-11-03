// The approval policy (PRD §7.1, ADR 0001): contact type × action type -> acts alone,
// needs a yes, or propose only. This table is the one source: the reviewer's prompt,
// its `get_policy` tool and the finding check read it, the engine turns findings into
// proposals with `policyFor`, and the Rules page renders it.
//
// Adding a row: give it an id, the contact types and action type it covers and a
// decision; `policyFor` must still find exactly one row for every contact type and
// question or change (the engine's proposal tests check that). `renderPolicy` (the
// prompt) reads only id, contact, action and decision of the reviewer's rows, so the
// other fields can change without changing the reviewer's prompt or its cached reviews.
// A row marked `reviewer: false` (pickup-readiness) is engine-only: it governs the
// rules' planned calls and never reaches the prompt or the policy_row enum.

export type ContactType =
  | "paying_customer"
  | "customer_given_contact"
  | "customer_owned_site"
  | "third_party_site"
  | "driver"
  | "operator"

export type AskRole = "site" | "driver" | "operator" | "customer"

export type PolicyRowId = "site-routine" | "driver-routine" | "operator-question" | "customer-side" | "order-change" | "pickup-readiness"

/**
 * What the agent wants to do: ask someone a question, change the order, or make a
 * pickup-readiness call (the rules' tier-1 site call: is the car ready, are the papers
 * and keys there, who hands it over; a callback if nobody answers).
 */
export type ActionType = "question" | "change" | "pickup_readiness"

export type Decision = "acts alone" | "needs a yes" | "propose only"

export type PolicyRow = {
  id: PolicyRowId
  contact: string
  /** Who is contacted, in the Rules page's words when the prompt's wording is too technical. */
  shown?: string
  action: string
  decision: Decision
  /** The contact types the row covers. */
  contactTypes: ContactType[]
  actionType: ActionType
  /** What the agent does under this row, in one sentence (the Rules page). */
  agentDoes: string
  /** False for an engine-only row the reviewer never cites (not in its prompt or policy_row enum). */
  reviewer?: false
}

export const CONTACT_TYPES: ContactType[] = ["paying_customer", "customer_given_contact", "customer_owned_site", "third_party_site", "driver", "operator"]
export const ASK_ROLES: AskRole[] = ["site", "driver", "operator", "customer"]

export const CONTACT_TYPE_LABEL: Record<ContactType, string> = {
  paying_customer: "Paying customer",
  customer_given_contact: "Customer-given contact",
  customer_owned_site: "Customer-owned site",
  third_party_site: "Third-party site or seller",
  driver: "Driver",
  operator: "Operator",
}

export const POLICY: PolicyRow[] = [
  {
    id: "site-routine", contact: "Third-party site or seller's site (not the paying customer)", shown: "Third-party site or seller", action: "Routine question or call", decision: "acts alone",
    contactTypes: ["third_party_site"], actionType: "question",
    agentDoes: "Calls the site contact on the order, or else the site's pickup email. If neither exists, nothing happens and the order shows the contact as missing.",
  },
  {
    id: "driver-routine", contact: "Driver", action: "Routine question or call", decision: "acts alone",
    contactTypes: ["driver"], actionType: "question",
    agentDoes: "Calls the assigned driver.",
  },
  {
    id: "operator-question", contact: "Operator", action: "Clarifying question in the app", decision: "acts alone",
    contactTypes: ["operator"], actionType: "question",
    agentDoes: "Asks the operator in the app; the order waits in Needs action until the question is answered or dismissed.",
  },
  {
    id: "customer-side", contact: "Customer side: the paying customer, a contact the customer gave us (stated_by CUSTOMER_ORDER_INPUT), or a site the customer owns",
    shown: "Customer side: the paying customer, a contact the customer gave us, or a site the customer owns", action: "Any contact", decision: "propose only",
    contactTypes: ["paying_customer", "customer_given_contact", "customer_owned_site"], actionType: "question",
    agentDoes: "Never makes the contact (the one exception is the pickup-readiness call below). It drafts the script with the evidence; approving hands the contact to the operator, who records the answer.",
  },
  {
    id: "order-change", contact: "Anyone", action: "Order change from a call (new date, cost, booking, order update)", decision: "needs a yes",
    contactTypes: CONTACT_TYPES, actionType: "change",
    agentDoes: "Proposes the change; nothing is written to the order until an operator says yes.",
  },
  {
    // ADR 0001, amendment of 2026-10-24: the brief asks for pickup-readiness calls to the seller or pickup place.
    id: "pickup-readiness",
    contact: "The order's pickup place or pickup contact on the customer side: a site the customer owns, or a pickup contact the customer gave us (never the paying customer)",
    shown: "The pickup place or pickup contact on the customer side (never the paying customer)",
    action: "Pickup-readiness call: is the car ready, are the papers and keys there; call back if nobody answers", decision: "acts alone",
    contactTypes: ["customer_owned_site", "customer_given_contact"], actionType: "pickup_readiness", reviewer: false,
    agentDoes: "Calls the pickup contact on record with the standard pickup questions (car ready, papers and keys there), and calls back if nobody answers. Anything else for that contact stays propose only, and a change learned on the call still needs a yes.",
  },
]

/** The rows the reviewer knows and cites: its prompt and its policy_row enum. */
export const REVIEWER_POLICY: PolicyRow[] = POLICY.filter((row) => row.reviewer !== false)

export const POLICY_ROW_IDS: PolicyRowId[] = REVIEWER_POLICY.map((row) => row.id)

const CUSTOMER_SIDE = new Set<ContactType>(["paying_customer", "customer_given_contact", "customer_owned_site"])

export function isCustomerSide(type: ContactType): boolean {
  return CUSTOMER_SIDE.has(type)
}

/**
 * The policy row for doing `action` with a contact of this type. A pickup-readiness call
 * to a third-party site is that site's routine call (site-routine).
 */
export function policyFor(type: ContactType, action: ActionType): PolicyRow {
  if (action === "pickup_readiness" && type === "third_party_site") return policyRow("site-routine")
  const row = POLICY.find((candidate) => candidate.actionType === action && candidate.contactTypes.includes(type))
  if (!row) throw new Error(`No policy row covers a ${action} with a ${type}`)
  return row
}

export function policyRow(id: PolicyRowId): PolicyRow {
  const row = POLICY.find((candidate) => candidate.id === id)
  if (!row) throw new Error(`Unknown policy row ${id}`)
  return row
}

/** The policy row that governs asking a contact of this type a question. */
export function questionPolicyFor(type: ContactType): PolicyRowId {
  return policyFor(type, "question").id
}

export function renderPolicy(): string {
  return REVIEWER_POLICY.map((row) => `- ${row.id}: ${row.contact} | ${row.action} | ${row.decision}`).join("\n")
}
