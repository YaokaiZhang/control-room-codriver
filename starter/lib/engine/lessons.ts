// Lessons (spec .scratch/self-improving-agents): what the agents learn from the
// operator's corrections. The distiller (ticket 03) adds a candidate; only the operator
// approves, rejects or retires it, each an event with time and actor; approved lessons
// are injected into the agents' prompts where their tags match (lib/reviewer/lessons.ts).
//
// - A lesson row is never changed; its status is folded from its events:
//   candidate -> approved | rejected, approved -> retired.
// - At most MAX_APPROVED_LESSONS approved per agent: the 11th is refused until one retires.
// - Lessons survive a demo reset (LEARNING_TABLES) and use real time, not the demo clock.
// - A new candidate delivers a Briefing item; the engine delivers it again for every open
//   candidate after a reset (at-most-once by id).

import { createHash } from "node:crypto"
import { MAX_APPROVED_LESSONS, type InjectedLesson, type LessonFeed } from "@/lib/reviewer/lessons"
import { lessonItem, lessonItemId } from "./briefing"
import { RULE_CATALOGUE } from "./rules"
import type { Mistake } from "./mistakes"
import type { EngineStore } from "./store"

export { MAX_APPROVED_LESSONS }

export const LESSON_AGENTS = ["reviewer", "plain-words"] as const
export type LessonAgent = typeof LESSON_AGENTS[number]

/** Plain-words card kinds (PlainItem["kind"]). */
export const CARD_KINDS = ["decide", "review", "agent"] as const

/** The injected text's limit: one or two plain sentences. */
export const MAX_LESSON_CHARS = 300

export type LessonStatus = "candidate" | "approved" | "rejected" | "retired"
export type LessonDecision = "approved" | "rejected" | "retired"

export type StoredLesson = {
  /** "lsn-" and a hash of the agent and text: adding the same lesson twice is a no-op. */
  id: string
  agent: LessonAgent
  /** One or two plain sentences: the only part a prompt gets. */
  text: string
  /** For the operator only: why the distiller thinks it holds. */
  explanation: string
  /** Rule ids (reviewer) or card kinds (plain-words); empty: every call. */
  appliesTo: string[]
  sourceMistakeIds: string[]
  /** The reviewer eval's score without and with the lesson (ticket 03's gate); null when not run. */
  evalBefore: number | null
  evalAfter: number | null
  /** Real time it was added. */
  createdAt: string
  /** Who wrote it: "distiller", or "operator" for one seeded by hand. */
  by: string
}

export type StoredLessonEvent = {
  lessonId: string
  /** Real time. */
  at: string
  /** "operator" (one persona until logins exist). */
  by: string
  kind: LessonDecision
  /** The operator's note, often empty. */
  text: string
}

export type Lesson = StoredLesson & { status: LessonStatus; history: StoredLessonEvent[] }

/** What ticket 03 hands over: everything but the id, time and status. */
export type LessonCandidate = Omit<StoredLesson, "id" | "createdAt" | "by"> & { by?: string }

/** A refused decision or candidate; the API answers 409 with its message. */
export class LessonRefused extends Error {}

const AGENT_LABEL: Record<LessonAgent, string> = { reviewer: "The reviewer", "plain-words": "The card wording" }

export function lessonId(agent: string, text: string): string {
  return `lsn-${createHash("sha256").update(`${agent}\n${text}`).digest("hex").slice(0, 12)}`
}

const NEXT: Record<LessonDecision, LessonStatus> = { approved: "candidate", rejected: "candidate", retired: "approved" }

