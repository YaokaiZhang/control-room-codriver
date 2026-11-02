// The chain (spec .scratch/traceability, issue 03): from an effect on an order back to
// the proposal it came from, the finding, the review run, the lessons in that run's
// prompt and the mistakes those lessons were written from. Offline: the scripted
// reviewer (CD-420089's operator question) under a traced gateway.

import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import { createPostgresTraceStore } from "@/lib/reviewer/postgres-trace"
import { createMemoryTraceStore, createTracedGateway, type TraceStore } from "@/lib/reviewer/trace"
import { addLessonCandidate, createLessonFeeds } from "./lessons"
import { createMemoryStore } from "./memory"
import type { Mistake } from "./mistakes"
import { createPostgresStore } from "./postgres"
import type { EngineStore } from "./store"
import { clearLearning, clearTraces, testDatabase, testEngine, testGateway } from "./testing"

const NOW = "2026-10-21T09:00:00.000Z"

function mistake(): Mistake {
  return {
    id: `rv-${randomUUID()}`, agent: "reviewer", orderId: "ord-test", at: NOW, recordedAt: NOW, operator: "operator", promptVersion: "v", model: "m",
    kind: "dismissed", tags: ["contact:operator", "proposal:operator_question"], input: null, agentOutput: null, operatorNote: "Not needed",
    editDiff: null, validatorReason: null, restatement: "The agent asked the operator about a note that was already settled.", status: "usable",
    unusableReason: null, caseFile: null, runId: null, findingId: null,
  }
}

const STORES: { name: string; make: () => Promise<{ store: EngineStore; traces: TraceStore }> | null }[] = [
  { name: "memory", make: async () => ({ store: createMemoryStore(), traces: createMemoryTraceStore() }) },
  {
    name: "postgres",
    make: () => {
      const db = testDatabase()
      if (!db) return null
      return (async () => {
        const store = createPostgresStore(db)
        await store.reset()
        await clearLearning(db)
        await clearTraces(db)
        return { store, traces: createPostgresTraceStore(db) }
      })()
    },
  },
]

for (const kind of STORES) {
  test(`from an effect: proposal -> finding -> review run -> lessons -> their source mistakes [${kind.name}]`, { skip: kind.name === "postgres" && !process.env.TEST_DATABASE_URL ? "set TEST_DATABASE_URL" : false }, async () => {
    const { store, traces } = (await kind.make())!
    // A lesson written from a mistake, approved: every review's prompt gets it.
    const source = mistake()
    await store.appendMistakes([source])
    const lesson = await addLessonCandidate(store, {
      agent: "reviewer", text: "Check whether the operator already settled a note before asking about it.", explanation: "Two dismissals said so.",
      appliesTo: [], sourceMistakeIds: [source.id], evalBefore: null, evalAfter: null,
    }, { now: NOW })
    await store.appendLessonEvents([{ lessonId: lesson.id, at: NOW, by: "operator", kind: "approved", text: "" }])

    const gateway = createTracedGateway(await testGateway(), traces, { log: () => {} })
    const engine = await testEngine({ store, gateway, lessons: createLessonFeeds(store, 0).reviewer })
    await engine.apply({ type: "review" })
    const before = (await engine.state()).orders.find((order) => order.reference === "CD-420089")!
    assert.ok(before.review.runId?.startsWith("run-"), "the order's review names its run")
    const question = before.proposals.find((proposal) => proposal.kind === "operator_question")!
    assert.equal(question.runId, before.review.runId)

    const after = await engine.apply({ type: "answerQuestion", proposalId: question.id, answer: "No: the driver starts from Helsinki." })
    await gateway.flush()
    const order = after.orders.find((row) => row.id === question.orderId)!
    const effect = order.effects.find((row) => row.type === "operator_answer_recorded")!

    // effect -> proposal (its source) -> finding and run (on the proposal's events)
    const events = (await store.readProposalEvents()).filter((event) => event.proposalId === effect.source)
    assert.deepEqual(events.map((event) => event.kind), ["answered"])
    const { runId, findingId } = events[0].data!
    assert.equal(findingId, question.findingId)
    assert.equal(runId, before.review.runId, "the run of the review the proposal was drafted from, not the re-review the answer started")
    assert.notEqual(order.review.runId, runId)
    assert.ok(before.review.findings.some((finding) => finding.id === findingId))

    // run -> lessons in its prompt -> the mistakes they came from
    const run = (await traces.readRun(runId!))!
    assert.equal(run.job, "reviewer")
    assert.equal(run.subject, "CD-420089")
    assert.deepEqual(run.lessonIds, [lesson.id])
    const lessons = (await store.readLessons()).filter((row) => run.lessonIds.includes(row.id))
    assert.deepEqual(lessons.flatMap((row) => row.sourceMistakeIds), [source.id])
    assert.ok((await store.readMistakes()).some((row) => row.id === source.id))

    // A mistake on a reviewer proposal names its run and finding too.
    const other = after.orders.find((row) => row.reference === "CD-420437")!
    const dismissed = other.proposals[0]
    await engine.apply({ type: "dismiss", proposalId: dismissed.id, note: "Already sorted by phone" })
    const recorded = (await store.readMistakes()).find((row) => row.id !== source.id)!
    assert.deepEqual([recorded.runId, recorded.findingId], [other.review.runId, dismissed.findingId])
    assert.ok(recorded.runId?.startsWith("run-"))
    const [event] = (await store.readProposalEvents()).filter((row) => row.proposalId === dismissed.id)
    assert.deepEqual([event.data?.runId, event.data?.findingId, event.data?.draft?.runId], [other.review.runId, dismissed.findingId, other.review.runId])
  })
}

test("an untraced review: proposal events and mistakes carry the finding and a null run", async () => {
  const store = createMemoryStore()
  const engine = await testEngine({ store, gateway: await testGateway() })
  await engine.apply({ type: "review" })
  const order = (await engine.state()).orders.find((row) => row.reference === "CD-420437")!
  assert.equal(order.review.runId, null)
  const proposal = order.proposals[0]
  await engine.apply({ type: "dismiss", proposalId: proposal.id, note: "Already sorted by phone" })
  const [found] = await engine.mistakes()
  assert.deepEqual([found.runId, found.findingId], [null, proposal.findingId])
  const [event] = await store.readProposalEvents()
  assert.deepEqual([event.data?.runId, event.data?.findingId], [null, proposal.findingId])
})
