// Lessons: candidates seeded by hand (no distiller, no model calls), the operator's
// decisions and the cap, the Briefing item, and injection into the reviewer and the
// plain words with cache keys that change only when the injected lessons do.

import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { gate } from "@/lib/persona"
import { createMemoryReviewCache, type ReviewCache } from "@/lib/reviewer/cache"
import { loadFixtures, SCENARIO_FIXTURE_DIR } from "@/lib/reviewer/fixtures"
import type { TextPart } from "@/lib/reviewer/gateway"
import { lessonsFor, lessonsHash, MAX_APPROVED_LESSONS, type InjectedLesson } from "@/lib/reviewer/lessons"
import { PROMPT_VERSION, SYSTEM_PROMPT } from "@/lib/reviewer/prompt"
import { createReviewer, DEFAULT_REVIEWER_MODEL } from "@/lib/reviewer/reviewer"
import { createScriptedGateway } from "@/lib/reviewer/scripted"
import { testReviewSource } from "@/lib/reviewer/testing"
import type { Situation } from "@/lib/present/situation"
import type { LessonItem } from "./engine"
import {
  addLessonCandidate, applyLessonAction, createLessonFeeds, decideLesson, foldLessons, mistakeLookup, parseLessonAction, readLessons, sourceMistakes, toInjected,
  type LessonCandidate, type StoredLesson,
} from "./lessons"
import { createMemoryStore } from "./memory"
import { createMemoryPlainCache, createPlainWords, plainKey, PLAIN_VERSION, type PlainItem } from "./plain-words"
import { createPostgresStore } from "./postgres"
import type { EngineStore } from "./store"
import { clearLearning, proseGateway, testDatabase, testEngine, testGateway } from "./testing"

const NOW = "2026-10-21T09:00:00.000Z"
const pg = process.env.TEST_DATABASE_URL ? false : "set TEST_DATABASE_URL"

const candidate = (over: Partial<LessonCandidate> = {}): LessonCandidate => ({
  agent: "reviewer", text: "When a driver's travel starts from home, check the driver's previous duty first.",
  explanation: "Three dismissals said the positioning skipped a duty.", appliesTo: ["R3"], sourceMistakeIds: ["m-1", "m-2", "m-3"],
  evalBefore: 0.71, evalAfter: 0.86, by: "operator", ...over,
})

/** A store with no lessons: reset keeps them, so the Postgres one is emptied by hand. */
async function freshStores(): Promise<{ name: string; store: EngineStore }[]> {
  const stores = [{ name: "memory", store: createMemoryStore() }]
  const db = testDatabase()
  if (db) {
    await clearLearning(db)
    const store = createPostgresStore(db)
    await store.reset()
    stores.push({ name: "postgres", store })
  }
  return stores
}

test("a lesson's status is folded from its events; events that don't fit are ignored", () => {
  const lesson: StoredLesson = { ...candidate(), id: "lsn-a", createdAt: NOW, by: "operator" } as StoredLesson
  const at = (minute: number) => `2026-10-27T10:0${minute}:00.000Z`
  const [folded] = foldLessons([lesson], [
    { lessonId: "lsn-a", at: at(1), by: "operator", kind: "retired", text: "" },
    { lessonId: "lsn-a", at: at(2), by: "operator", kind: "approved", text: "" },
    { lessonId: "lsn-a", at: at(3), by: "operator", kind: "rejected", text: "" },
    { lessonId: "lsn-a", at: at(4), by: "operator", kind: "retired", text: "no longer needed" },
    { lessonId: "lsn-other", at: at(5), by: "operator", kind: "approved", text: "" },
  ])
  assert.equal(folded.status, "retired")
  assert.deepEqual(folded.history.map((event) => event.kind), ["approved", "retired"])
  assert.equal(foldLessons([lesson], [])[0].status, "candidate")
})

