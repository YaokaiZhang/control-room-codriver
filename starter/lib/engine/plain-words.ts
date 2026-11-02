// Plain words for the situation cards. The card's headline and body are written by
// code from the engine's own words and read stiff ("Suggestion: hand you the contact
// with ... (paying customer, cus-015)"). The model (no reasoning, no tools) rewrites
// them as a person would say them, in batches, in the background:
//
// - `lookup` never waits for the model. It returns the rewrites already cached and
//   starts a batch for the rest; the next read (the pages poll) picks them up.
// - A rewrite may only use numbers that are in the card it rewrites (every digit run
//   must appear there), so a time, count or reference can't drift. A rejected or
//   failed card keeps its code text. A rejected card is recorded as a mistake (the
//   validator's reason, tagged with the card's kind), once per card.
// - Rewrites are cached by a hash of the prompt version, the model and the card.
// - Approved plain-words lessons tagged with the card's kind (or untagged) follow the
//   instructions; a batch holds cards that get the same lessons, and their hash joins
//   the card's key (none: the key as before).

import { createHash } from "node:crypto"
import type { ModelGateway } from "@/lib/reviewer/gateway"
import { lessonsFor, lessonsHash, renderLessons, type InjectedLesson, type LessonFeed } from "@/lib/reviewer/lessons"
import { DEFAULT_REVIEWER_MODEL } from "@/lib/reviewer/reviewer"
import { plainFor, type PlainWords, type Situation } from "@/lib/present/situation"
import type { MistakeLog } from "./mistakes"

export const PLAIN_VERSION = "plain-words-v2"
const BATCH = 8

/** One card to rewrite. The car and route are shown beside it, so the model does not get them. */
export type PlainItem = { situation: Situation; kind: "decide" | "review" | "agent" }

export type PlainText = { headline: string; body: string | null }

export interface PlainCache {
  getMany(keys: string[]): Promise<Map<string, PlainText>>
  put(key: string, text: PlainText, model: string): Promise<void>
}

export function createMemoryPlainCache(): PlainCache {
  const entries = new Map<string, PlainText>()
  return {
    async getMany(keys) { return new Map(keys.filter((key) => entries.has(key)).map((key) => [key, { ...entries.get(key)! }])) },
    async put(key, text) { entries.set(key, { ...text }) },
  }
}

export type PlainOptions = {
  gateway?: ModelGateway | null; cache: PlainCache; model?: string
  /** The approved plain-words lessons; absent: none. */
  lessons?: LessonFeed
  /** Where rejected cards are kept as mistakes; absent: not kept. */
  mistakes?: Pick<MistakeLog, "record"> | null
}

export class PlainRejected extends Error {}

const digitRuns = (text: string) => text.match(/\d+/g) ?? []
// The model must not guess anyone's gender.
const GENDERED = /\b(he|she|him|her|his|hers|himself|herself)\b/i

