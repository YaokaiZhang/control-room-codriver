// The app's engine: the seeded snapshot and the Postgres store. Routes and server
// components call `getEngine()`; nothing else in the app should read our tables.

import "server-only"
import path from "node:path"
import { and, inArray, isNull } from "drizzle-orm"
import { db } from "@/lib/db"
import { relatedRecords } from "@/lib/schema"
import { anthropicFromEnv } from "@/lib/reviewer/anthropic"
import { createPostgresReviewCache } from "@/lib/reviewer/postgres-cache"
import { createPostgresTraceStore } from "@/lib/reviewer/postgres-trace"
import { createTracedGateway, type TraceStore } from "@/lib/reviewer/trace"
import { reviewSourceFromDatabase } from "@/lib/reviewer/source"
import { createEngine, type Engine } from "./engine"
import { createLessonFeeds, type LessonFeeds } from "./lessons"
import type { EngineStore } from "./store"
import { createPostgresStore } from "./postgres"
import { createPostgresPlanCache } from "./plan-cache"
import { createPostgresProseCache } from "./prose-cache"
import { demoAnswerer, RING_TIMEOUT_MS, type PhonePersona } from "./phone"
import { DEMO_SCRIPTS, modelCallee, simulatedPerson } from "./simulated-person"
import { createDiskAudioStore, type AudioStore } from "./speech"
import { createVoiceAgent, type VoiceAgent } from "./voice-agent"
import { speechFromEnv, transcriberFromEnv } from "./voice-azure"
import { openRouterVoiceFromEnv } from "./voice-openrouter"
import type { ModelGateway } from "@/lib/reviewer/gateway"
import type { SuggestOptions } from "./inbox-agent"
import { createPostgresSuggestionCache } from "./suggestion-cache"
import { createPostgresPlainCache } from "./plain-cache"
import { createPlainWords, type PlainItem, type PlainWordsService } from "./plain-words"
import { createMistakeLog } from "./mistakes"
import { createLearning } from "./learning"
import type { Group } from "./checks"
import { applyPlain, type PlainWords, type Situation } from "@/lib/present/situation"

// The snapshot is read once per server process (kept across dev reloads).
// Restart the server after reseeding. Reviews are read from cr_review_results on
// each state (the seed sweep, `npm run review:sweep`, writes them from its own process).
const cache = globalThis as unknown as {
  controlRoomEngine?: Promise<Engine>; controlRoomAudio?: AudioStore; controlRoomPump?: ReturnType<typeof setInterval>
  controlRoomPhones?: Map<PhonePersona, { since: number; seen: number }>
  controlRoomPublishing?: ReturnType<typeof setInterval>
  controlRoomPlain?: PlainWordsService
  controlRoomStore?: EngineStore; controlRoomLessons?: LessonFeeds
  controlRoomGateway?: { gateway: ModelGateway | null }
  controlRoomTrace?: TraceStore
}

/** The engine's store (Postgres). */
export function getStore(): EngineStore {
  cache.controlRoomStore ??= createPostgresStore(db)
  return cache.controlRoomStore
}

/** Agent runs, model calls and prompt texts (Postgres; spec .scratch/traceability): what the traced gateway writes; kept in the database for inspection. */
export function getTraceStore(): TraceStore {
  cache.controlRoomTrace ??= createPostgresTraceStore(db)
  return cache.controlRoomTrace
}

/**
 * Approved lessons per agent (lessons.ts), cached in the process for a short while so
 * reviews and cards don't read the store on every call. The lessons route refreshes
 * it after each decision.
 */
export function lessonFeeds(): LessonFeeds {
  cache.controlRoomLessons ??= createLessonFeeds(getStore())
  return cache.controlRoomLessons
}

/**
 * The model (Anthropic), every call kept under its agent run in cr_agent_runs and
 * cr_model_calls (lib/reviewer/trace.ts, spec .scratch/traceability); null without
 * ANTHROPIC_API_KEY. Every agent gets this one.
 */
function modelGateway(): ModelGateway | null {
  if (!cache.controlRoomGateway) {
    const gateway = anthropicFromEnv()
    cache.controlRoomGateway = { gateway: gateway && createTracedGateway(gateway, getTraceStore()) }
  }
  return cache.controlRoomGateway.gateway
}

/** A phone page counts as open while it polled within this many ms. */
const PHONE_SEEN_MS = 8_000