test("a candidate is checked in code before it is stored", async () => {
  const store = createMemoryStore()
  await assert.rejects(addLessonCandidate(store, candidate({ text: "x".repeat(301) }), { now: NOW }), /at most 300/)
  await assert.rejects(addLessonCandidate(store, candidate({ text: "Line one.\nLine two." }), { now: NOW }), /line breaks/)
  await assert.rejects(addLessonCandidate(store, candidate({ appliesTo: ["R99"] }), { now: NOW }), /R99 is not a rule id/)
  await assert.rejects(addLessonCandidate(store, candidate({ agent: "plain-words", appliesTo: ["R3"] }), { now: NOW }), /not a card kind/)
  await assert.rejects(addLessonCandidate(store, candidate({ explanation: " " }), { now: NOW }), /explanation/)
  assert.equal((await readLessons(store)).length, 0)
  const words = await addLessonCandidate(store, candidate({ agent: "plain-words", appliesTo: ["decide"] }), { now: NOW })
  assert.equal(words.status, "candidate")
})

for (const pick of ["memory", "postgres"] as const) {
  test(`the operator approves, rejects and retires, each an event with time and actor; lessons survive reset [${pick}]`, { skip: pick === "postgres" && pg }, async () => {
    const store = (await freshStores()).find((row) => row.name === pick)!.store
    const clock = () => new Date("2026-10-27T10:00:00.000Z")
    const kept = await addLessonCandidate(store, candidate(), { now: NOW, clock })
    const dropped = await addLessonCandidate(store, candidate({ text: "Ask the site before the driver." }), { now: NOW, clock })
    assert.equal((await addLessonCandidate(store, candidate(), { now: NOW })).id, kept.id, "the same lesson twice is one lesson")
    assert.deepEqual(kept.sourceMistakeIds, ["m-1", "m-2", "m-3"])
    assert.equal(kept.evalAfter, 0.86)

    await decideLesson(store, { lessonId: kept.id, decision: "approved", clock })
    await decideLesson(store, { lessonId: dropped.id, decision: "rejected", note: "Too broad", clock })
    await assert.rejects(decideLesson(store, { lessonId: dropped.id, decision: "approved" }), /Only a candidate can be approved; this one is rejected/)
    await assert.rejects(decideLesson(store, { lessonId: kept.id, decision: "rejected" }), /this one is approved/)

    await store.reset()
    let lessons = await readLessons(store)
    assert.equal(lessons.length, 2)
    const approved = lessons.find((row) => row.id === kept.id)!
    assert.equal(approved.status, "approved")
    assert.deepEqual(approved.history, [{ lessonId: kept.id, at: "2026-10-27T10:00:00.000Z", by: "operator", kind: "approved", text: "" }])
    assert.equal(lessons.find((row) => row.id === dropped.id)!.history[0].text, "Too broad")

    lessons = await decideLesson(store, { lessonId: kept.id, decision: "retired", clock })
    assert.equal(lessons.find((row) => row.id === kept.id)!.status, "retired")
    await assert.rejects(decideLesson(store, { lessonId: kept.id, decision: "retired" }), /Only an approved lesson can be retired/)
    const db = testDatabase()
    if (pick === "postgres" && db) await clearLearning(db)
  })
}

test("at most 10 approved lessons per agent: the 11th is refused until one retires", async () => {
  const store = createMemoryStore()
  const ids: string[] = []
  for (let n = 0; n <= MAX_APPROVED_LESSONS; n += 1) ids.push((await addLessonCandidate(store, candidate({ text: `Lesson number ${n}.` }), { now: NOW })).id)
  for (const id of ids.slice(0, MAX_APPROVED_LESSONS)) await decideLesson(store, { lessonId: id, decision: "approved" })
  await assert.rejects(decideLesson(store, { lessonId: ids[MAX_APPROVED_LESSONS], decision: "approved" }), /The reviewer already has 10 approved lessons\. Retire one first\./)

  // The other agent has its own ten.
  const words = await addLessonCandidate(store, candidate({ agent: "plain-words", appliesTo: [] }), { now: NOW })
  await decideLesson(store, { lessonId: words.id, decision: "approved" })

  await decideLesson(store, { lessonId: ids[0], decision: "retired" })
  const lessons = await decideLesson(store, { lessonId: ids[MAX_APPROVED_LESSONS], decision: "approved" })
  assert.equal(lessons.filter((row) => row.agent === "reviewer" && row.status === "approved").length, MAX_APPROVED_LESSONS)
})