/** Checks one rewrite against the card it rewrites; throws PlainRejected. */
export function checkPlain(raw: unknown, source: PlainItem): PlainText {
  const row = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}
  const headline = typeof row.headline === "string" ? row.headline.trim().replace(/[.]$/, "") : ""
  const body = typeof row.body === "string" && row.body.trim() ? row.body.trim() : null
  if (!headline) throw new PlainRejected("no headline")
  if (headline.length > 90 || (body?.length ?? 0) > 360) throw new PlainRejected("too long")
  if (/[\n*#`{}]/.test(headline + (body ?? ""))) throw new PlainRejected("markup or line breaks")
  const known = new Set(digitRuns(`${source.situation.headline} ${source.situation.body ?? ""}`))
  const strange = digitRuns(`${headline} ${body ?? ""}`).find((run) => !known.has(run))
  if (strange) throw new PlainRejected(`a number not in the card (${strange})`)
  if (GENDERED.test(`${headline} ${body ?? ""}`) && !GENDERED.test(`${source.situation.headline} ${source.situation.body ?? ""}`)) throw new PlainRejected("a gendered pronoun")
  return { headline, body }
}

const SYSTEM = `You rewrite the status cards of a car-delivery control room so an operator understands each one at a glance. Code wrote them from system records, so they read stiff, use internal terms and sometimes ids.

Each card has a kind: "decide" (the operator must act), "review" (call results wait for the operator's yes) or "agent" (the AI agent is working on it; nothing for the operator to do). It also has a headline (what is wrong, or what the agent is doing) and maybe a body (the situation, then a suggested next step).

For every card write:
- "headline": what is wrong in plain words, at most nine words, sentence case, no full stop. Name the person, place or thing when the card does. The car and route are shown next to the card: don't name the car model or the route.
- "body": one or two short, natural sentences, at most thirty words: what is going on and why it matters, then for "decide" cards what to do next, speaking to the operator as "you". For "agent" cards say what the agent is doing; ask nothing of the operator. Null only when there is truly nothing to add.

Rules:
- Say each thing once: the body adds to the headline, it doesn't repeat it.
- Use only facts in the card. Don't guess who someone is (customer, driver, site) unless the card says so, and don't guess why something happened.
- Refer to people by name or role, never by he, she, him, her, his or hers. Keep every name, place, time, date, amount and order reference exactly as written. Never add a number, time or date that is not in the card.
- Leave out internal ids (like cus-015, drv-434, work-x886e3f, res-x0320cd) and code words (like CLOSE, R11, operator-question); say what they are instead ("the customer", "the driver", "the train booking").
- No markdown, no lists, no line breaks, no exclamation marks, no "please". Calm, direct English.

Reply with only a JSON object: {"cards": [{"id": "...", "headline": "...", "body": "..."}]}, one entry per card, ids as given.`

/** `lessons` is the hash of the lessons the card gets ("" for none: the key as before lessons existed). */
export function plainKey(item: PlainItem, model: string, lessons = ""): string {
  const { headline, body } = item.situation
  return createHash("sha256").update(JSON.stringify([PLAIN_VERSION, model, item.kind, headline, body, ...(lessons ? [lessons] : [])])).digest("hex")
}

/** The approved lessons for a card: tagged with its kind, or untagged. */
export function plainLessons(lessons: InjectedLesson[], item: PlainItem): InjectedLesson[] {
  return lessonsFor(lessons, [item.kind])
}

type Row = { key: string; item: PlainItem; lessons: InjectedLesson[] }

function chunks<T>(list: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(list.length / size) }, (_, at) => list.slice(at * size, at * size + size))
}

function parseReply(content: string | null): unknown[] {
  const text = (content ?? "").trim()
  try {
    const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as { cards?: unknown }
    if (Array.isArray(parsed.cards)) return parsed.cards
  } catch {
    // Falls through to the rejection below.
  }
  throw new PlainRejected("the reply was not the cards JSON")
}

export type PlainWordsService = {
  /** The cached rewrites, by item index; starts a background batch for the rest. Never throws. */
  lookup(items: PlainItem[]): Promise<Map<number, PlainWords>>
  /** Rewrites the items now (tests and warm-up): resolves when every running batch has settled. */
  fill(items: PlainItem[]): Promise<void>
}

