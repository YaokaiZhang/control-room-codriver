// The engineers' trace pages' data (spec .scratch/traceability, issue 04): one order's
// timeline with every line linked to its parent, and one run with its prompt, lessons
// and model calls. Offline: the scripted reviewer under a traced gateway.

import assert from "node:assert/strict"
import { test } from "node:test"
import { createPostgresTraceStore } from "@/lib/reviewer/postgres-trace"
import { NO_USAGE, type ChatRequest, type ModelGateway } from "@/lib/reviewer/gateway"
import { createMemoryTraceStore, createTracedGateway, startRun, type TraceStore } from "@/lib/reviewer/trace"
import { addLessonCandidate, createLessonFeeds } from "./lessons"
import { createMemoryStore } from "./memory"
import { createPostgresStore } from "./postgres"
import type { EngineStore } from "./store"
import { clearLearning, clearTraces, testDatabase, testEngine, testGateway } from "./testing"
import { findOrder, orderTrace, runHref, runTrace, type TraceLine } from "./trace-view"

const NOW = "2026-10-21T09:00:00.000Z"

const STORES: { name: string; make: () => Promise<{ store: EngineStore; traces: TraceStore }> }[] = [
  { name: "memory", make: async () => ({ store: createMemoryStore(), traces: createMemoryTraceStore() }) },
  {
    name: "postgres",
    make: async () => {
      const db = testDatabase()!
      const store = createPostgresStore(db)
      await store.reset()
      await clearLearning(db)
      await clearTraces(db)
      return { store, traces: createPostgresTraceStore(db) }
    },
  },
]

const hrefs = (line: TraceLine) => line.links.map((link) => link.href)
const linkTo = (line: TraceLine, label: string) => line.links.find((link) => link.label === label)

for (const kind of STORES) {
  const skip = kind.name === "postgres" && !process.env.TEST_DATABASE_URL ? "set TEST_DATABASE_URL" : false

  test(`an order's timeline: runs, findings, proposal events, effects and mistakes, oldest first, each linked to its parent [${kind.name}]`, { skip }, async () => {
    const { store, traces } = await kind.make()
    const gateway = createTracedGateway(await testGateway(), traces, { log: () => {} })
    const engine = await testEngine({ store, gateway })
    await engine.apply({ type: "review" })
    const before = (await engine.state()).orders.find((order) => order.reference === "CD-420089")!
    const firstRun = before.review.runId!
    const question = before.proposals.find((proposal) => proposal.kind === "operator_question")!
    await engine.apply({ type: "answerQuestion", proposalId: question.id, answer: "No: the driver starts from Helsinki." })
    const other = (await engine.state()).orders.find((row) => row.reference === "CD-420437")!
    await engine.apply({ type: "dismiss", proposalId: other.proposals[0].id, note: "Already sorted by phone" })
    await gateway.flush()

    const state = await engine.state()
    const order = findOrder(state.orders, "CD-420089")!
    assert.equal(findOrder(state.orders, order.id), order, "found by id or reference")
    assert.equal(findOrder(state.orders, "nope"), null)
    const trace = await orderTrace({ order, snapshotAt: state.snapshotAt, store, traces })
    const index = (id: string) => trace.lines.findIndex((line) => line.id === id)
    const line = (id: string) => trace.lines[index(id)]

    // Both review runs, each opening its run page.
    const runs = trace.lines.filter((row) => row.kind === "run")
    assert.ok(runs.length >= 2)
    assert.ok(runs.every((row) => row.job === "reviewer" && hrefs(row).includes(runHref(row.id))))
    const secondRun = order.review.runId!
    assert.notEqual(secondRun, firstRun)

    // The current review's findings name its run.
    const findings = trace.lines.filter((row) => row.kind === "finding")
    assert.deepEqual(findings.map((row) => row.id), order.review.findings.map((finding) => finding.id))
    for (const finding of findings) assert.equal(linkTo(finding, "run")?.href, runHref(secondRun))

    // The answer: proposal event -> finding and the run it was drafted from; effect -> proposal.
    const events = trace.lines.filter((row) => row.kind === "proposal" && row.proposalId === question.id)
    assert.deepEqual(events.map((row) => row.event), ["proposed", "answered"])
    assert.equal(events[0].id, question.id, "a proposal's first line carries its id")
    for (const event of events) {
      assert.equal(linkTo(event, "run")?.href, runHref(firstRun))
      assert.ok(linkTo(event, "finding"), "names its finding")
    }
    const effect = trace.lines.find((row) => row.kind === "effect")!
    assert.equal(linkTo(effect, "proposal")?.href, `#${question.id}`)

    // Oldest first: the first run, the answer and its effect, then the re-review and its findings.
    assert.ok(index(firstRun) < index(question.id))
    assert.ok(index(question.id) < index(events[1].id))
    assert.ok(index(events[1].id) < index(effect.id))
    assert.ok(index(effect.id) < index(secondRun))
    if (findings.length) assert.ok(index(secondRun) < index(findings[0].id))
    assert.equal(line(firstRun).kind, "run")

    // A mistake links to its run, its finding and its row on /dev/learning.
    const dismissed = (await engine.state()).orders.find((row) => row.reference === "CD-420437")!
    const otherTrace = await orderTrace({ order: dismissed, snapshotAt: state.snapshotAt, store, traces })
    const mistake = otherTrace.lines.find((row) => row.kind === "mistake")!
    assert.equal(linkTo(mistake, "run")?.href, runHref(dismissed.review.runId!))
    assert.ok(linkTo(mistake, "finding"))
    assert.equal(linkTo(mistake, "learning")?.href, `/dev/learning#${mistake.id}`)
    const dismissal = otherTrace.lines.find((row) => row.kind === "proposal" && row.event === "dismissed")!
    assert.ok(otherTrace.lines.indexOf(dismissal) < otherTrace.lines.indexOf(mistake))
  })

  test(`a run's page: metadata, parent and children, lessons, prompt text and every turn rebuilt [${kind.name}]`, { skip }, async () => {
    const { store, traces } = await kind.make()
    const lesson = await addLessonCandidate(store, {
      agent: "reviewer", text: "Check whether the operator already settled a note before asking about it.", explanation: "Two dismissals said so.",
      appliesTo: [], sourceMistakeIds: [], evalBefore: null, evalAfter: null,
    }, { now: NOW })
    await store.appendLessonEvents([{ lessonId: lesson.id, at: NOW, by: "operator", kind: "approved", text: "" }])
    const gateway = createTracedGateway(await testGateway(), traces, { log: () => {} })
    const engine = await testEngine({ store, gateway, lessons: createLessonFeeds(store, 0).reviewer })
    await engine.apply({ type: "review" })
    await gateway.flush()
    const order = (await engine.state()).orders.find((row) => row.reference === "CD-420089")!

    const view = (await runTrace(order.review.runId!, { store, traces }))!
    assert.equal(view.run.job, "reviewer")
    assert.equal(view.run.subject, "CD-420089")
    assert.equal(view.subjectHref, "/dev/trace/CD-420089")
    assert.deepEqual(view.lessons.map((row) => [row.id, row.text, row.href]), [[lesson.id, lesson.text, `/dev/learning#${lesson.id}`]])
    assert.ok(view.prompt?.includes(lesson.text), "the prompt as sent, lessons rendered in")
    assert.ok(view.calls.length >= 1)
    assert.deepEqual(view.calls.map((call) => call.turn), view.calls.map((_, at) => at + 1))
    for (const call of view.calls) {
      assert.equal(call.rebuildError, null)
      assert.equal(call.request.messagesFrom, undefined, "rebuilt in full")
      assert.deepEqual(call.request.messages[0], { role: "system", promptHash: view.run.promptHash })
    }
    assert.equal(view.parent, null)
    assert.deepEqual(view.children, [])
    assert.equal(await runTrace("run-missing", { store, traces }), null)
  })
}

