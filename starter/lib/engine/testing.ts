// Test setup for engine tests: the real dataset files, the clock at the snapshot
// (2026-10-21T09:00Z), and a store. `eachStore` runs one test against the in-memory
// store and, when TEST_DATABASE_URL is set, against the Postgres store too.
//
// TEST_DATABASE_URL must point at a database of its own (tests reset its cr_ tables)
// with the schema pushed: `DATABASE_URL=$TEST_DATABASE_URL npx drizzle-kit push --force`.

import "dotenv/config"
import { after, test } from "node:test"
import { getTableName, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import type { ReviewCache } from "@/lib/reviewer/cache"
import { loadFixtures, SCENARIO_FIXTURE_DIR } from "@/lib/reviewer/fixtures"
import { GatewayError, NO_USAGE, type ChatRequest, type ModelGateway } from "@/lib/reviewer/gateway"
import type { LessonFeed } from "@/lib/reviewer/lessons"
import { createPostgresTraceStore } from "@/lib/reviewer/postgres-trace"
import { createScriptedGateway } from "@/lib/reviewer/scripted"
import { createMemoryTraceStore, type TraceStore } from "@/lib/reviewer/trace"
import { testReviewSource } from "@/lib/reviewer/testing"
import type { CallOptions } from "./call-runner"
import type { ProseOptions } from "./digest-prose"
import { createEngine, type Engine, type Snapshot } from "./engine"
import { createMemoryStore } from "./memory"
import type { MistakeOptions } from "./mistakes"
import { createPostgresStore, type Database } from "./postgres"
import { LEARNING_TABLES, TRACE_TABLES } from "./schema"
import type { EngineStore } from "./store"

/** The real dataset, read once per test process. */
export async function testSnapshot(): Promise<Snapshot> {
  return (await testReviewSource()).snapshot
}

export type TestEngineOptions = {
  store?: EngineStore
  /** The reviewer's model: absent means no key ("not reviewed yet"). Use `testGateway()`. */
  gateway?: ModelGateway | null
  reviewCache?: ReviewCache
  /** The digest prose's gateway, cache and timeout. Absent: template text. Use `proseGateway()`. */
  briefing?: ProseOptions
  /** Who answers calls and speech (ticket 10). Absent: the default simulated person, no speech. */
  calls?: CallOptions
  /** The model that restates operator reasons on mistakes. Absent: restatements stay pending. */
  mistakes?: MistakeOptions
  /** The approved reviewer lessons (lessons.ts). Absent: none. */
  lessons?: LessonFeed
}

export async function testEngine(options: TestEngineOptions = {}): Promise<Engine> {
  const source = await testReviewSource()
  return createEngine({
    snapshot: source.snapshot,
    store: options.store ?? createMemoryStore(),
    reviews: { gateway: options.gateway ?? null, cache: options.reviewCache, inboxMessages: source.inboxMessages, lessons: options.lessons },
    briefing: options.briefing,
    calls: options.calls,
    mistakes: options.mistakes,
  })
}

export type CountingGateway = ModelGateway & { readonly calls: ChatRequest[] }

/**
 * The scripted reviewer for engine tests: the permanent hand-written scenarios
 * (CD-420089, 399, 437, 458, 516) and "nothing to ask" for every other order.
 * `findings` (raw submit_findings items by order reference) replace that answer.
 */
export async function testGateway(findings: Record<string, unknown[]> = {}): Promise<CountingGateway> {
  const scripted = createScriptedGateway(await loadFixtures(SCENARIO_FIXTURE_DIR))
  const known = new Set((await loadFixtures(SCENARIO_FIXTURE_DIR)).map((fixture) => fixture.reference))
  const calls: ChatRequest[] = []
  return {
    calls,
    async chat(request) {
      calls.push(request)
      if (known.has(request.subject) && !findings[request.subject]) return scripted.chat(request)
      const raw = findings[request.subject] ?? []
      const args = JSON.stringify({ summary: raw.length ? `Scripted findings on ${request.subject}.` : `Nothing to ask on ${request.subject}.`, findings: raw })
      return {
        model: "scripted",
        finishReason: "tool_calls",
        usage: { ...NO_USAGE, promptTokens: 9000, completionTokens: 40, cost: 0.002 },
        message: { role: "assistant", content: null, tool_calls: [{ id: `call_${request.subject}`, type: "function", function: { name: "submit_findings", arguments: args } }] },
      }
    },
  }
}

/**
 * A scripted digest writer: answers every call with `reply` (an opener and a first
 * move, or raw content) after `delayMs`. `.calls` lists the requests.
 */
export function proseGateway(reply: { opener: string; firstMove: string } | string, delayMs = 0): CountingGateway {
  const calls: ChatRequest[] = []
  return {
    calls,
    async chat(request) {
      calls.push(request)
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
      const content = typeof reply === "string" ? reply : JSON.stringify(reply)
      return { model: "scripted", finishReason: "stop", usage: { ...NO_USAGE, promptTokens: 2000, completionTokens: 120, cost: 0.001 }, message: { role: "assistant", content } }
    },
  }
}

/** A model that is unreachable: every call fails, as behind a blocking proxy. */
export function failingGateway(message: string): CountingGateway {
  const calls: ChatRequest[] = []
  return {
    calls,
    async chat(request) {
      calls.push(request)
      throw new GatewayError(`Anthropic request failed: ${message}`)
    },
  }
}

let database: { db: Database; close: () => Promise<void> } | null = null

/** The test database, or null when TEST_DATABASE_URL is not set. Closed after the test file. */
export function testDatabase(): Database | null {
  const url = process.env.TEST_DATABASE_URL
  if (!url) return null
  if (!database) {
    const client = postgres(url, { max: 2, onnotice: () => {} })
    database = { db: drizzle(client), close: () => client.end() }
    after(async () => { await database?.close(); database = null })
  }
  return database.db
}

/** Empties the lesson tables, which reset keeps: a test store starts with nothing learned. */
export async function clearLearning(db: Database): Promise<void> {
  await db.execute(sql.raw(`TRUNCATE ${LEARNING_TABLES.map((table) => `"${getTableName(table)}"`).join(", ")} RESTART IDENTITY`))
}

/** Empties the trace tables, which reset keeps. */
export async function clearTraces(db: Database): Promise<void> {
  await db.execute(sql.raw(`TRUNCATE ${TRACE_TABLES.map((table) => `"${getTableName(table)}"`).join(", ")} RESTART IDENTITY`))
}

/**
 * Registers `name` once per trace store (trace.ts): memory and, with TEST_DATABASE_URL,
 * Postgres, emptied first.
 */
export function eachTraceStore(name: string, body: (store: TraceStore) => Promise<void>): void {
  for (const kind of ["memory", "postgres"] as const) {
    test(`${name} [${kind}]`, { skip: kind === "postgres" && !process.env.TEST_DATABASE_URL ? "set TEST_DATABASE_URL" : false }, async () => {
      if (kind === "memory") return body(createMemoryTraceStore())
      const db = testDatabase()!
      await clearTraces(db)
      await body(createPostgresTraceStore(db))
    })
  }
}

type StoreCase = { name: string; make: () => Promise<EngineStore> | null }

const STORES: StoreCase[] = [
  { name: "memory", make: async () => createMemoryStore() },
  {
    name: "postgres",
    make: () => {
      const db = testDatabase()
      if (!db) return null
      return (async () => {
        const store = createPostgresStore(db)
        await store.reset()
        await clearLearning(db)
        return store
      })()
    },
  },
]

/**
 * Registers `name` once per store. The Postgres run is skipped without TEST_DATABASE_URL.
 * `options.gateway` makes a fresh model per run (e.g. `testGateway`); the body gets it too.
 */
export function eachStore<G extends ModelGateway | null = null>(
  name: string,
  body: (engine: Engine, gateway: G) => Promise<void>,
  options: { gateway?: () => Promise<G>; calls?: () => CallOptions } = {},
): void {
  for (const store of STORES) {
    test(`${name} [${store.name}]`, { skip: store.name === "postgres" && !process.env.TEST_DATABASE_URL ? "set TEST_DATABASE_URL" : false }, async () => {
      const made = store.make()
      if (!made) return
      const gateway = (options.gateway ? await options.gateway() : null) as G
      await body(await testEngine({ store: await made, gateway, calls: options.calls?.() }), gateway)
    })
  }
}
