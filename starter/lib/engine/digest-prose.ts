// The digest's prose: a short opener and one suggested first move around the
// digest facts. The model (low effort, no tools, facts only) writes it with
// placeholders, and the server fills in every number and order reference:
//
//   {{count.<key>}}   a count from the facts (needs_action, in_progress, normal, done, total, urgent, couldnt_check);
//                     "urgent" here is the urgent Blocked orders, as the Urgent tile counts them
//   {{order:CD-…}}    a link to an order named in the facts
//   {{due:CD-…}}      that urgent order's earliest deadline, as "10:00" (or "22 Oct 09:00")
//
// Any digit the model typed itself, any unknown placeholder or a malformed reply is
// rejected, and so is a reply later than `timeoutMs` (about 5 s): the digest then
// carries template text. Model prose is cached by a hash of the facts.

import { createHash } from "node:crypto"
import type { Effort, ModelGateway } from "@/lib/reviewer/gateway"
import { DEFAULT_REVIEWER_MODEL } from "@/lib/reviewer/reviewer"
import { COUNT_KEYS, type CountKey, type DigestFacts, type DigestOrder } from "./briefing"
import { dayKey, fmtClock, fmtDateTime } from "@/lib/present/time"

/** A run of text or a link to an order. */
export type ProseSegment = { text: string } | { order: DigestOrder }

export type DigestProse = {
  opener: ProseSegment[]
  firstMove: ProseSegment[]
  /** Who wrote it: the model, or the template (no key, too slow, failed or rejected). */
  source: "model" | "template"
  /** Why the template was used; null for model prose. */
  note: string | null
  /** What the model call cost (0 for template text and cache hits). */
  cost: number
  cached: boolean
}

/** What the model wrote, as validated placeholder text. Cached by facts hash. */
export type CachedProse = { opener: string; firstMove: string; model: string; cost: number }

export interface ProseCache {
  get(key: string): Promise<CachedProse | null>
  put(key: string, prose: CachedProse): Promise<void>
}

export function createMemoryProseCache(): ProseCache {
  const entries = new Map<string, CachedProse>()
  return {
    async get(key) { return entries.has(key) ? structuredClone(entries.get(key)!) : null },
    async put(key, prose) { entries.set(key, structuredClone(prose)) },
  }
}

export type ProseOptions = {
  gateway?: ModelGateway | null
  cache?: ProseCache
  model?: string
  effort?: Effort
  /** How long to wait for the model before sending template text. */
  timeoutMs?: number
}

export const PROSE_VERSION = "digest-prose-v2"
export const DIGEST_TIMEOUT_MS = 5_000

// ── Formatting ────────────────────────────────────────────────────────────

/** "10:00" on the digest's day, "22 Oct 09:00" on another, in the control room's zone like the demo clock. */
export function fmtDue(at: string, digestAt: string): string {
  if (dayKey(at) === dayKey(digestAt)) return fmtClock(at)
  return fmtDateTime(at, null, false)
}

/** "A", "A and B", "A, B and C" as segments. */
function listOf(orders: DigestOrder[]): ProseSegment[] {
  const out: ProseSegment[] = []
  orders.forEach((order, index) => {
    if (index > 0) out.push({ text: index === orders.length - 1 ? " and " : ", " })
    out.push({ order })
  })
  return out
}

/** Joins adjacent text runs. */
function tidy(segments: ProseSegment[]): ProseSegment[] {
  const out: ProseSegment[] = []
  for (const segment of segments) {
    const last = out.at(-1)
    if ("text" in segment && last && "text" in last) out[out.length - 1] = { text: last.text + segment.text }
    else if (!("text" in segment) || segment.text) out.push(segment)
  }
  return out
}

const GREETING: Record<DigestFacts["slot"], string> = { "09:00": "Good morning.", "12:00": "Midday update.", "16:00": "Afternoon update." }

/** "Overdue work item: Ask the receiver for X; do Y." -> "ask the receiver for X (overdue)". */
export function moveText(text: string): string {
  const work = /^(Overdue|Due) work item: ([^]*)$/.exec(text.trim())
  const body = (work ? work[2] : text).split(/;|(?<=[.])\s/)[0].trim().replace(/[.]$/, "")
  const lowered = /^[A-Z][a-z]/.test(body) ? body[0].toLowerCase() + body.slice(1) : body
  return work?.[1] === "Overdue" ? `${lowered} (overdue)` : lowered
}

/**
 * The template prose: always correct, written from the facts by code. The digest's
 * count tiles already show the group counts and its change list shows what changed, so
 * the opener only says how many Blocked orders are urgent and which come first.
 * Urgency ranks Blocked orders; an urgent order the agent is already working on is not
 * the operator's to start with.
 */
