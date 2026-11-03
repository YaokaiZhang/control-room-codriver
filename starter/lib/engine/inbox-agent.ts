// The inbox agent: suggests what to do with a support inbox thread. It drafts a reply to
// the sender, and, when the thread is linked to orders, picks the steps on those orders
// that answer the thread (from the steps the order's situation card offers already, so
// every suggestion is an action the app can take). The operator edits and sends the
// reply, or takes a step; the agent sends and changes nothing itself.
//
// A model writes the suggestion from the thread and the linked orders' state; its reply
// is validated (JSON, known steps, no number the input does not hold) and cached, keyed
// by prompt version, model and input. Without a model, or when the reply is rejected or
// late, a template suggestion stands in, with the reason. Never throws.

import { createHash } from "node:crypto"
import type { Step } from "@/lib/present/situation"
import type { Effort, ModelGateway } from "@/lib/reviewer/gateway"
import { DEFAULT_REVIEWER_MODEL } from "@/lib/reviewer/reviewer"
import type { Group } from "./checks"

export const SUGGEST_VERSION = "inbox-suggest-v1"
const SUGGEST_TIMEOUT_MS = 20_000
const MAX_PICKS = 3

/** One order linked to the thread, as the agent reads it. `steps` are what its situation card offers. */
export type ThreadOrder = {
  orderId: string
  reference: string
  status: string
  group: Group
  /** The engine's one-line reason for the group. */
  reason: string
  car: string | null
  from: string
  to: string
  pickupWindow: { start: string; end: string } | null
  deliveryWindow: { start: string; end: string } | null
  /** The situation card: what is wrong (or what the agent is doing), in words. */
  headline: string | null
  body: string | null
  steps: Step[]
}

export type SuggestInput = {
  now: string
  thread: {
    id: string
    category: string
    channel: string
    linkState: string
    waitingOn: string | null
    basis: string | null
    sender: { name: string; role: string } | null
  }
  /** Oldest first. `internal` notes are colleagues' guidance, never shown to the sender. */
  messages: { from: "sender" | "support" | "internal"; at: string; body: string; language: string | null }[]
  /** The linked orders; empty for a thread not linked yet. */
  orders: ThreadOrder[]
}

/** The steps suggested on one linked order, the agent's picks first. */
export type OrderSuggestion = {
  orderId: string
  reference: string
  headline: string
  /** Why these steps answer the thread; null when the agent gave no reason. */
  why: string | null
  steps: Step[]
}

export type InboxSuggestion = {
  /** The draft reply to the sender. */
  reply: string
  /** One sentence for the operator: what the thread needs. */
  note: string | null
  orders: OrderSuggestion[]
  source: "model" | "template"
  model: string | null
  cost: number
  cached: boolean
  /** Why the template stands in; null for model text. */
  fallback: string | null
}

type Picked = { reply: string; note: string | null; picks: { order: number; step: number; why: string | null }[] }

export type CachedSuggestion = Picked & { model: string; cost: number }
export interface SuggestionCache {
  get(key: string): Promise<CachedSuggestion | null>
  put(key: string, suggestion: CachedSuggestion): Promise<void>
}

export function createMemorySuggestionCache(): SuggestionCache {
  const entries = new Map<string, CachedSuggestion>()
  return {
    async get(key) { return entries.has(key) ? structuredClone(entries.get(key)!) : null },
    async put(key, suggestion) { entries.set(key, structuredClone(suggestion)) },
  }
}

export type SuggestOptions = {
  gateway?: ModelGateway | null
  cache?: SuggestionCache
  /** Default: INBOX_MODEL, then REVIEWER_MODEL, then the reviewer's default. */
  model?: string
  effort?: Effort
  timeoutMs?: number
}

// ── Template ─────────────────────────────────────────────────────────────────

/** Drivers by first name; a company or an unknown sender by "Hello". */
const GREETING = (input: SuggestInput) => input.thread.sender?.role === "driver" ? `Hello ${input.thread.sender.name.split(/[ ,]/)[0]},` : "Hello,"
const SIGN_OFF = "Best regards,\nSupport desk"

