// The Briefing (ticket 13): the operator's in-app inbox of scheduled digests and
// urgent pushes. Nothing is really sent.
//
// - Digests arrive at 09:00, 12:00 and 16:00 on the demo clock. Their facts (counts,
//   urgent orders, what changed) come from the engine's rule results with no model.
//   The prose around them is written by the model through placeholders
//   (`{{count.needs_action}}`, `{{order:CD-420437}}`); see `digest-prose.ts`.
// - Pushes are template-only and go out at once when an order turns urgent for a
//   reason it was not urgent for at the start, at most once per order per reason.
//   Ticket 14 sends handover pushes through the same `push` (reason "handover").
//
// - A lesson candidate (lib/engine/lessons.ts) brings "A new lesson needs your yes",
//   linking to its place on the Lessons page, once per lesson.
//
// Delivery is stored (cr_briefing_items) and at-most-once by item id, so a reset
// clears the inbox and the next delivery brings the 09:00 digest back.

import type { Group, UrgencyReason } from "./checks"
import { GROUPS } from "./checks"
import type { DigestProse } from "./digest-prose"
import type { EngineStore } from "./store"

export const DIGEST_SLOTS = ["09:00", "12:00", "16:00"] as const
export type DigestSlot = typeof DIGEST_SLOTS[number]

const SLOT_TITLE: Record<DigestSlot, string> = { "09:00": "Morning digest", "12:00": "Midday digest", "16:00": "Afternoon digest" }

export type DigestOrder = { orderId: string; reference: string }

export type DigestCounts = Record<Group, number> & {
  total: number
  urgent: number
  /** Orders with at least one check that could not be run (a weak gap). */
  couldnt_check: number
}

export type CountKey = keyof DigestCounts
export const COUNT_KEYS: CountKey[] = [...GROUPS, "total", "urgent", "couldnt_check"]

export type UrgentLine = DigestOrder & {
  group: Group
  reasons: { kind: UrgencyReason; text: string; at: string | null }[]
  /** The earliest urgent deadline, for `{{due:REF}}`. */
  dueAt: string | null
}

export type DigestFacts = {
  slot: DigestSlot
  at: string
  /** The previous digest's time; null for the first of the day. */
  since: string | null
  counts: DigestCounts
  /** Needs action by cause: a reviewer finding or the title of the rule that fired. */
  needsActionBy: { label: string; count: number }[]
  /** Urgent orders, most pressing first. */
  urgent: UrgentLine[]
  /** Every Needs action order, most pressing first, with its one-line reason. */
  needsAction: (DigestOrder & { reason: string; urgent: boolean })[]
  /** What changed since the previous digest; null for the first. */
  changes: {
    newNeedsAction: DigestOrder[]
    leftNeedsAction: DigestOrder[]
    cameDue: { title: string; orderId: string | null; reference: string | null; at: string }[]
  } | null
}

type ItemBase = {
  /** Stable: "digest:12:00", "push:<order id>:<reason>[:<key>]". */
  id: string
  /** Demo-clock time it arrived at. */
  at: string
  read: boolean
  /** Real time it was stored; lets a browser tell a re-delivery after reset from an old item. */
  deliveredAt: string
  title: string
}

export type DigestItem = ItemBase & { kind: "digest"; slot: DigestSlot; facts: DigestFacts; prose: DigestProse }

export type PushReason = UrgencyReason | "handover"

export type PushItem = ItemBase & {
  kind: "push"
  reason: PushReason
  orderId: string
  reference: string
  /** One line, template text. */
  text: string
  /** The deadline behind it, if any. */
  dueAt: string | null
}

export type LessonItem = ItemBase & {
  kind: "lesson"
  lessonId: string
  /** "reviewer" or "plain-words". */
  agent: string
  /** The lesson itself, one or two sentences. */
  text: string
  /** Where the operator decides: the lesson on the Lessons page. */
  href: string
}

export type BriefingItem = DigestItem | PushItem | LessonItem

export const LESSON_ITEM_TITLE = "A new lesson needs your yes"

export function lessonItemId(lessonId: string): string {
  return `lesson:${lessonId}`
}

export function lessonItem(lesson: { id: string; agent: string; text: string }, at: string, deliveredAt: string): LessonItem {
  return {
    id: lessonItemId(lesson.id), kind: "lesson", at, read: false, deliveredAt, title: LESSON_ITEM_TITLE,
    lessonId: lesson.id, agent: lesson.agent, text: lesson.text, href: `/lessons#lesson-${lesson.id}`,
  }
}

export type Briefing = {
  /** Newest first; only items that arrived at or before `now`. */
  items: BriefingItem[]
  unread: number
}

/** What a push says, before delivery. Ticket 14: `{ reason: "handover", key: <call id> }`. */
export type PushInput = {
  orderId: string
  reference: string
  reason: PushReason
  text: string
  at: string
  dueAt?: string | null
  /** Distinguishes several pushes of one reason on one order (e.g. one per handover); default none. */
  key?: string
}

export const PUSH_TITLE: Record<PushReason, (reference: string) => string> = {
  action_due: (reference) => `${reference}: action due`,
  promise_at_risk: (reference) => `${reference}: promise at risk`,
  pickup_unready: (reference) => `${reference}: pickup not ready`,
  handover: (reference) => `${reference}: handover from a call`,
}

/** The demo day's digest times (UTC, like the demo clock), as ISO. */
export function digestTimes(snapshotAt: string): { slot: DigestSlot; at: string }[] {
  const day = new Date(snapshotAt).toISOString().slice(0, 10)
  return DIGEST_SLOTS.map((slot) => ({ slot, at: new Date(`${day}T${slot}:00.000Z`).toISOString() }))
}