test("the lessons API takes approve, reject and retire, and only the operator reaches it", async () => {
  assert.equal(parseLessonAction(null), null)
  assert.equal(parseLessonAction({ action: "delete", lessonId: "lsn-1" }), null)
  assert.equal(parseLessonAction({ action: "approve" }), null)
  assert.deepEqual(parseLessonAction({ action: "reject", lessonId: "lsn-1", note: "no", extra: 1 }), { action: "reject", lessonId: "lsn-1", note: "no" })

  const store = createMemoryStore()
  const lesson = await addLessonCandidate(store, candidate(), { now: NOW })
  const approved = await applyLessonAction(store, { action: "approve", lessonId: lesson.id })
  assert.equal(approved[0].status, "approved")
  assert.equal(approved[0].history[0].by, "operator")
  assert.equal((await applyLessonAction(store, { action: "retire", lessonId: lesson.id }))[0].status, "retired")
  await assert.rejects(applyLessonAction(store, { action: "approve", lessonId: "lsn-missing" }), /Unknown lesson/)

  assert.deepEqual(gate("operator", "/api/lessons"), { kind: "allow" })
  assert.deepEqual(gate("site", "/api/lessons"), { kind: "deny", status: 403 })
  assert.deepEqual(gate("driver", "/api/lessons"), { kind: "deny", status: 403 })
  assert.deepEqual(gate(null, "/api/lessons"), { kind: "deny", status: 401 })
})

test("a new candidate brings a Briefing item linking to it, and it comes back after a reset while it waits", async () => {
  const store = createMemoryStore()
  const engine = await testEngine({ store })
  const lesson = await addLessonCandidate(store, candidate(), { now: NOW })
  const items = (state: Awaited<ReturnType<typeof engine.state>>) => state.briefing.items.filter((item): item is LessonItem => item.kind === "lesson")

  let [item] = items(await engine.state())
  assert.equal(item.title, "A new lesson needs your yes")
  assert.equal(item.href, `/rules#lesson-${lesson.id}`)
  assert.equal(item.text, lesson.text)
  assert.equal(item.at, NOW)
  await addLessonCandidate(store, candidate(), { now: NOW })
  assert.equal(items(await engine.apply({ type: "deliverBriefing" })).length, 1, "at most once per lesson")

  await engine.apply({ type: "reset" })
  ;[item] = items(await engine.apply({ type: "deliverBriefing" }))
  assert.equal(item?.lessonId, lesson.id)

  await decideLesson(store, { lessonId: lesson.id, decision: "approved" })
  assert.equal(items(await engine.state())[0].read, true, "deciding answers the item")
  await engine.apply({ type: "reset" })
  assert.equal(items(await engine.apply({ type: "deliverBriefing" })).length, 0, "a decided lesson needs no yes")
})

const injected = (id: string, appliesTo: string[], text = `Lesson ${id}.`): InjectedLesson => ({ id, text, appliesTo })

test("a call gets the lessons tagged with its tags, and the untagged ones", () => {
  const lessons = [injected("b", ["R3"]), injected("a", []), injected("c", ["R12", "R7"]), injected("d", ["decide"])]
  assert.deepEqual(lessonsFor(lessons, ["R7"]).map((row) => row.id), ["a", "c"])
  assert.deepEqual(lessonsFor(lessons, ["R3", "R12"]).map((row) => row.id), ["a", "b", "c"])
  assert.deepEqual(lessonsFor(lessons, []).map((row) => row.id), ["a"])
  assert.equal(lessonsHash([]), "")
  assert.equal(lessonsHash([lessons[0], lessons[1]]), lessonsHash([lessons[1], lessons[0]]))
  assert.notEqual(lessonsHash([lessons[0]]), lessonsHash([{ ...lessons[0], text: "Changed." }]))
  assert.equal(lessonsFor(Array.from({ length: 12 }, (_, n) => injected(`l${n}`, [])), []).length, MAX_APPROVED_LESSONS)
})

