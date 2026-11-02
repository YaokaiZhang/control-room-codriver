// The reviewer layer of the engine (ticket 06): which orders go to the reviewer,
// what it found, and running it. The reviewer core lives in lib/reviewer; this
// module wires it to the engine's snapshot, rule results and grouping.
//
// - Orders whose records the rules can't read (conversations, messages, notes,
//   endpoint claims, inbox threads naming the order, open alerts, work items or
//   incidents) go to the reviewer ("records"); every other order is covered by the
//   one-time sweep ("sweep"). `run()` reviews both kinds; the seed sweep calls it.
// - Reviews read a stable time (`reviewAt`: the snapshot time, or the order's last
//   effect event), not the demo clock, so moving the clock never re-reviews. The
//   engine hands the layer an order's overlaid bundle with `replace` (ticket 09).
// - Results live in the review cache (cr_review_results in the app), keyed by the
//   case file's hash. Reading never calls the model; without a gateway, or when the
//   model fails, orders read "not reviewed yet".
// - Approved reviewer lessons (lib/reviewer/lessons.ts) are part of the key; when the
//   approved set changes, what the layer remembers of earlier reads is dropped.

import type { Bundle } from "@/lib/present/bundle"
import { createMemoryReviewCache, type ReviewCache } from "@/lib/reviewer/cache"
import type { CaseFile, PriorState, RuleResult as ReviewerRuleResult } from "@/lib/reviewer/case-file"
import type { ModelGateway } from "@/lib/reviewer/gateway"
import type { CaseRecord } from "@/lib/reviewer/records"
import { createReviewer, NOT_REVIEWED_YET, type Finding, type Reviewed, type ReviewResult } from "@/lib/reviewer/reviewer"
import { lessonsHash, type LessonFeed } from "@/lib/reviewer/lessons"
import type { ReviewSource } from "@/lib/reviewer/source"
import { createHash } from "node:crypto"
import type { RuleResult } from "./checks"

export type ReviewTrigger = "records" | "sweep"

/** A record a finding cites, with the field's full text so the quote can be highlighted in it. */
export type CitedRecord = {
  recordId: string
  /** "conflict": one of the records that disagree; "contact": the record that names who to ask. */
  role: "conflict" | "contact"
  /** The record's collection as the reviewer reads it (`message`, `order_endpoint_details`, ...); null if not in the case file. */
  kind: string | null
  field: string
  quote: string
  /** The cited field's text, or null when the record is not in the order's case file (e.g. another order's record a tool returned). */
  value: string | null
  at: string | null
  local: string | null
  statedBy: string | null
}

export type ReviewFinding = Omit<Finding, "conflict"> & {
  /** Stable per order, title and question: proposals (ticket 07) can point at it. */
  id: string
  cited: CitedRecord[]
}

export type OrderReview = {
  status: "reviewed" | "not_reviewed"
  /** Why the order goes to the reviewer: records the rules can't read, or the one-time sweep. */
  trigger: ReviewTrigger
  /** The unreadable records, e.g. "3 messages", "1 open alert". Empty for sweep orders. */
  triggers: string[]
  /** Records in the case file. */
  recordsRead: number
  summary: string | null
  findings: ReviewFinding[]
  /** Findings dropped by the evidence check. */
  dropped: number
  /** Every record id any finding cites, for highlighting on the order page. */
  highlights: string[]
  /** "not reviewed yet: ..." when not reviewed, else null. */
  reason: string | null
  /** The model cost of this order's review (USD), as recorded when it ran; 0 when not reviewed. */
  cost: number
  model: string | null
  /** Real time the model run happened. */
  reviewedAt: string | null
  /** The time the reviewer read the order as of (stable: the snapshot time). */
  reviewAt: string
  /** The agent run that produced the review (lib/reviewer/trace.ts); null when not reviewed, untraced, or cached before tracing. */
  runId: string | null
}

export type ReviewTotals = {
  /** False when no model gateway is configured (no ANTHROPIC_API_KEY). */
  canReview: boolean
  reviewed: number
  notReviewed: number
  findings: number
  /** Summed recorded model cost of every reviewed order (USD). */
  cost: number
}

export type ReviewOptions = {
  /** null or absent: no model key, every order "not reviewed yet". */
  gateway?: ModelGateway | null
  cache?: ReviewCache
  /** `support_inbox_messages` rows for the reviewer's inbox tool. */
  inboxMessages?: ReviewSource["inboxMessages"]
  /** Model calls in flight during a run. Default 4. */
  concurrency?: number
  /** A run stops starting new reviews after this many model failures in a row. Default 3. */
  maxConsecutiveFailures?: number
  model?: string
  /** The approved reviewer lessons (lib/engine/lessons.ts); absent: none. */
  lessons?: LessonFeed
}