export function digestTitle(slot: DigestSlot): string {
  return SLOT_TITLE[slot]
}

export function pushId(input: Pick<PushInput, "orderId" | "reason" | "key">): string {
  return `push:${input.orderId}:${input.reason}${input.key ? `:${input.key}` : ""}`
}

export function pushItem(input: PushInput, deliveredAt: string): PushItem {
  return {
    id: pushId(input), kind: "push", at: input.at, read: false, deliveredAt,
    title: PUSH_TITLE[input.reason](input.reference),
    reason: input.reason, orderId: input.orderId, reference: input.reference, text: input.text, dueAt: input.dueAt ?? null,
  }
}

/** Sends a push unless one with the same order, reason and key went out already. True when sent. */
export async function sendPush(store: EngineStore, input: PushInput): Promise<boolean> {
  return store.addBriefing(pushItem(input, new Date().toISOString()))
}

/** The inbox as of `now`: newest first, then digests before pushes of the same time, then by id. */
export function briefingAsOf(items: BriefingItem[], now: string): Briefing {
  const visible = items.filter((item) => item.at <= now)
    .sort((a, b) => b.at.localeCompare(a.at) || (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind === "digest" ? -1 : b.kind === "digest" ? 1 : a.kind.localeCompare(b.kind)))
  return { items: visible, unread: visible.filter((item) => !item.read).length }
}

/** What the facts need from one order (a subset of the engine's OrderState). */
export type FactsOrder = {
  id: string
  reference: string
  group: Group
  reason: string
  urgency: { urgent: boolean; reasons: UrgentLine["reasons"]; dueAt: string | null }
  rules: { title: string; outcome: string; firstAction: string | null; strength: string }[]
  review: { status: string; findings: unknown[] }
  /** Ticket 07: what keeps a proposal open (`waitingOn`) decides whether it holds the order in Needs action. */
  proposals: { kind: string; status: string; waitingOn: "operator" | "agent" | null }[]
  /** Ticket 14: an open tier-3 handover ("handover") or a call nobody answered ("needs_person") holds the order too. */
  callLines?: { status: string }[]
}

const ref = (row: FactsOrder): DigestOrder => ({ orderId: row.id, reference: row.reference })

const URGENT_FIRST = (a: FactsOrder, b: FactsOrder) => Number(b.urgency.urgent) - Number(a.urgency.urgent)
  || (a.urgency.dueAt ?? "9").localeCompare(b.urgency.dueAt ?? "9") || a.reference.localeCompare(b.reference)

/**
 * The digest's facts, from the engine's orders at the digest time (and at the previous
 * digest, for "what changed"). No model is involved.
 */
export function digestFacts(input: {
  slot: DigestSlot
  at: string
  orders: FactsOrder[]
  previous: { at: string; orders: FactsOrder[] } | null
  cameDue: { title: string; orderId: string | null; reference: string | null; at: string }[]
}): DigestFacts {
  const { orders } = input
  const counts = Object.fromEntries(GROUPS.map((group) => [group, orders.filter((row) => row.group === group).length])) as DigestCounts
  counts.total = orders.length
  counts.urgent = orders.filter((row) => row.urgency.urgent).length
  counts.couldnt_check = orders.filter((row) => row.rules.some((rule) => rule.outcome === "unknown")).length

  const needs = orders.filter((row) => row.group === "needs_action").sort(URGENT_FIRST)
  const causes = new Map<string, number>()
  for (const row of needs) {
    const labels = new Set<string>()
    // Ticket 07: findings reach Needs action only as proposals waiting on the operator.
    for (const proposal of row.proposals) {
      if (proposal.waitingOn !== "operator") continue
      labels.add(proposal.status === "proposed" ? "Proposal waiting for a yes" : proposal.kind === "operator_question" ? "Question for the operator" : "Customer contact with the operator")
    }
    for (const line of row.callLines ?? []) {
      if (line.status === "handover") labels.add("Handover from a call")
      if (line.status === "needs_person") labels.add("Call needs a person")
    }
    for (const rule of row.rules) if (rule.outcome === "fail" && rule.firstAction === "show_person") labels.add(rule.title)
    if (!labels.size) labels.add("Other")
    for (const label of labels) causes.set(label, (causes.get(label) ?? 0) + 1)
  }

  let changes: DigestFacts["changes"] = null
  if (input.previous) {
    const before = new Set(input.previous.orders.filter((row) => row.group === "needs_action").map((row) => row.id))
    const now = new Set(needs.map((row) => row.id))
    changes = {
      newNeedsAction: needs.filter((row) => !before.has(row.id)).map(ref),
      leftNeedsAction: input.previous.orders.filter((row) => before.has(row.id) && !now.has(row.id)).sort((a, b) => a.reference.localeCompare(b.reference)).map(ref),
      cameDue: input.cameDue,
    }
  }

  return {
    slot: input.slot,
    at: input.at,
    since: input.previous?.at ?? null,
    counts,
    needsActionBy: [...causes].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    urgent: orders.filter((row) => row.urgency.urgent).sort(URGENT_FIRST).map((row) => ({
      ...ref(row), group: row.group, reasons: row.urgency.reasons,
      dueAt: row.urgency.reasons.map((reason) => reason.at).filter((at): at is string => !!at).sort()[0] ?? null,
    })),
    needsAction: needs.map((row) => ({ ...ref(row), reason: row.reason, urgent: row.urgency.urgent })),
    changes,
  }
}