/** Every lesson with its status, newest first. Events that don't fit the status are ignored. */
export function foldLessons(stored: StoredLesson[], events: StoredLessonEvent[]): Lesson[] {
  const lessons = new Map(stored.map((lesson) => [lesson.id, { ...lesson, status: "candidate" as LessonStatus, history: [] as StoredLessonEvent[] }]))
  for (const event of events) {
    const lesson = lessons.get(event.lessonId)
    if (!lesson || NEXT[event.kind] !== lesson.status) continue
    lesson.status = event.kind
    lesson.history.push(event)
  }
  return [...lessons.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
}

export async function readLessons(store: EngineStore): Promise<Lesson[]> {
  const [stored, events] = await Promise.all([store.readLessons(), store.readLessonEvents()])
  return foldLessons(stored, events)
}

/** Checks a candidate in code before it is stored; throws LessonRefused. */
export function checkCandidate(input: LessonCandidate): LessonCandidate {
  if (!(LESSON_AGENTS as readonly string[]).includes(input.agent)) throw new LessonRefused(`Unknown agent ${String(input.agent)}`)
  const text = typeof input.text === "string" ? input.text.trim() : ""
  if (!text) throw new LessonRefused("A lesson needs its text")
  if (text.length > MAX_LESSON_CHARS) throw new LessonRefused(`A lesson is at most ${MAX_LESSON_CHARS} characters`)
  if (/[\n`*#{}]/.test(text)) throw new LessonRefused("A lesson is plain sentences: no markup or line breaks")
  const explanation = typeof input.explanation === "string" ? input.explanation.trim() : ""
  if (!explanation) throw new LessonRefused("A lesson needs an explanation for the operator")
  const tags = input.agent === "reviewer" ? Object.keys(RULE_CATALOGUE) : [...CARD_KINDS]
  const strange = input.appliesTo.find((tag) => !tags.includes(tag))
  if (strange !== undefined) throw new LessonRefused(`${strange} is not a ${input.agent === "reviewer" ? "rule id" : "card kind"}`)
  const score = (value: number | null) => value === null || Number.isFinite(value) ? value : null
  return {
    ...input, text, explanation, appliesTo: [...new Set(input.appliesTo)], sourceMistakeIds: [...new Set(input.sourceMistakeIds)],
    evalBefore: score(input.evalBefore), evalAfter: score(input.evalAfter),
  }
}

/**
 * Stores a candidate and delivers its Briefing item at `now` (the demo clock). Ticket
 * 03 calls this after the gate. Adding the same agent and text again changes nothing.
 */
export async function addLessonCandidate(store: EngineStore, input: LessonCandidate, options: { now: string; clock?: () => Date }): Promise<Lesson> {
  const checked = checkCandidate(input)
  const at = (options.clock ?? (() => new Date()))().toISOString()
  const lesson: StoredLesson = { ...checked, id: lessonId(checked.agent, checked.text), createdAt: at, by: input.by ?? "distiller" }
  if (await store.addLesson(lesson)) await store.addBriefing(lessonItem(lesson, options.now, at))
  const found = (await readLessons(store)).find((row) => row.id === lesson.id)
  if (!found) throw new Error(`Lesson ${lesson.id} was not stored`)
  return found
}

const VERB: Record<LessonDecision, string> = { approved: "approve", rejected: "reject", retired: "retire" }

/** Approves, rejects or retires a lesson (operator only); returns every lesson. Throws LessonRefused. */
export async function decideLesson(store: EngineStore, input: { lessonId: string; decision: LessonDecision; note?: string; by?: string; clock?: () => Date }): Promise<Lesson[]> {
  const lessons = await readLessons(store)
  const lesson = lessons.find((row) => row.id === input.lessonId)
  if (!lesson) throw new LessonRefused(`Unknown lesson ${input.lessonId}`)
  if (NEXT[input.decision] !== lesson.status) {
    throw new LessonRefused(`Only ${NEXT[input.decision] === "candidate" ? "a candidate" : "an approved lesson"} can be ${input.decision}; this one is ${lesson.status}`)
  }
  if (input.decision === "approved") {
    const approved = lessons.filter((row) => row.agent === lesson.agent && row.status === "approved").length
    if (approved >= MAX_APPROVED_LESSONS) {
      throw new LessonRefused(`${AGENT_LABEL[lesson.agent]} already has ${MAX_APPROVED_LESSONS} approved lessons. Retire one first.`)
    }
  }
  const at = (input.clock ?? (() => new Date()))().toISOString()
  await store.appendLessonEvents([{ lessonId: lesson.id, at, by: input.by ?? "operator", kind: input.decision, text: input.note?.trim() ?? "" }])
  // Its "needs your yes" item is answered.
  if (input.decision !== "retired") await store.markBriefingRead([lessonItemId(lesson.id)])
  return readLessons(store)
}

export type LessonAction = { action: "approve" | "reject" | "retire"; lessonId: string; note?: string }

const DECISION: Record<LessonAction["action"], LessonDecision> = { approve: "approved", reject: "rejected", retire: "retired" }

/** The API body as a decision, or null when it is not one. */
export function parseLessonAction(body: unknown): LessonAction | null {
  if (!body || typeof body !== "object") return null
  const { action, lessonId: id, note } = body as Record<string, unknown>
  if (typeof action !== "string" || !(action in DECISION) || typeof id !== "string" || !id) return null
  return { action: action as LessonAction["action"], lessonId: id, ...(typeof note === "string" ? { note } : {}) }
}

export function applyLessonAction(store: EngineStore, action: LessonAction, clock?: () => Date): Promise<Lesson[]> {
  return decideLesson(store, { lessonId: action.lessonId, decision: DECISION[action.action], note: action.note, by: "operator", clock })
}

/** A source mistake as the Lessons section shows it. */
export type MistakeSource = { id: string; note: string | null; orderId: string | null; reference: string | null }

/**
 * What can be shown of a lesson's source mistakes: the operator's original note (or the
 * edit, or the validator's reason) and the order link. Without a lookup, only the ids.
 */
export async function sourceMistakes(ids: string[], lookup?: (ids: string[]) => Promise<MistakeSource[]>): Promise<MistakeSource[]> {
  const found = new Map((lookup ? await lookup(ids).catch(() => []) : []).map((row) => [row.id, row]))
  return ids.map((id) => found.get(id) ?? { id, note: null, orderId: null, reference: null })
}

/** A lesson as the Lessons page shows it: its source mistakes, and what it applies to in words. */
export type LessonView = Lesson & { sources: MistakeSource[]; appliesToLabels: string[] }

const CARD_KIND_LABEL: Record<string, string> = { decide: "Decide cards", review: "Review cards", agent: "Agent cards" }

/** A tag in words: a reviewer tag is a rule check, a wording tag a card kind. */
function tagLabel(agent: Lesson["agent"], tag: string): string {
  return agent === "reviewer" ? RULE_CATALOGUE[tag as keyof typeof RULE_CATALOGUE]?.title ?? tag : CARD_KIND_LABEL[tag] ?? tag
}

/** GET /api/lessons and every action's answer. */
export type LessonsView = { lessons: LessonView[]; max: number }

export async function lessonsView(lessons: Lesson[], lookup?: (ids: string[]) => Promise<MistakeSource[]>): Promise<LessonsView> {
  return { lessons: await Promise.all(lessons.map(async (lesson) => ({ ...lesson, sources: await sourceMistakes(lesson.sourceMistakeIds, lookup), appliesToLabels: lesson.appliesTo.map((tag) => tagLabel(lesson.agent, tag)) }))), max: MAX_APPROVED_LESSONS }
}

/** A stored mistake as a lesson's source: what the operator (or the validator) said, and the order. */
export function mistakeSource(mistake: Mistake): MistakeSource {
  const note = mistake.operatorNote
    ?? (mistake.editDiff ? `Edited "${mistake.editDiff.before}" to "${mistake.editDiff.after}"` : null)
    ?? mistake.validatorReason
  const reference = typeof mistake.caseFile?.reference === "string" ? mistake.caseFile.reference : null
  return { id: mistake.id, note, orderId: mistake.orderId, reference }
}

/** Looks source mistakes up in the store's mistakes. */
export function mistakeLookup(store: Pick<EngineStore, "readMistakes">): (ids: string[]) => Promise<MistakeSource[]> {
  return async (ids) => {
    const wanted = new Set(ids)
    return (await store.readMistakes()).filter((mistake) => wanted.has(mistake.id)).map(mistakeSource)
  }
}

export const toInjected = (lesson: Lesson): InjectedLesson => ({ id: lesson.id, text: lesson.text, appliesTo: lesson.appliesTo })

export type LessonFeeds = { reviewer: LessonFeed; plainWords: LessonFeed; refresh(): void }

/**
 * The approved lessons per agent, read through a short in-process cache so a page
 * read does not hit the store each time. `refresh` after a decision; another process's
 * decision shows within `ttlMs`. A failed read gives no lessons and is retried next time.
 */
export function createLessonFeeds(store: EngineStore, ttlMs = 30_000): LessonFeeds {
  let loaded: { at: number; lessons: Promise<Lesson[]> } | null = null
  function all(): Promise<Lesson[]> {
    if (!loaded || Date.now() - loaded.at > ttlMs) {
      const lessons = readLessons(store)
      loaded = { at: Date.now(), lessons }
      lessons.catch(() => { if (loaded?.lessons === lessons) loaded = null })
    }
    return loaded.lessons
  }
  // A store that can't be read (lessons table not pushed yet) has no lessons to give.
  const feed = (agent: LessonAgent): LessonFeed => async () => (await all().catch(() => [] as Lesson[]))
    .filter((row) => row.agent === agent && row.status === "approved").map(toInjected)
  return { reviewer: feed("reviewer"), plainWords: feed("plain-words"), refresh() { loaded = null } }
}