/**
 * What a review reads besides the order's records: the rule results (as of the
 * review time) and the control room's prior state (operator instructions, ticket 07;
 * answers and call results come with 08 and 10). Prior state is part of the case
 * file, so a new instruction makes the order's review miss until it is re-run.
 */
export type ReviewInputs = {
  rules: (bundle: Bundle) => RuleResult[]
  prior?: (bundle: Bundle) => PriorState | undefined
}

export type ReviewLayer = {
  canReview: boolean
  /** Every order's review as of now (cache only, no model call). */
  read(inputs: ReviewInputs): Promise<Map<string, OrderReview>>
  /** Reviews the orders not reviewed yet (all, or `orderIds`), records-triggered first. */
  run(inputs: ReviewInputs, orderIds?: string[]): Promise<void>
  /** Drops what is known about an order's review (after its records change). */
  forget(orderId: string): void
  /**
   * The order as the reviewer now reads it (the snapshot with its effect events
   * applied) and the time it is read as of (its last effect event). Forgets its review.
   */
  replace(bundle: Bundle, reviewAt: string): void
  /** The order's case file as its review reads it now (a mistake keeps it, to become an eval case). */
  caseFile(orderId: string, inputs: ReviewInputs): CaseFile
}

const OPEN_ALERT = (status: string) => status !== "RESOLVED"

function count(n: number, noun: string, nouns = `${noun}s`): string {
  return `${n} ${n === 1 ? noun : nouns}`
}

/** The records the rules can't read. Empty means the order is left to the sweep. */
export function unreadableRecords(bundle: Bundle): string[] {
  const related = (name: string) => bundle.related[name] ?? []
  const openWork = related("work_items").filter((row) => !row.details.closed_at && row.details.status !== "DONE" && row.details.status !== "CLOSED").length
  const openIncidents = related("incidents").filter((row) => !row.details.resolved_at).length
  const openAlerts = bundle.alerts.filter((alert) => OPEN_ALERT(alert.status)).length
  const parts: [number, string][] = [
    [bundle.conversations.length, count(bundle.conversations.length, "conversation")],
    [bundle.messages.length, count(bundle.messages.length, "message")],
    [related("order_notes").length, count(related("order_notes").length, "note")],
    [related("endpoint_claims").length, count(related("endpoint_claims").length, "endpoint claim")],
    [bundle.inboxThreads.length, count(bundle.inboxThreads.length, "inbox thread naming the order", "inbox threads naming the order")],
    [openAlerts, count(openAlerts, "open alert")],
    [openWork, count(openWork, "open work item")],
    [openIncidents, count(openIncidents, "open incident")],
  ]
  return parts.filter(([n]) => n > 0).map(([, text]) => text)
}

/** Ticket 03's rule results in the reviewer's shape. */
export function toReviewerRules(rules: RuleResult[]): ReviewerRuleResult[] {
  return rules.map((row) => ({
    rule: row.id,
    status: row.outcome === "pass" ? "passed" : row.outcome === "fail" ? "failed" : "couldnt_check",
    summary: row.detail,
    recordIds: row.sources.map((source) => source.id),
  }))
}

function leaves(value: unknown, out: string[] = []): string[] {
  if (value === null || value === undefined) return out
  if (Array.isArray(value)) for (const item of value) leaves(item, out)
  else if (typeof value === "object") for (const item of Object.values(value as Record<string, unknown>)) leaves(item, out)
  else out.push(String(value))
  return out
}

function fieldText(record: CaseRecord, field: string, quote: string): string | null {
  if (!field) {
    // No field named (a contact quote): the first value that holds the quote.
    const wanted = quote.trim().toLowerCase()
    return leaves(record.fields).find((text) => text.toLowerCase().includes(wanted)) ?? null
  }
  let value: unknown = record.fields
  for (const part of field.split(".")) {
    if (!value || typeof value !== "object") { value = undefined; break }
    value = (value as Record<string, unknown>)[part]
  }
  if (value === undefined || value === null) return null
  return typeof value === "string" ? value : JSON.stringify(value)
}