export function createPlainWords(options: PlainOptions): PlainWordsService {
  const { gateway, cache } = options
  const model = options.model ?? process.env.REVIEWER_MODEL ?? DEFAULT_REVIEWER_MODEL
  /** Cards being rewritten now, and cards the model failed on in this process (not retried). */
  const busy = new Set<string>()
  const failed = new Set<string>()
  const running = new Set<Promise<void>>()

  /** The validator's rejection as a mistake: objective, so usable as it is. Its id is the card's key: once per card. */
  async function rejected(key: string, item: PlainItem, raw: unknown, reason: string, by: string): Promise<void> {
    if (!options.mistakes) return
    const now = new Date().toISOString()
    await options.mistakes.record({
      id: `pw-${key.slice(0, 32)}`, agent: "plain-words", orderId: null, at: now, recordedAt: now, operator: null,
      promptVersion: PLAIN_VERSION, model: by, kind: "rejected", tags: [`card:${item.kind}`],
      input: { kind: item.kind, headline: item.situation.headline, body: item.situation.body }, agentOutput: raw,
      operatorNote: null, editDiff: null, validatorReason: reason, restatement: null, status: "usable", unusableReason: null, caseFile: null,
      // A batch's calls get one-turn runs whose ids the gateway does not hand back: not known here.
      runId: null, findingId: null,
    })
  }

  async function batch(rows: Row[]): Promise<void> {
    if (!gateway) return
    // Every row of a batch gets the same lessons (see `start`).
    const block = renderLessons(rows[0]?.lessons ?? [])
    const cards = rows.map(({ item }, index) => ({
      id: String(index + 1), kind: item.kind, headline: item.situation.headline, body: item.situation.body,
    }))
    try {
      const response = await gateway.chat({
        job: "plain-words", subject: `cards-${rows.length}`, model, effort: "none", maxTokens: 600 + rows.length * 200,
        messages: [{ role: "system", content: block ? `${SYSTEM}\n\n${block}` : SYSTEM }, { role: "user", content: JSON.stringify({ cards }) }],
      })
      const replies = new Map(parseReply(response.message.content).map((reply) => [String((reply as { id?: unknown })?.id ?? ""), reply]))
      await Promise.all(rows.map(async ({ key, item }, index) => {
        const raw = replies.get(String(index + 1))
        try {
          const text = checkPlain(raw, item)
          await cache.put(key, text, response.model || model)
        } catch (error) {
          failed.add(key)
          // A card the model left out is not a wrong rewrite.
          if (error instanceof PlainRejected && raw !== undefined) await rejected(key, item, raw, error.message, response.model || model)
        }
      }))
    } catch {
      for (const { key } of rows) failed.add(key)
    }
  }

  async function missing(items: PlainItem[]) {
    const approved = options.lessons ? await options.lessons().catch(() => []) : []
    const rows = items.map((item) => {
      const lessons = plainLessons(approved, item)
      return { key: plainKey(item, model, lessonsHash(lessons)), item, lessons }
    })
    const keys = rows.map((row) => row.key)
    const hits = await cache.getMany([...new Set(keys)]).catch(() => new Map<string, PlainText>())
    const todo = new Map<string, Row>()
    for (const row of rows) if (!hits.has(row.key) && !busy.has(row.key) && !failed.has(row.key)) todo.set(row.key, row)
    return { keys, hits, todo: [...todo.values()] }
  }

  function start(todo: Row[]): Promise<void>[] {
    if (!gateway) return []
    const runs: Promise<void>[] = []
    const groups = new Map<string, Row[]>()
    for (const row of todo) {
      const group = lessonsHash(row.lessons)
      groups.set(group, [...(groups.get(group) ?? []), row])
    }
    for (const rows of [...groups.values()].flatMap((group) => chunks(group, BATCH))) {
      for (const { key } of rows) busy.add(key)
      const run: Promise<void> = batch(rows).finally(() => { for (const { key } of rows) busy.delete(key); running.delete(run) })
      running.add(run)
      runs.push(run)
    }
    return runs
  }

  return {
    async lookup(items) {
      const out = new Map<number, PlainWords>()
      if (!items.length) return out
      const { keys, hits, todo } = await missing(items)
      keys.forEach((key, index) => { const hit = hits.get(key); if (hit) out.set(index, { ...hit, for: plainFor(items[index].situation) }) })
      void Promise.all(start(todo)).catch(() => {})
      return out
    },
    async fill(items) {
      const { todo } = await missing(items)
      start(todo)
      await Promise.all(running)
    },
  }
}