function templateReply(input: SuggestInput): string {
  const { thread, orders } = input
  const lines: string[] = []
  if (orders.length) {
    const refs = orders.map((order) => order.reference).join(" and ")
    const open = orders.filter((order) => order.group === "needs_action" || order.group === "in_progress")
    if (open.length) lines.push(`Thank you for your message about ${refs}. We are looking into it now and will update you here as soon as we know more.`)
    else if (orders.every((order) => order.group === "done")) lines.push(`Thank you for your message about ${refs}. The order is complete on our side; tell us if anything is still missing.`)
    else lines.push(`Thank you for your message about ${refs}. The order is on track, and we will update you here if anything changes.`)
  } else if (thread.linkState === "PENDING_IDENTITY") {
    lines.push("Thank you for your message. I cannot match that reference to your account. Please send the order reference from your own booking confirmation, and we will check it right away.")
  } else if (thread.linkState === "NO_ORDER_REQUIRED" || thread.category === "general_policy") {
    lines.push("Thank you for your question. I am checking the current guidance and will answer here shortly.")
  } else {
    lines.push("Thank you for your message. To be sure we look at the right job, please send the order reference (it starts with CD-) and, if you have it, the car's registration plate.")
  }
  return `${GREETING(input)}\n\n${lines.join(" ")}\n\n${SIGN_OFF}`
}

/** No note when the thread has linked orders: their cards, shown right below, already say it. */
function templateNote(input: SuggestInput): string | null {
  if (input.orders.length) return null
  if (input.thread.linkState === "NO_ORDER_REQUIRED") return "No order is needed: answer the question as general guidance."
  return "Not linked to an order yet: ask for the reference, or link the order once you know it."
}

/** The template suggestion: fixed wording, each order's own steps in the card's order. */
export function templateSuggestion(input: SuggestInput, fallback: string): InboxSuggestion {
  return {
    reply: templateReply(input), note: templateNote(input), orders: ordersFrom(input, []),
    source: "template", model: null, cost: 0, cached: false, fallback,
  }
}

function ordersFrom(input: SuggestInput, picks: Picked["picks"]): OrderSuggestion[] {
  return input.orders.map((order, index) => {
    const mine = picks.filter((pick) => pick.order === index)
    const first = mine.map((pick) => order.steps[pick.step])
    return {
      orderId: order.orderId, reference: order.reference, headline: order.headline ?? order.reason,
      why: mine.find((pick) => pick.why)?.why ?? null,
      steps: [...first, ...order.steps.filter((step) => !first.includes(step))],
    }
  })
}

// ── Model ────────────────────────────────────────────────────────────────────

const SYSTEM = `You are the support agent of a car-delivery company. An operator reads a thread from the support inbox (customers, drivers, sites) and wants your suggestion: a reply they can send, and, when the thread is linked to orders, which steps on those orders answer it.

You receive JSON: the thread (category, channel, link state, what it waits on, why it was matched, the sender), its messages oldest first ("sender", "support" for our replies, "internal" for colleagues' notes), the time now, and the linked orders. Each order has its status, the engine's group and reason, the car, the route, the windows (UTC), its situation card (what is wrong, in words) and the steps the operator can take on it, numbered from 0.

The reply:
- Answers the sender's latest message, in the language of that message.
- Uses only facts in the input. Never invent times, dates, names, prices or promises; never write a number that is not in the input.
- A thread with no linked order is not matched: do not confirm or reveal anything about any order (car, route, buyer, driver, status), even one the sender names. Ask for what would match it (the order reference from the sender's own booking, a registration plate) or answer a general question in general terms.
- Follows internal notes, never quotes them, and never says what the records show internally (rule names, groups, "the engine").
- Short and polite: a greeting, two to four sentences, a sign-off "Support desk". Plain text, no markdown.

The steps: pick at most ${MAX_PICKS} steps, across the linked orders, that a person should take because of this thread, most useful first, each with one short sentence saying why. Pick none when the thread needs only the reply.

"note" is one sentence for the operator: what this thread needs from them.

Reply with only a JSON object:
{"reply": "...", "note": "...", "picks": [{"order": 0, "step": 0, "why": "..."}]}`

class Rejected extends Error {}