function phones(): Map<PhonePersona, { since: number; seen: number }> {
  cache.controlRoomPhones ??= new Map()
  return cache.controlRoomPhones
}

/** The phone page for `persona` is open (it polls `/api/phone`). Live calls ring out only on an open phone. */
export function markPhoneOpen(persona: PhonePersona): void {
  const now = Date.now()
  const known = phones().get(persona)
  phones().set(persona, { since: known && now - known.seen < PHONE_SEEN_MS ? known.since : now, seen: now })
}

function phoneOpenSince(persona: PhonePersona): number | null {
  const known = phones().get(persona)
  return known && Date.now() - known.seen < PHONE_SEEN_MS ? known.since : null
}

/** Demo cases ring live on the phone page unless LIVE_DEMO_CALLS=0 (then the simulated person runs the scripts alone). */
const LIVE_DEMO = process.env.LIVE_DEMO_CALLS !== "0"
const RING_TIMEOUT = Number(process.env.PHONE_RING_TIMEOUT_MS) || RING_TIMEOUT_MS

/**
 * Cached tier-1 speech, as files (AUDIO_CACHE_DIR, default `.cache/tts` in the app
 * directory). Another `AudioStore` (S3, Postgres) can replace it without touching calls.
 */
export function getAudioStore(): AudioStore {
  cache.controlRoomAudio ??= createDiskAudioStore(process.env.AUDIO_CACHE_DIR || path.join(process.cwd(), ".cache", "tts"))
  return cache.controlRoomAudio
}

/** How often the call pump takes one step on every background call (ms); CALL_PUMP_MS=0 turns it off. */
const PUMP_MS = Number(process.env.CALL_PUMP_MS ?? 1000)

/**
 * The call pump: background calls run on their own in the server process, one
 * exchange per call per tick, paced like a real phone so the order page can show
 * the live transcript. It also starts the calls the rules and proposals plan.
 */
function startPump(engine: Engine): void {
  if (!PUMP_MS || cache.controlRoomPump) return
  let busy = false
  cache.controlRoomPump = setInterval(() => {
    if (busy) return
    busy = true
    engine.apply({ type: "runCalls", steps: 1 })
      .catch((error) => console.error("call pump:", error instanceof Error ? error.message : error))
      .finally(() => { busy = false })
  }, PUMP_MS)
  cache.controlRoomPump.unref?.()
}

/**
 * Tier 2 (ticket 12): Haiku (the reviewer's gateway, on Anthropic) writes the opener,
 * checks each turn and writes the replies; simulated calls talk in text. Anthropic has
 * no speech models: the ear and text to speech are Azure AI Speech (AZURE_SPEECH_KEY,
 * AZURE_SPEECH_REGION), or OpenRouter without it; with neither, a live call that
 * reaches tier 2 is handed over. The audio-in, audio-out model is OpenRouter's only
 * (OPENROUTER_API_KEY); without it every live turn is the fallback (ear, Haiku, text
 * to speech). TIER2_AUDIO_MODEL=off forces the fallback.
 */
function voiceAgent(gateway: ModelGateway | null): VoiceAgent | null {
  if (!gateway) return null
  return createVoiceAgent({ voice: openRouterVoiceFromEnv(getAudioStore()), ear: transcriberFromEnv(), checker: gateway })
}

/** How often the publishing loop runs (ms); PUBLISH_PUMP_MS=0 turns it off. */
const PUBLISH_MS = Number(process.env.PUBLISH_PUMP_MS ?? 3000)

/**
 * The publishing loop (spec .scratch/publishing): the agent publishes reviewed Normal
 * orders, filters every order on the market and drafts one travel plan per tick, on its
 * own interval so a slow plan never holds up the call pump.
 */
function startPublishing(engine: Engine): void {
  if (!PUBLISH_MS || cache.controlRoomPublishing) return
  let busy = false
  cache.controlRoomPublishing = setInterval(() => {
    if (busy) return
    busy = true
    engine.apply({ type: "runPublishing", plans: 1 })
      .catch((error) => console.error("publishing:", error instanceof Error ? error.message : error))
      .finally(() => { busy = false })
  }, PUBLISH_MS)
  cache.controlRoomPublishing.unref?.()
}

