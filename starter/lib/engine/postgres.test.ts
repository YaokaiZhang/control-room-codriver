// The app runs the engine on the seeded database. These tests need TEST_DATABASE_URL
// (a seeded database of its own, schema pushed) and are skipped without it.

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { test } from "node:test"
import { getTableName, sql, type Table } from "drizzle-orm"
import type { Bundle } from "@/lib/present/bundle"
import { createEngine } from "./engine"
import { addLessonCandidate, decideLesson, readLessons } from "./lessons"
import { createPostgresStore } from "./postgres"
import { createPostgresTraceStore } from "@/lib/reviewer/postgres-trace"
import { createTracedGateway } from "@/lib/reviewer/trace"
import { NO_USAGE } from "@/lib/reviewer/gateway"
import { CACHE_TABLES, ENGINE_TABLES, LEARNING_TABLES, TRACE_TABLES } from "./schema"
import { snapshotFromDatabase } from "./snapshot"
import { clearLearning, clearTraces, testDatabase, testSnapshot } from "./testing"

const skip = process.env.TEST_DATABASE_URL ? false : "set TEST_DATABASE_URL"

/** What a reader of the bundle sees, without the shared lookup maps. */
function summary(bundle: Bundle) {
  return {
    order: bundle.order,
    customer: bundle.customer,
    items: bundle.items,
    alerts: bundle.alerts,
    conversations: bundle.conversations.map((thread) => thread.id),
    messages: bundle.messages.map((message) => message.id),
    events: bundle.events.map((event) => event.id).sort(),
    related: Object.fromEntries(Object.entries(bundle.related).sort(([a], [b]) => a.localeCompare(b))
      .map(([collection, rows]) => [collection, (rows ?? []).map((row) => row.id).sort()])),
    inbox: bundle.inboxThreads.map((thread) => thread.id),
    linked: bundle.bundleOrderRefs,
  }
}

test("the seeded database gives the same bundles as the dataset files", { skip }, async () => {
  const db = testDatabase()!
  const [fromDb, fromFiles] = await Promise.all([snapshotFromDatabase(db), testSnapshot()])
  assert.equal(fromDb.snapshotAt, fromFiles.snapshotAt)
  assert.deepEqual(fromDb.bundles.map(summary), fromFiles.bundles.map(summary))
})

test("reset empties our tables and leaves the snapshot untouched", { skip }, async () => {
  const db = testDatabase()!
  const engine = createEngine({ snapshot: await snapshotFromDatabase(db), store: createPostgresStore(db) })
  await engine.apply({ type: "advanceClock", minutes: 30 })
  await engine.apply({ type: "reset" })
  assert.equal(await engine.clock(), "2026-10-21T09:00:00.000Z")
  const after = await snapshotFromDatabase(db)
  assert.equal(after.bundles.length, 100)
  assert.deepEqual(after.bundles.map(summary), (await testSnapshot()).bundles.map(summary))
})

test("our tables hold no foreign keys, and the starter's seed runs beside them without clearing them", { skip }, async () => {
  const db = testDatabase()!
  const foreignKeys = await db.execute(sql`
    SELECT conname FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
    WHERE c.contype = 'f' AND t.relname LIKE 'cr\_%'`)
  assert.equal(foreignKeys.length, 0)

  const store = createPostgresStore(db)
  await store.reset()
  await store.writeClock("2026-10-21T11:00:00.000Z")
  const seed = spawnSync("npx", ["tsx", "scripts/seed.ts"], {
    // No model key: the seed sweep only reports "not reviewed yet" and calls no model.
    env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL, ANTHROPIC_API_KEY: "" }, encoding: "utf8",
  })
  assert.equal(seed.status, 0, seed.stderr)
  assert.equal(await store.readClock(), "2026-10-21T11:00:00.000Z")
  await store.reset()
})

test("the seed never sweeps orders with the model unless asked with --review, even with a model key set", { skip }, async () => {
  const seed = spawnSync("npx", ["tsx", "scripts/seed.ts"], {
    // A key that is set but not real: a default sweep would start calling the model with it.
    env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL, ANTHROPIC_API_KEY: "not-a-real-key", SEED_REVIEW: "" }, encoding: "utf8",
  })
  assert.equal(seed.status, 0, seed.stderr)
  assert.doesNotMatch(seed.stdout, /reviewing \d+ order/i)
  assert.match(seed.stdout, /--review/, "it says how to opt in")
})

test("lessons and the operator's decisions on them survive reset: they are learning, not engine state", { skip }, async () => {
  const names = (tables: typeof ENGINE_TABLES | typeof CACHE_TABLES | typeof LEARNING_TABLES) => tables.map((table) => getTableName(table))
  for (const name of names(LEARNING_TABLES)) assert.ok(![...names(ENGINE_TABLES), ...names(CACHE_TABLES)].includes(name), name)

  const db = testDatabase()!
  await clearLearning(db)
  const store = createPostgresStore(db)
  const lesson = await addLessonCandidate(store, {
    agent: "plain-words", text: "Name the person to call before the reason.", explanation: "Seeded by hand.",
    appliesTo: ["decide"], sourceMistakeIds: ["m-9"], evalBefore: null, evalAfter: 0.5, by: "operator",
  }, { now: "2026-10-21T09:00:00.000Z" })
  await decideLesson(store, { lessonId: lesson.id, decision: "approved" })
  assert.equal((await store.readBriefing()).filter((item) => item.kind === "lesson").length, 1)
  await store.reset()
  assert.equal((await store.readBriefing()).length, 0)
  const [kept] = await readLessons(store)
  assert.deepEqual({ ...kept, history: kept.history.map((event) => event.kind) }, { ...lesson, status: "approved", history: ["approved"] })
  assert.deepEqual(kept.appliesTo, ["decide"])
  assert.equal(kept.evalBefore, null)
  await clearLearning(db)
})

test("agent runs, model calls and prompt texts survive reset: a trace outlives its demo take", { skip }, async () => {
  const names = (tables: readonly Table[]) => tables.map((table) => getTableName(table))
  for (const name of names(TRACE_TABLES)) assert.ok(![...names(ENGINE_TABLES), ...names(CACHE_TABLES), ...names(LEARNING_TABLES)].includes(name), name)

  const db = testDatabase()!
  await clearTraces(db)
  const traces = createPostgresTraceStore(db)
  const gateway = createTracedGateway({ chat: async () => ({ model: "m", finishReason: "stop", usage: NO_USAGE, message: { role: "assistant", content: "ok" } }) }, traces)
  await gateway.chat({ job: "digest", subject: "digest:12:00", model: "m", messages: [{ role: "system", content: "Write the digest." }] })
  await gateway.flush()
  await createPostgresStore(db).reset()
  const [run] = await traces.readRuns({ subject: "digest:12:00" })
  assert.equal(run.outcome, "ok")
  assert.equal((await traces.readCalls(run.id)).length, 1)
  assert.equal(await traces.readPrompt(run.promptHash!), "Write the digest.")
  await clearTraces(db)
})