export function templateProse(facts: DigestFacts, note: string): DigestProse {
  const blocked = facts.counts.needs_action
  const blockedUrgent = urgentBlocked(facts)
  const urgent = blockedUrgent.length
  const opener: ProseSegment[] = [{ text: `${GREETING[facts.slot]} ` }]
  if (!blocked) {
    opener.push({ text: "Nothing is blocked." })
  } else if (!urgent) {
    opener.push({ text: blocked === 1 ? "The blocked order is not urgent." : `None of the ${blocked} blocked orders is urgent.` })
  } else {
    const top = blockedUrgent.slice(0, 3)
    const head = urgent === blocked
      ? blocked === 1 ? "The blocked order is urgent" : `All ${blocked} blocked orders are urgent`
      : `${urgent} of the ${blocked} blocked orders ${urgent === 1 ? "is" : "are"} urgent`
    opener.push({ text: `${head}${urgent > top.length ? "; the most pressing are " : ": "}` }, ...listOf(top), { text: "." })
  }
  const first = blockedUrgent[0]
  const firstNeed = facts.needsAction[0]
  const firstMove: ProseSegment[] = first
    ? [{ text: "Start with " }, { order: first }, { text: `: ${first.reasons[0] ? moveText(first.reasons[0].text) : "it is urgent"}.` }]
    : firstNeed
      ? [{ text: "Start with " }, { order: firstNeed }, { text: `: ${moveText(firstNeed.reason)}.` }]
      : [{ text: "Nothing needs a decision; the agent is working through In progress." }]
  return { opener: tidy(opener), firstMove: tidy(firstMove), source: "template", note, cost: 0, cached: false }
}

// ── Placeholders ──────────────────────────────────────────────────────────

const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g

// Counts spelled out would dodge the digit check. ("one" is left out: "no one", "one of".)
const NUMBER_WORDS = /\b(zero|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|dozen|half|both|single|pair|couple)\b/i

export class ProseRejected extends Error {}

/** Fills a placeholder text from the facts, or throws ProseRejected. */
export function fillProse(text: string, facts: DigestFacts): ProseSegment[] {
  const orders = new Map<string, DigestOrder>()
  for (const row of [...facts.urgent, ...facts.needsAction, ...(facts.changes?.newNeedsAction ?? []), ...(facts.changes?.leftNeedsAction ?? [])]) {
    orders.set(row.reference, { orderId: row.orderId, reference: row.reference })
  }
  for (const row of facts.changes?.cameDue ?? []) if (row.orderId && row.reference) orders.set(row.reference, { orderId: row.orderId, reference: row.reference })
  const urgentDue = new Map(facts.urgent.map((row) => [row.reference, row.dueAt]))

  const bare = text.replace(PLACEHOLDER, " ")
  if (/\d/.test(bare)) throw new ProseRejected("the model typed a digit")
  if (NUMBER_WORDS.test(bare)) throw new ProseRejected("the model wrote a number in words")
  if (/[{}]/.test(bare)) throw new ProseRejected("a malformed placeholder")

  const segments: ProseSegment[] = []
  let at = 0
  for (const match of text.matchAll(PLACEHOLDER)) {
    segments.push({ text: text.slice(at, match.index) })
    at = match.index + match[0].length
    const token = match[1]
    const count = /^count\.(\w+)$/.exec(token)
    const order = /^order:\s*(\S+)$/.exec(token)
    const due = /^due:\s*(\S+)$/.exec(token)
    if (count && (COUNT_KEYS as string[]).includes(count[1])) segments.push({ text: String(proseCounts(facts)[count[1] as CountKey]) })
    else if (order && orders.has(order[1])) segments.push({ order: orders.get(order[1])! })
    else if (due && urgentDue.get(due[1])) segments.push({ text: fmtDue(urgentDue.get(due[1])!, facts.at) })
    else throw new ProseRejected(`an unknown placeholder {{${token}}}`)
  }
  segments.push({ text: text.slice(at) })
  return tidy(segments)
}

/**
 * The counts the prose may use. Urgency ranks Blocked orders, and the Urgent tile counts
 * urgent Blocked orders only, so "urgent" in the prose means the same: an urgent order the
 * agent is already working on is not the operator's to start with.
 */
function proseCounts(facts: DigestFacts): DigestFacts["counts"] {
  return { ...facts.counts, urgent: urgentBlocked(facts).length }
}

const urgentBlocked = (facts: DigestFacts) => facts.urgent.filter((row) => row.group === "needs_action")

// ── The model pass ────────────────────────────────────────────────────────

