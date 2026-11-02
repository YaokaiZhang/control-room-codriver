// What happened after a lesson was approved (spec .scratch/traceability, issue 05):
// plain arrays in, numbers out. No store, no model.

import assert from "node:assert/strict"
import { test } from "node:test"
import type { AgentRunRow } from "@/lib/reviewer/trace"
import type { DistilRun } from "./distil"
import { lessonImpacts, per100, type ImpactLesson } from "./lesson-impact"
import type { Mistake } from "./mistakes"

const KEY = "reviewer/rule:R7/contact:paying_customer"
const TAGS = ["contact:paying_customer", "rule:R7"]
const OTHER_TAGS = ["contact:driver", "rule:R3"]
const LESSON = "lsn-aaaaaaaaaaaa"

const day = (d: number, h = 9) => `2026-10-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:00:00.000Z`

let n = 0
function run(over: Partial<AgentRunRow> = {}): AgentRunRow {
  n += 1
  return {
    id: `run-${n}`, job: "reviewer", subject: "CD-1", parentRunId: null, promptVersion: "v", promptHash: "h", model: "m", lessonIds: [],
    inputHash: null, startedAt: day(20), finishedAt: day(20, 10), outcome: "ok", usage: null, cost: 0, ...over,
  }
}

function mistake(over: Partial<Mistake> = {}): Mistake {
  n += 1
  return {
    id: `rv-${n}`, agent: "reviewer", orderId: "ord-1", at: day(21), recordedAt: day(20, 11), operator: "operator", promptVersion: "v", model: "m",
    kind: "dismissed", tags: TAGS, input: null, agentOutput: null, operatorNote: "n", editDiff: null, validatorReason: null, restatement: "r",
    status: "usable", unusableReason: null, caseFile: null, runId: null, findingId: null, ...over,
  }
}

function distilRun(over: Partial<DistilRun> = {}): DistilRun {
  return {
    id: "dst-1", group: KEY, startedAt: day(10), finishedAt: day(10), outcome: "candidate", lessonId: LESSON, mistakeIds: [], cost: 0, detail: "",
    gate: null, agentRunId: null, ...over,
  }
}

function lesson(events: { kind: "approved" | "retired"; at: string }[] = [], over: Partial<ImpactLesson> = {}): ImpactLesson {
  return { id: LESSON, sourceMistakeIds: [], history: events.map((event) => ({ lessonId: LESSON, by: "operator", text: "", ...event })), ...over }
}

test("per 100 reviews: no reviews gives null, not a division by zero", () => {
  assert.equal(per100(0, 0), null)
  assert.equal(per100(3, 0), null)
  assert.equal(per100(1, 4), 25)
  assert.equal(per100(0, 7), 0)
})

test("approved lesson: injected runs, before and after rates, mistakes despite the lesson", () => {
  // Before approval (day 15): 4 reviews, 2 mistakes in the group (one traced, one not) and one in another group.
  const before = [run({ startedAt: day(11) }), run({ startedAt: day(12) }), run({ startedAt: day(13) }), run({ startedAt: day(14) })]
  // After: 2 reviews with the lesson, 1 without (its tags didn't match).
  const withLesson = [run({ startedAt: day(16), lessonIds: [LESSON] }), run({ startedAt: day(17), lessonIds: ["lsn-other", LESSON] })]
  const without = run({ startedAt: day(18) })
  const mistakes = [
    mistake({ runId: before[0].id, recordedAt: day(20) }), // recorded after approval, but its review ran before: counts before
    mistake({ runId: null, recordedAt: day(13, 12) }),
    mistake({ runId: before[1].id, tags: OTHER_TAGS }),
    mistake({ runId: withLesson[1].id, recordedAt: day(17, 12) }), // despite
    mistake({ runId: without.id, recordedAt: day(18, 12) }), // after, but its review did not have the lesson
    mistake({ runId: null, recordedAt: day(19) }), // after, untraced: counts, never despite
    mistake({ runId: withLesson[0].id, status: "pending" }), // not usable: not in the group
  ]
  const [impact] = lessonImpacts({
    lessons: [lesson([{ kind: "approved", at: day(15) }])], distilRuns: [distilRun()], reviewerRuns: [...before, ...withLesson, without], mistakes,
  })
  assert.deepEqual(impact.groups, [KEY])
  assert.equal(impact.injected.count, 2)
  assert.deepEqual(impact.injected.runIds, [withLesson[1].id, withLesson[0].id])
  assert.deepEqual(impact.before, { from: null, to: day(15), runs: 4, mistakes: 2, per100: 50 })
  assert.deepEqual(impact.after, { from: day(15), to: null, runs: 3, mistakes: 3, per100: 100 })
  assert.deepEqual(impact.despite, [mistakes[3].id])
})