test("a run's parent and children; turns carried on from the turn before are rebuilt in full", async () => {
  const store = createMemoryStore()
  const traces = createMemoryTraceStore()
  let turn = 0
  const inner: ModelGateway = {
    async chat(_request: ChatRequest) {
      turn += 1
      return { model: "m", finishReason: "stop", usage: { ...NO_USAGE, cost: 0.001 }, message: { role: "assistant", content: `reply ${turn}` } }
    },
  }
  const gateway = createTracedGateway(inner, traces, { log: () => {} })
  const parent = startRun(gateway, { job: "distil", subject: "group", model: "m", prompt: "distil prompt" })
  const child = startRun(parent.gateway, { job: "judge", subject: "CD-1", model: "m" })
  const first = [{ role: "system" as const, content: "judge prompt" }, { role: "user" as const, content: "one" }]
  const reply = await child.gateway.chat({ job: "judge", subject: "CD-1", model: "m", messages: first })
  await child.gateway.chat({ job: "judge", subject: "CD-1", model: "m", messages: [...first, reply.message, { role: "user", content: "two" }] })
  await child.finish({ outcome: "ok" })
  await parent.finish({ outcome: "ok" })

  const up = (await runTrace(parent.id!, { store, traces }))!
  assert.deepEqual(up.children.map((row) => row.id), [child.id])
  assert.equal(up.prompt, "distil prompt")
  assert.equal(up.subjectHref, "/dev/learning")
  const down = (await runTrace(child.id!, { store, traces }))!
  assert.equal(down.parent?.id, parent.id)
  assert.equal(down.calls.length, 2)
  assert.equal(down.calls[1].stored.messagesFrom, 3, "stored as what the turn adds")
  assert.equal(down.calls[1].request.messages.length, 4, "shown in full")
  assert.deepEqual(down.calls[1].response?.message, { role: "assistant", content: "reply 2" })
  assert.equal(down.lessons.length, 0)
})

test("an untraced review: its findings and proposal events say not traced", async () => {
  const store = createMemoryStore()
  const traces = createMemoryTraceStore()
  const engine = await testEngine({ store, gateway: await testGateway() })
  await engine.apply({ type: "review" })
  const order = (await engine.state()).orders.find((row) => row.reference === "CD-420437")!
  await engine.apply({ type: "dismiss", proposalId: order.proposals[0].id, note: "Already sorted by phone" })
  const state = await engine.state()
  const trace = await orderTrace({ order: findOrder(state.orders, order.id)!, snapshotAt: state.snapshotAt, store, traces })
  assert.equal(trace.lines.filter((row) => row.kind === "run").length, 0)
  const finding = trace.lines.find((row) => row.kind === "finding")
  if (finding) assert.deepEqual(linkTo(finding, "run"), { label: "run", href: null, note: "not traced" })
  const event = trace.lines.find((row) => row.kind === "proposal" && row.event === "dismissed")!
  assert.deepEqual(linkTo(event, "run"), { label: "run", href: null, note: "not traced" })
  const mistake = trace.lines.find((row) => row.kind === "mistake")!
  assert.deepEqual(linkTo(mistake, "run"), { label: "run", href: null, note: "not traced" })
})