export function suggestKey(input: SuggestInput, model: string): string {
  return createHash("sha256").update(`${SUGGEST_VERSION}\n${model}\n${JSON.stringify(promptInput(input))}`).digest("hex")
}

/** What the model reads: the input without ids, with steps as their labels. */
function promptInput(input: SuggestInput) {
  return {
    now: input.now, thread: input.thread, messages: input.messages,
    orders: input.orders.map(({ orderId: _id, steps, ...order }) => ({ ...order, steps: steps.map((step, index) => ({ step: index, label: step.label })) })),
  }
}

/** The model's reply as a suggestion, or Rejected. */
export function parseSuggestion(content: string | null, input: SuggestInput): Picked {
  const raw = (content ?? "").trim()
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as Record<string, unknown>
  } catch {
    throw new Rejected("the reply was not JSON")
  }
  const reply = typeof parsed.reply === "string" ? parsed.reply.trim() : ""
  if (!reply) throw new Rejected("the draft reply is missing")
  if (reply.length > 1500) throw new Rejected("the draft reply is too long")
  // A number the input does not hold is made up (a time, a price, another order's reference).
  const known = JSON.stringify(input)
  const invented = (reply.match(/\d{2,}/g) ?? []).find((digits) => !known.includes(digits))
  if (invented) throw new Rejected(`the draft names ${invented}, which the thread and its orders do not`)
  const picks = (Array.isArray(parsed.picks) ? parsed.picks : []).slice(0, MAX_PICKS).map((value, index) => {
    const pick = (value ?? {}) as Record<string, unknown>
    const order = Number(pick.order)
    const step = Number(pick.step)
    if (!Number.isInteger(order) || !input.orders[order]) throw new Rejected(`pick ${index + 1} names no linked order`)
    if (!Number.isInteger(step) || !input.orders[order].steps[step]) throw new Rejected(`pick ${index + 1} names no step of ${input.orders[order].reference}`)
    return { order, step, why: typeof pick.why === "string" && pick.why.trim() ? pick.why.trim().slice(0, 240) : null }
  })
  const note = typeof parsed.note === "string" && parsed.note.trim() ? parsed.note.trim().slice(0, 240) : null
  return { reply, note, picks: picks.filter((pick, index) => picks.findIndex((other) => other.order === pick.order && other.step === pick.step) === index) }
}

/** The suggestion for one thread: a cached model suggestion, a fresh one, or the template with the reason. */
export async function suggestForThread(input: SuggestInput, options: SuggestOptions = {}): Promise<InboxSuggestion> {
  const { gateway, cache } = options
  if (!gateway) return templateSuggestion(input, "Template suggestion: no model key is set.")
  const model = options.model ?? process.env.INBOX_MODEL ?? process.env.REVIEWER_MODEL ?? DEFAULT_REVIEWER_MODEL
  const key = suggestKey(input, model)
  const done = (picked: Picked, from: { model: string; cost: number; cached: boolean }): InboxSuggestion => ({
    reply: picked.reply, note: picked.note, orders: ordersFrom(input, picked.picks), source: "model", ...from, fallback: null,
  })
  try {
    const hit = await cache?.get(key)
    if (hit) return done(hit, { model: hit.model, cost: 0, cached: true })
  } catch {
    // A cache that cannot be read is a miss.
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const call = gateway.chat({
      job: "inbox-suggest", subject: input.thread.id, model, effort: options.effort ?? "low", maxTokens: 4000,
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: JSON.stringify(promptInput(input)) }],
    })
    const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Rejected("the model was too slow")), options.timeoutMs ?? SUGGEST_TIMEOUT_MS) })
    const response = await Promise.race([call, late])
    const picked = parseSuggestion(response.message.content, input)
    const stored: CachedSuggestion = { ...picked, model: response.model || model, cost: response.usage.cost }
    await cache?.put(key, stored).catch(() => {})
    return done(picked, { model: stored.model, cost: stored.cost, cached: false })
  } catch (error) {
    const reason = error instanceof Rejected ? `the model's suggestion was rejected (${error.message})` : "the model call failed"
    return templateSuggestion(input, `Template suggestion: ${reason}.`)
  } finally {
    clearTimeout(timer)
  }
}