test("never approved: before covers every review, nothing after, nothing despite", () => {
  const runs = [run({ startedAt: day(11) }), run({ startedAt: day(12) })]
  const [impact] = lessonImpacts({ lessons: [lesson()], distilRuns: [distilRun()], reviewerRuns: runs, mistakes: [mistake({ runId: runs[0].id })] })
  assert.deepEqual(impact.before, { from: null, to: null, runs: 2, mistakes: 1, per100: 50 })
  assert.equal(impact.after, null)
  assert.equal(impact.injected.count, 0)
  assert.deepEqual(impact.despite, [])
})

test("retired: after ends at retirement", () => {
  const inside = run({ startedAt: day(16), lessonIds: [LESSON] })
  const later = run({ startedAt: day(19) })
  const mistakes = [mistake({ runId: inside.id }), mistake({ runId: later.id }), mistake({ runId: null, recordedAt: day(20) })]
  const [impact] = lessonImpacts({
    lessons: [lesson([{ kind: "approved", at: day(15) }, { kind: "retired", at: day(18) }])], distilRuns: [distilRun()], reviewerRuns: [inside, later], mistakes,
  })
  assert.deepEqual(impact.after, { from: day(15), to: day(18), runs: 1, mistakes: 1, per100: 100 })
  assert.deepEqual(impact.before, { from: null, to: day(15), runs: 0, mistakes: 0, per100: null })
  assert.deepEqual(impact.despite, [mistakes[0].id])
})

test("no reviews at all: counts are zero and rates null", () => {
  const [impact] = lessonImpacts({
    lessons: [lesson([{ kind: "approved", at: day(15) }])], distilRuns: [distilRun()], reviewerRuns: [], mistakes: [mistake({ recordedAt: day(16) })],
  })
  assert.deepEqual(impact.before, { from: null, to: day(15), runs: 0, mistakes: 0, per100: null })
  assert.deepEqual(impact.after, { from: day(15), to: null, runs: 0, mistakes: 1, per100: null })
  assert.equal(impact.injected.count, 0)
})

test("only finished, top-level reviewer runs count: no gate reviews, failed or running runs", () => {
  const counted = run({ startedAt: day(16), lessonIds: [LESSON] })
  const runs = [
    counted,
    run({ startedAt: day(16), lessonIds: [LESSON], parentRunId: "run-distil" }), // the gate's review
    run({ startedAt: day(16), lessonIds: [LESSON], finishedAt: null, outcome: "running" }),
    run({ startedAt: day(16), lessonIds: [LESSON], outcome: "failed: bad json" }),
    run({ startedAt: day(16), lessonIds: [LESSON], job: "judge" }),
  ]
  const [impact] = lessonImpacts({ lessons: [lesson([{ kind: "approved", at: day(15) }])], distilRuns: [distilRun()], reviewerRuns: runs, mistakes: [] })
  assert.deepEqual(impact.injected.runIds, [counted.id])
  assert.equal(impact.after?.runs, 1)
})

test("a lesson with no distil run takes its source mistakes' groups", () => {
  const source = mistake({ tags: OTHER_TAGS })
  const inGroup = mistake({ tags: OTHER_TAGS, recordedAt: day(12) })
  const elsewhere = mistake({ recordedAt: day(12) })
  const [impact] = lessonImpacts({
    lessons: [lesson([], { sourceMistakeIds: [source.id] })], distilRuns: [], reviewerRuns: [run({ startedAt: day(11) })], mistakes: [source, inGroup, elsewhere],
  })
  assert.deepEqual(impact.groups, ["reviewer/rule:R3/contact:driver"])
  assert.equal(impact.before.mistakes, 2)
})

test("a lesson with no group counts runs but no mistakes", () => {
  const [impact] = lessonImpacts({ lessons: [lesson([{ kind: "approved", at: day(15) }])], distilRuns: [], reviewerRuns: [run({ startedAt: day(16) })], mistakes: [mistake()] })
  assert.deepEqual(impact.groups, [])
  assert.deepEqual(impact.after, { from: day(15), to: null, runs: 1, mistakes: 0, per100: 0 })
})