/** A review cache that remembers the keys asked for. */
function keyedCache(): ReviewCache & { keys: string[] } {
  const inner = createMemoryReviewCache()
  const keys: string[] = []
  return { keys, get: (key) => { keys.push(key); return inner.get(key) }, put: (key, result) => inner.put(key, result) }
}

test("the reviewer: no lessons keep today's key; a matching lesson follows the cached prompt as its own block and changes the key", async () => {
  const fixtures = await loadFixtures(SCENARIO_FIXTURE_DIR)
  const source = await testReviewSource()
  const model = process.env.REVIEWER_MODEL ?? DEFAULT_REVIEWER_MODEL
  const input = { now: NOW, rules: [{ rule: "R3", status: "failed" as const, summary: "Positioning skips a duty." }, { rule: "R7", status: "passed" as const, summary: "ok" }] }
  const run = async (lessons: InjectedLesson[]) => {
    const gateway = createScriptedGateway(fixtures)
    const cache = keyedCache()
    const result = await createReviewer({ gateway, source, cache, lessons: async () => lessons }).review("CD-420516", input)
    return { result, key: cache.keys[0], system: gateway.calls[0]?.messages[0].content as TextPart[] }
  }

  const none = await run([])
  assert.equal(none.key, createHash("sha256").update(`${PROMPT_VERSION}\n${model}\n${none.result.hash}`).digest("hex"), "the key from before lessons existed")
  assert.equal(none.system.length, 1)

  const elsewhere = await run([injected("x", ["R7"]), injected("y", ["R12"])])
  assert.equal(elsewhere.key, none.key, "lessons for rules this order passes change nothing")
  assert.equal(elsewhere.system.length, 1)

  const matching = await run([injected("x", ["R3"], "Check the driver's previous duty first."), injected("y", ["R12"])])
  assert.notEqual(matching.key, none.key)
  assert.equal(matching.system.length, 2)
  assert.equal(matching.system[0].text, SYSTEM_PROMPT)
  assert.deepEqual(matching.system[0].cache_control, { type: "ephemeral" })
  assert.match(matching.system[1].text, /^Lessons the operator approved/)
  assert.match(matching.system[1].text, /- Check the driver's previous duty first\./)
  assert.doesNotMatch(matching.system[1].text, /Lesson y/)
  assert.equal(matching.system[1].cache_control, undefined)

  assert.equal((await run([injected("z", [])])).system.length, 2, "an untagged lesson applies to every order")
})

test("approving a lesson re-reviews only the orders it applies to", async () => {
  let lessons: InjectedLesson[] = []
  const gateway = await testGateway()
  const cache = createMemoryReviewCache()
  const engine = await testEngine({ gateway, reviewCache: cache, lessons: async () => lessons })
  await engine.apply({ type: "review" })
  const before = await engine.state()
  assert.equal(before.reviews.notReviewed, 0)
  const calls = gateway.calls.length

  // A rule some orders fail at the review time (the start), but not all.
  const failing = (ruleId: string) => before.orders.filter((row) => row.rules.some((rule) => rule.id === ruleId && rule.outcome === "fail")).map((row) => row.id)
  const ruleId = ["R11", "R1", "R12", "R13", "R10", "R3", "R7"].find((id) => failing(id).length > 0 && failing(id).length < before.orders.length)!
  assert.ok(ruleId, "some rule fails on some orders")
  lessons = [injected("lsn-1", [ruleId])]

  const after = await engine.state()
  const stale = after.orders.filter((row) => row.review.status === "not_reviewed").map((row) => row.id).sort()
  assert.deepEqual(stale, failing(ruleId).sort())
  await engine.apply({ type: "review" })
  assert.equal(gateway.calls.filter((call) => call.job === "reviewer").length - calls >= stale.length, true)
  assert.equal((await engine.state()).reviews.notReviewed, 0)

  lessons = []
  const back = await engine.state()
  assert.equal(back.reviews.notReviewed, 0, "without the lesson the earlier reviews hit again")
})

const situation = (headline: string, body: string | null): Situation => ({ headline, body, step: null, others: [] })
const decide: PlainItem = { kind: "decide", situation: situation("Pickup slot passed, nothing collected", "The slot ended 21 Oct 11:00 EEST.") }
const agent: PlainItem = { kind: "agent", situation: situation("Agent is calling the site", null) }

test("plain words: no lessons keep today's key; lessons go to the cards of their kind, batched apart", async () => {
  const { headline, body } = decide.situation
  assert.equal(plainKey(decide, "m"), createHash("sha256").update(JSON.stringify([PLAIN_VERSION, "m", "decide", headline, body])).digest("hex"))
  assert.equal(plainKey(decide, "m", ""), plainKey(decide, "m"))
  assert.notEqual(plainKey(decide, "m", "abc"), plainKey(decide, "m"))

  const lessons = [injected("w1", ["decide"], "Say who to call first.")]
  const gateway = proseGateway(JSON.stringify({ cards: [{ id: "1", headline: "Nobody collected the car", body: null }] }))
  const cache = createMemoryPlainCache()
  const service = createPlainWords({ gateway, cache, model: "m", lessons: async () => lessons })
  await service.fill([decide, agent])
  assert.equal(gateway.calls.length, 2, "a card with lessons and one without are not batched together")
  const systems = gateway.calls.map((call) => String(call.messages[0].content))
  const withLesson = systems.filter((text) => text.includes("- Say who to call first."))
  assert.equal(withLesson.length, 1)
  assert.match(String(gateway.calls[systems.indexOf(withLesson[0])].messages[1].content), /Pickup slot passed/)

  // The decide card is cached under the key with its lesson; the plain key misses.
  assert.equal((await cache.getMany([plainKey(decide, "m", lessonsHash(lessons))])).size, 1)
  assert.equal((await cache.getMany([plainKey(decide, "m")])).size, 0)
})

test("the lesson feeds give each agent its approved lessons, cached until refreshed", async () => {
  const store = createMemoryStore()
  const feeds = createLessonFeeds(store)
  const reviewer = await addLessonCandidate(store, candidate(), { now: NOW })
  await addLessonCandidate(store, candidate({ agent: "plain-words", appliesTo: ["review"] }), { now: NOW })
  assert.deepEqual(await feeds.reviewer(), [])
  await decideLesson(store, { lessonId: reviewer.id, decision: "approved" })
  assert.deepEqual(await feeds.reviewer(), [], "cached")
  feeds.refresh()
  const lessons = await readLessons(store)
  assert.deepEqual(await feeds.reviewer(), [toInjected(lessons.find((row) => row.id === reviewer.id)!)])
  assert.deepEqual(await feeds.plainWords(), [])
})

test("a lesson's sources show the operator's note, the edit or the validator's reason, with the order", async () => {
  const store = createMemoryStore()
  const base = {
    agent: "reviewer" as const, at: "2026-10-21T08:00:00.000Z", recordedAt: "2026-10-21T08:00:00.000Z", operator: "operator",
    promptVersion: "v", model: "m", tags: [], input: null, agentOutput: null, operatorNote: null, editDiff: null,
    validatorReason: null, restatement: null, status: "usable" as const, unusableReason: null, caseFile: null, runId: null, findingId: null,
  }
  await store.appendMistakes([
    { ...base, id: "m-1", orderId: "ord-1", kind: "dismissed", operatorNote: "The site holds the keys", caseFile: { reference: "CD-420001" } as never },
    { ...base, id: "m-2", orderId: "ord-2", kind: "edited", editDiff: { before: "Call the driver", after: "Call the site" } },
    { ...base, id: "m-3", agent: "plain-words", orderId: null, kind: "rejected", validatorReason: "a gendered pronoun" },
  ])
  const sources = await sourceMistakes(["m-1", "m-2", "m-3", "m-gone"], mistakeLookup(store))
  assert.deepEqual(sources, [
    { id: "m-1", note: "The site holds the keys", orderId: "ord-1", reference: "CD-420001" },
    { id: "m-2", note: 'Edited "Call the driver" to "Call the site"', orderId: "ord-2", reference: null },
    { id: "m-3", note: "a gendered pronoun", orderId: null, reference: null },
    { id: "m-gone", note: null, orderId: null, reference: null },
  ])
})