function cite(records: Map<string, CaseRecord>, recordId: string, role: CitedRecord["role"], field: string, quote: string): CitedRecord {
  const record = records.get(recordId)
  return {
    recordId, role, field, quote,
    kind: record?.kind ?? null,
    value: record ? fieldText(record, field, quote) : null,
    at: record?.at ?? null,
    local: record?.local ?? null,
    statedBy: record?.statedBy ?? null,
  }
}

function findingId(orderId: string, finding: Finding): string {
  return `f-${createHash("sha256").update(`${orderId}\n${finding.title}\n${finding.question}`).digest("hex").slice(0, 12)}`
}

function failedModel(result: ReviewResult): boolean {
  return result.status === "not_reviewed" && /model call failed/.test(result.reason)
}

/** How long a "not reviewed yet" read is trusted before the cache is asked again (another process may sweep). */
const MISS_TTL_MS = 5_000

export function createReviewLayer(bundles: Bundle[], snapshotAt: string, options: ReviewOptions = {}): ReviewLayer {
  const gateway = options.gateway ?? null
  const cache = options.cache ?? createMemoryReviewCache()
  // The layer's own list: `replace` swaps in an order's overlaid bundle (tools read other orders from it too).
  const current = [...bundles]
  const source: ReviewSource = { snapshot: { snapshotAt, bundles: current }, inboxMessages: options.inboxMessages ?? [] }
  const reviewer = createReviewer({ gateway, source, cache, model: options.model, lessons: options.lessons })
  // Reads never call the model: the same cache, no gateway.
  const reader = createReviewer({ gateway: null, source, cache, model: options.model, lessons: options.lessons })
  const concurrency = Math.max(1, options.concurrency ?? 4)
  const maxFailures = Math.max(1, options.maxConsecutiveFailures ?? 3)
  const byId = new Map(bundles.map((bundle) => [bundle.order.id, bundle]))
  const readAt = new Map<string, string>()
  const triggers = new Map(bundles.map((bundle) => [bundle.order.id, unreadableRecords(bundle)]))

  const hits = new Map<string, Reviewed>()
  const misses = new Map<string, { at: number; recordsRead: number }>()
  /** Why the last run could not review an order (model failure, skipped). */
  const failures = new Map<string, string>()
  const caseRecords = new Map<string, Map<string, CaseRecord>>()
  let lessonsSeen = ""

  /** A lesson approved or retired since the last read: every remembered review may be stale. */
  async function checkLessons(): Promise<void> {
    if (!options.lessons) return
    const now = lessonsHash(await options.lessons())
    if (now === lessonsSeen) return
    lessonsSeen = now
    hits.clear()
    misses.clear()
  }

  function reviewAt(bundle: Bundle): string {
    return readAt.get(bundle.order.id) ?? snapshotAt
  }

  function inputFor(bundle: Bundle, inputs: ReviewInputs) {
    const prior = inputs.prior?.(bundle)
    return { now: reviewAt(bundle), rules: toReviewerRules(inputs.rules(bundle)), ...(prior ? { prior } : {}) }
  }

  function recordsOf(bundle: Bundle, inputs: ReviewInputs): Map<string, CaseRecord> {
    let records = caseRecords.get(bundle.order.id)
    if (!records) {
      records = new Map(reader.caseFile(bundle.order.id, inputFor(bundle, inputs)).records.map((record) => [record.id, record]))
      caseRecords.set(bundle.order.id, records)
    }
    return records
  }

  async function lookup(bundle: Bundle, inputs: ReviewInputs): Promise<Reviewed | { recordsRead: number }> {
    const id = bundle.order.id
    const hit = hits.get(id)
    if (hit) return hit
    const miss = misses.get(id)
    if (miss && Date.now() - miss.at < MISS_TTL_MS) return miss
    const result = await reader.review(id, inputFor(bundle, inputs))
    if (result.status === "reviewed") {
      hits.set(id, result)
      misses.delete(id)
      return result
    }
    const fresh = { at: Date.now(), recordsRead: result.recordsRead }
    misses.set(id, fresh)
    return fresh
  }

  function toOrderReview(bundle: Bundle, found: Reviewed | { recordsRead: number }, inputs: ReviewInputs): OrderReview {
    const id = bundle.order.id
    const list = triggers.get(id) ?? []
    const base = { trigger: (list.length ? "records" : "sweep") as ReviewTrigger, triggers: list, reviewAt: reviewAt(bundle) }
    if (!("status" in found)) {
      const cause = failures.get(id) ?? (gateway ? null : "no model key is configured")
      return {
        ...base, status: "not_reviewed", recordsRead: found.recordsRead, summary: null, findings: [], dropped: 0, highlights: [],
        reason: cause ? `${NOT_REVIEWED_YET}: ${cause}` : NOT_REVIEWED_YET, cost: 0, model: null, reviewedAt: null, runId: null,
      }
    }
    const records = recordsOf(bundle, inputs)
    const findings: ReviewFinding[] = found.findings.map((finding) => {
      const { conflict, ...rest } = finding
      return {
        ...rest,
        id: findingId(id, finding),
        cited: [
          ...conflict.map((item) => cite(records, item.recordId, "conflict", item.field, item.quote)),
          cite(records, finding.ask.contactRecordId, "contact", "", finding.ask.contactQuote),
        ],
      }
    })
    return {
      ...base, status: "reviewed", recordsRead: found.recordsRead, summary: found.summary || null, findings,
      dropped: found.dropped.length,
      highlights: [...new Set(findings.flatMap((finding) => finding.cited.map((cited) => cited.recordId)))],
      reason: null, cost: found.usage.cost, model: found.model, reviewedAt: found.reviewedAt, runId: found.runId ?? null,
    }
  }

  async function read(inputs: ReviewInputs): Promise<Map<string, OrderReview>> {
    const out = new Map<string, OrderReview>()
    await checkLessons()
    await Promise.all(current.map(async (bundle) => {
      out.set(bundle.order.id, toOrderReview(bundle, await lookup(bundle, inputs), inputs))
    }))
    return out
  }

  async function run(inputs: ReviewInputs, orderIds?: string[]): Promise<void> {
    const chosen = orderIds ? orderIds.map((id) => byId.get(id)).filter((bundle): bundle is Bundle => Boolean(bundle)) : current
    await checkLessons()
    misses.clear()
    const pending: Bundle[] = []
    for (const bundle of chosen) if (!("status" in await lookup(bundle, inputs))) pending.push(bundle)
    if (!gateway) return
    pending.sort((a, b) => Number((triggers.get(b.order.id) ?? []).length > 0) - Number((triggers.get(a.order.id) ?? []).length > 0))

    let failuresInRow = 0
    let stopped: string | null = null
    let next = 0
    async function worker(): Promise<void> {
      while (next < pending.length) {
        const bundle = pending[next++]
        const id = bundle.order.id
        if (stopped) { failures.set(id, `skipped after ${maxFailures} model failures in a row (last: ${stopped})`); continue }
        const result = await reviewer.review(id, inputFor(bundle, inputs))
        if (result.status === "reviewed") {
          failuresInRow = 0
          hits.set(id, result)
          misses.delete(id)
          failures.delete(id)
          continue
        }
        failures.set(id, result.reason.replace(`${NOT_REVIEWED_YET}: `, ""))
        if (failedModel(result)) {
          failuresInRow += 1
          if (failuresInRow >= maxFailures) stopped = result.reason.replace(`${NOT_REVIEWED_YET}: `, "")
        } else {
          failuresInRow = 0
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker))
    misses.clear()
  }

  function forget(orderId: string): void {
    hits.delete(orderId)
    misses.delete(orderId)
    failures.delete(orderId)
    caseRecords.delete(orderId)
  }

  function replace(bundle: Bundle, at: string): void {
    const id = bundle.order.id
    const index = current.findIndex((row) => row.order.id === id)
    if (index < 0) throw new Error(`Unknown order ${id}`)
    current[index] = bundle
    byId.set(id, bundle)
    if (at === snapshotAt) readAt.delete(id)
    else readAt.set(id, at)
    forget(id)
  }

  function caseFile(orderId: string, inputs: ReviewInputs): CaseFile {
    const bundle = byId.get(orderId)
    if (!bundle) throw new Error(`Unknown order ${orderId}`)
    return reader.caseFile(orderId, inputFor(bundle, inputs))
  }

  return { canReview: gateway !== null, read, run, forget, replace, caseFile }
}

export function reviewTotals(canReview: boolean, reviews: OrderReview[]): ReviewTotals {
  const reviewed = reviews.filter((review) => review.status === "reviewed")
  return {
    canReview,
    reviewed: reviewed.length,
    notReviewed: reviews.length - reviewed.length,
    findings: reviewed.reduce((sum, review) => sum + review.findings.length, 0),
    cost: Math.round(reviewed.reduce((sum, review) => sum + review.cost, 0) * 1e6) / 1e6,
  }
}