const SYSTEM = `You write the short prose of an operations digest for a car-delivery control room. You receive digest facts as JSON: counts per group, the urgent Blocked orders with their reasons, the orders with a problem, and what changed since the last digest. "Urgent" always means urgent and Blocked (needs_action): count.urgent counts exactly the orders in "urgent", and orders the agent is already handling are not in it.

Write two things:
- "opener": two or three sentences. Do not restate the group counts (the digest shows them as tiles); say how many Blocked orders are urgent ({{count.urgent}} of {{count.needs_action}}) and which come first. Order the urgent items by what to do first and group similar cases (for example several pickups missing a release).
- "firstMove": one sentence suggesting the operator's first move.

Rules:
- Never type a digit. Every number, time and order reference goes through a placeholder:
  {{count.KEY}} for a count, KEY one of: ${COUNT_KEYS.join(", ")};
  {{order:REFERENCE}} for an order, REFERENCE exactly as in the facts (e.g. {{order:CD-420437}});
  {{due:REFERENCE}} for an urgent order's earliest deadline.
- Never write a number, time, date or amount in words either (no "twenty", "both", "a couple"): use a placeholder or leave it out.
- Keep it short: the opener at most sixty words, the first move at most thirty.
- Use only orders that appear in the facts. Plain, calm English for an operator; no headings, no lists, no markdown.

Reply with only a JSON object: {"opener": "...", "firstMove": "..."}`

/** The facts as the model reads them: no ids, reasons cut short. */
function factsForModel(facts: DigestFacts) {
  return {
    digest: facts.slot,
    counts: proseCounts(facts),
    needsActionByCause: facts.needsActionBy,
    urgent: urgentBlocked(facts).slice(0, 12).map((row) => ({ reference: row.reference, group: row.group, reasons: row.reasons.map((reason) => reason.text.slice(0, 160)) })),
    needsAction: facts.needsAction.slice(0, 12).map((row) => ({ reference: row.reference, urgent: row.urgent, reason: row.reason.slice(0, 200) })),
    changes: facts.changes && {
      joinedNeedsAction: facts.changes.newNeedsAction.map((row) => row.reference),
      leftNeedsAction: facts.changes.leftNeedsAction.map((row) => row.reference),
      cameDue: facts.changes.cameDue.map((row) => `${row.title}${row.reference ? ` on ${row.reference}` : ""}`),
    },
  }
}

export function proseKey(facts: DigestFacts, model: string): string {
  return createHash("sha256").update(`${PROSE_VERSION}\n${model}\n${JSON.stringify(facts)}`).digest("hex")
}

function parseReply(content: string | null): { opener: string; firstMove: string } {
  const text = (content ?? "").trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1))
  } catch {
    throw new ProseRejected("the reply was not JSON")
  }
  const { opener, firstMove } = (parsed ?? {}) as Record<string, unknown>
  if (typeof opener !== "string" || typeof firstMove !== "string" || !opener.trim() || !firstMove.trim()) throw new ProseRejected("the reply missed the opener or first move")
  if (opener.length > 900 || firstMove.length > 400) throw new ProseRejected("the reply was too long")
  return { opener: opener.trim(), firstMove: firstMove.trim() }
}

function fromCached(prose: CachedProse, facts: DigestFacts, cached: boolean): DigestProse {
  return { opener: fillProse(prose.opener, facts), firstMove: fillProse(prose.firstMove, facts), source: "model", note: null, cost: cached ? 0 : prose.cost, cached }
}

/**
 * The digest prose: cached model prose, else a fresh model call within `timeoutMs`,
 * else template text with the reason. Never throws.
 */
export async function writeProse(facts: DigestFacts, options: ProseOptions = {}): Promise<DigestProse> {
  const { gateway, cache } = options
  if (!gateway) return templateProse(facts, "Template text: no model key is set.")
  const model = options.model ?? process.env.REVIEWER_MODEL ?? DEFAULT_REVIEWER_MODEL
  const key = proseKey(facts, model)
  try {
    const hit = await cache?.get(key)
    if (hit) return fromCached(hit, facts, true)
  } catch {
    // A cache that cannot be read is a miss.
  }
  const call = (async () => {
    const response = await gateway.chat({
      job: "digest", subject: `digest-${facts.slot}`, model, effort: options.effort ?? "low", maxTokens: 1200,
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: JSON.stringify(factsForModel(facts)) }],
    })
    const reply = parseReply(response.message.content)
    // Validate before caching: fillProse throws on a typed digit or an unknown placeholder.
    fillProse(reply.opener, facts)
    fillProse(reply.firstMove, facts)
    const prose: CachedProse = { ...reply, model: response.model || model, cost: response.usage.cost }
    await cache?.put(key, prose).catch(() => {})
    return prose
  })()
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<"late">((resolve) => { timer = setTimeout(() => resolve("late"), options.timeoutMs ?? DIGEST_TIMEOUT_MS) })
  try {
    // A late reply still lands in the cache, for the next delivery of the same facts.
    const result = await Promise.race([call, late])
    if (result === "late") {
      call.catch(() => {})
      return templateProse(facts, "Template text: the model was too slow.")
    }
    return fromCached(result, facts, false)
  } catch (error) {
    const reason = error instanceof ProseRejected ? `the model's text was rejected (${error.message})` : "the model call failed"
    return templateProse(facts, `Template text: ${reason}.`)
  } finally {
    clearTimeout(timer)
  }
}