/** Ferry terminals and city-to-terminal road estimates: reference rows (no order id) the travel planner reads. */
async function travelReference() {
  const rows = await db.select().from(relatedRecords).where(and(isNull(relatedRecords.orderId), inArray(relatedRecords.collection, ["ferry_terminals", "terminal_road_estimates"])))
  return {
    terminals: rows.filter((row) => row.collection === "ferry_terminals").map((row) => ({ id: row.id, ...row.details })),
    roadEstimates: rows.filter((row) => row.collection === "terminal_road_estimates").map((row) => ({ id: row.id, ...row.details })),
  }
}

export function getEngine(): Promise<Engine> {
  cache.controlRoomEngine ??= Promise.all([reviewSourceFromDatabase(db), travelReference()])
    .then(([source, reference]) => {
      const gateway = modelGateway()
      // Lessons (ticket 03): a usable mistake may start a distil and gate in the background; nothing without a key.
      const learning = createLearning({ store: getStore(), gateway, source, now: async () => (await getStore().readClock()) ?? source.snapshot.snapshotAt })
      const engine = createEngine({
        snapshot: source.snapshot,
        store: getStore(),
        reviews: { gateway, cache: createPostgresReviewCache(db), inboxMessages: source.inboxMessages, lessons: lessonFeeds().reviewer },
        // Digest prose (ticket 13): the same gateway, low effort, template text after about 5 s.
        briefing: { gateway, cache: createPostgresProseCache(db) },
        // Calls (ticket 10): background calls are answered by the simulated person; demo
        // cases and "ring live" calls ring on the Site/Driver phone page (ticket 11).
        // At tier 2 a model plays the background callee in text (ticket 12), so a
        // simulated escalation is talked through rather than handed over at once.
        calls: {
          person: simulatedPerson(DEMO_SCRIPTS, gateway ? modelCallee(gateway) : undefined), speech: speechFromEnv(getAudioStore()), pace: 1,
          ...(LIVE_DEMO ? { answererFor: demoAnswerer() } : {}),
          phoneOpenSince, ringTimeoutMs: RING_TIMEOUT, voice: voiceAgent(gateway),
        },
        // Travel plans (spec .scratch/publishing): the same gateway; template plans without a key.
        travel: { gateway, cache: createPostgresPlanCache(db), reference },
        // Mistakes (spec .scratch/self-improving-agents): the same gateway restates the operator's reasons; pending without a key.
        mistakes: { gateway, onUsable: learning.consider },
      })
      startPump(engine)
      startPublishing(engine)
      return engine
    })
    .catch((error) => { cache.controlRoomEngine = undefined; throw error })
  return cache.controlRoomEngine
}

/** The inbox agent's model and cache (inbox-agent.ts): the reviewer's gateway; template suggestions without a key. */
export function inboxAgentOptions(): SuggestOptions {
  return { gateway: modelGateway(), cache: createPostgresSuggestionCache(db) }
}

/** The situation cards' plain words (plain-words.ts): the reviewer's gateway; code text without a key. Rejected cards are kept as mistakes. */
export function plainWords(): PlainWordsService {
  cache.controlRoomPlain ??= createPlainWords({
    gateway: modelGateway(), cache: createPostgresPlainCache(db),
    lessons: lessonFeeds().plainWords, mistakes: createMistakeLog(getStore()),
  })
  return cache.controlRoomPlain
}

const PLAIN_KIND: Partial<Record<Group, PlainItem["kind"]>> = { needs_action: "decide", solved: "review", in_progress: "agent" }

export type PlainRow = { situation: Situation | null; group: Group }

/** The model's rewrite for each card that has one cached (null otherwise); asks for the rest in the background. */
export async function plainFor(rows: PlainRow[]): Promise<(PlainWords | null)[]> {
  const items: { at: number; item: PlainItem }[] = []
  rows.forEach((row, at) => {
    const kind = PLAIN_KIND[row.group]
    if (row.situation && kind) items.push({ at, item: { situation: row.situation, kind } })
  })
  const found = await plainWords().lookup(items.map(({ item }) => item)).catch(() => new Map<number, PlainWords>())
  const out: (PlainWords | null)[] = rows.map(() => null)
  items.forEach(({ at }, index) => { out[at] = found.get(index) ?? null })
  return out
}

/** The cards in the model's words where a rewrite is cached. */
export async function inPlainWords<T extends PlainRow>(rows: T[]): Promise<(Situation | null)[]> {
  const plain = await plainFor(rows)
  return rows.map((row, index) => row.situation && applyPlain(row.situation, plain[index]))
}
