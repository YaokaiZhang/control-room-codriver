import assert from "node:assert/strict"
import { before, test } from "node:test"
import { eachTraceStore } from "@/lib/engine/testing"
import { createAnthropicGateway } from "./anthropic"
import { createMemoryReviewCache } from "./cache"
import { loadFixtures, SCENARIO_FIXTURE_DIR, type Fixture } from "./fixtures"
import { GatewayError, NO_USAGE, type ChatRequest, type ModelGateway } from "./gateway"
import type { InjectedLesson } from "./lessons"
import { PROMPT_VERSION, SYSTEM_PROMPT } from "./prompt"
import { createReviewer, type ReviewResult, type Reviewed } from "./reviewer"
import { createScriptedGateway } from "./scripted"
import { testReviewSource } from "./testing"
import { createMemoryTraceStore, createTracedGateway, hashPrompt, interceptGateway, startRun, type TraceStore } from "./trace"

const NOW = "2026-10-21T09:00:00.000Z"
const quiet = { log: () => {} }

let fixtures: Fixture[] = []

before(async () => {
  fixtures = await loadFixtures(SCENARIO_FIXTURE_DIR)
})

function reviewed(result: ReviewResult): Reviewed {
  assert.equal(result.status, "reviewed", result.status === "not_reviewed" ? result.reason : "")
  return result as Reviewed
}

const request = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  job: "plain-words", subject: "card-1", model: "m", messages: [{ role: "system", content: "Be plain." }, { role: "user", content: "Say it." }], ...over,
})

const replying = (content: string): ModelGateway => ({
  chat: async () => ({ model: "answered", finishReason: "stop", usage: { ...NO_USAGE, promptTokens: 10, completionTokens: 2, cost: 0.001 }, message: { role: "assistant", content } }),
})

eachTraceStore("from a review result: its run, the exact prompt with its lessons rendered in, and the lessons by id", async (store) => {
  const lesson: InjectedLesson = { id: "lsn-a", text: "Check the driver's previous duty first.", appliesTo: [] }
  const gateway = createTracedGateway(createScriptedGateway(fixtures), store, quiet)
  const reviewer = createReviewer({ gateway, source: await testReviewSource(), lessons: async () => [lesson] })
  const result = reviewed(await reviewer.review("CD-420516", { now: NOW }))

  assert.ok(result.runId?.startsWith("run-"))
  assert.equal(result.promptVersion, PROMPT_VERSION)
  assert.deepEqual(result.lessonIds, ["lsn-a"])
  const run = (await store.readRun(result.runId!))!
  assert.deepEqual(
    { job: run.job, subject: run.subject, parent: run.parentRunId, version: run.promptVersion, prompt: run.promptHash, lessons: run.lessonIds, input: run.inputHash, outcome: run.outcome, cost: run.cost },
    { job: "reviewer", subject: "CD-420516", parent: null, version: PROMPT_VERSION, prompt: result.promptHash, lessons: ["lsn-a"], input: result.hash, outcome: "ok", cost: result.cost },
  )
  assert.ok(run.model && run.finishedAt)
  assert.deepEqual(run.usage, result.usage)
  const prompt = (await store.readPrompt(result.promptHash!))!
  assert.equal(hashPrompt(prompt), result.promptHash)
  assert.ok(prompt.startsWith(SYSTEM_PROMPT))
  assert.match(prompt, /- Check the driver's previous duty first\.$/)
})

eachTraceStore("a reviewer with tool calls logs every turn in order under one run, the system prompt by hash", async (store) => {
  const gateway = createTracedGateway(createScriptedGateway(fixtures), store, quiet)
  const result = reviewed(await createReviewer({ gateway, source: await testReviewSource() }).review("CD-420089", { now: NOW }))
  assert.equal(result.toolCalls, 1)
  const calls = await store.readCalls(result.runId!)
  assert.deepEqual(calls.map((call) => call.turn), [1, 2])
  assert.equal(calls.length, result.turns)
  assert.deepEqual(calls[0].request.messages[0], { role: "system", promptHash: result.promptHash })
  assert.equal(calls[0].request.messages.length, 2)
  assert.equal(calls[1].request.messages.length, 4, "the second turn carries the tool call and its result")
  assert.equal(calls[0].response?.message.tool_calls?.[0].function.name, "get_driver_duties")
  assert.equal(calls[1].response?.message.tool_calls?.[0].function.name, "submit_findings")
  assert.equal(calls[0].request.effort, "medium")
  assert.ok(calls[0].request.tools?.length)
  assert.ok(calls.every((call) => call.error === null && call.latencyMs >= 0 && call.usage))
  assert.equal(calls.reduce((sum, call) => sum + call.usage!.cost, 0), result.cost)
  // Nothing outside the review's own run: no one-turn runs for its calls.
  assert.deepEqual((await store.readRuns({ subject: "CD-420089" })).map((run) => run.id), [result.runId])
})

test("a cached review keeps the run that produced it; serving it from the cache writes nothing", async () => {
  const store = createMemoryTraceStore()
  const writes: string[] = []
  const counting: TraceStore = {
    ...store,
    startRun: (row) => { writes.push("run"); return store.startRun(row) },
    finishRun: (id, end) => { writes.push("finish"); return store.finishRun(id, end) },
    addCall: (row) => { writes.push("call"); return store.addCall(row) },
    putPrompt: (hash, text) => { writes.push("prompt"); return store.putPrompt(hash, text) },
  }
  const source = await testReviewSource()
  const cache = createMemoryReviewCache()
  const gateway = createTracedGateway(createScriptedGateway(fixtures), counting, quiet)
  const first = reviewed(await createReviewer({ gateway, source, cache }).review("CD-420516", { now: NOW }))
  const written = writes.length
  assert.ok(written > 0)

  const again = reviewed(await createReviewer({ gateway, source, cache }).review("CD-420516", { now: NOW }))
  const offline = reviewed(await createReviewer({ gateway: null, source, cache }).review("CD-420516", { now: NOW }))
  for (const hit of [again, offline]) {
    assert.equal(hit.cached, true)
    assert.deepEqual([hit.runId, hit.promptHash, hit.lessonIds], [first.runId, first.promptHash, first.lessonIds])
  }
  assert.equal(writes.length, written)
})

test("a review cached before tracing still loads, without a run", async () => {
  const source = await testReviewSource()
  const cache = createMemoryReviewCache()
  const fresh = reviewed(await createReviewer({ gateway: createScriptedGateway(fixtures), source, cache }).review("CD-420516", { now: NOW }))
  // An untraced gateway: no run, but the prompt is still named.
  assert.equal(fresh.runId, null)
  assert.ok(fresh.promptHash)
  const keyOf = { value: "" }
  const spy = { get: async (key: string) => { keyOf.value = key; return null }, put: async () => {} }
  await createReviewer({ gateway: null, source, cache: spy }).review("CD-420516", { now: NOW })
  const { runId: _r, promptVersion: _v, promptHash: _h, lessonIds: _l, ...old } = fresh
  const oldCache = createMemoryReviewCache()
  await oldCache.put(keyOf.value, old)
  const hit = reviewed(await createReviewer({ gateway: null, source, cache: oldCache }).review("CD-420516", { now: NOW }))
  assert.equal(hit.cached, true)
  assert.equal(hit.runId, undefined)
  assert.deepEqual(hit.findings, fresh.findings)
})

eachTraceStore("a call outside any run gets a one-turn run of its own from its job and subject; a failed call keeps its error", async (store) => {
  const ok = createTracedGateway(replying("Plainly."), store, quiet)
  await ok.chat(request())
  await ok.flush()
  const [run] = await store.readRuns({ subject: "card-1" })
  assert.deepEqual({ job: run.job, model: run.model, outcome: run.outcome, cost: run.cost, parent: run.parentRunId }, { job: "plain-words", model: "m", outcome: "ok", cost: 0.001, parent: null })
  assert.equal(await store.readPrompt(run.promptHash!), "Be plain.")
  const [call] = await store.readCalls(run.id)
  assert.deepEqual({ turn: call.turn, reply: call.response?.message.content, model: call.response?.model, error: call.error }, { turn: 1, reply: "Plainly.", model: "answered", error: null })

  const down = createTracedGateway({ chat: async () => { throw new GatewayError("Anthropic request failed: 529") } }, store, quiet)
  await assert.rejects(down.chat(request({ subject: "card-2" })), /529/)
  await down.flush()
  const [failed] = await store.readRuns({ subject: "card-2" })
  assert.equal(failed.outcome, "failed")
  const [lost] = await store.readCalls(failed.id)
  assert.deepEqual({ response: lost.response, usage: lost.usage, error: lost.error }, { response: null, usage: null, error: "Anthropic request failed: 529" })
})

eachTraceStore("a run opened through a run's gateway is its child, also through an intercepting wrapper", async (store) => {
  let seen = 0
  const metered = interceptGateway(createTracedGateway(replying("{}"), store, quiet), async (req, next) => { seen += 1; return next(req) })
  const parent = startRun(metered, { job: "distil", subject: "group-1", model: "m", prompt: "Distil." })
  await parent.gateway.chat(request({ job: "distil", subject: "group-1" }))
  const child = startRun(parent.gateway, { job: "judge", subject: "m-1", model: "m", prompt: "Judge." })
  await child.gateway.chat(request({ job: "judge", subject: "m-1" }))
  await child.finish({ outcome: "fixed" })
  await parent.finish({ outcome: "candidate" })
  assert.equal(seen, 2, "both calls went through the wrapper")
  const runs = await store.readRuns({ parentRunId: parent.id })
  assert.deepEqual(runs.map((run) => [run.id, run.job, run.outcome]), [[child.id, "judge", "fixed"]])
  assert.equal((await store.readRun(parent.id!))?.cost, 0.001, "a run's cost is its own turns'")
  assert.equal((await store.readCalls(parent.id!)).length, 1)
})

test("an untraced gateway gives runs with no id that record nothing", async () => {
  const run = startRun(replying("x"), { job: "judge", subject: "s", model: "m" })
  assert.equal(run.id, null)
  assert.equal((await run.gateway.chat(request())).message.content, "x")
  await run.finish({ outcome: "ok" })
})

test("tracing never breaks an agent: failed writes are logged and swallowed", async () => {
  const broken: TraceStore = {
    ...createMemoryTraceStore(),
    startRun: async () => { throw new Error("relation cr_agent_runs does not exist") },
    finishRun: async () => { throw new Error("down") },
    addCall: async () => { throw new Error("down") },
    putPrompt: async () => { throw new Error("down") },
  }
  const logged: string[] = []
  const gateway = createTracedGateway(createScriptedGateway(fixtures), broken, { log: (line) => logged.push(line) })
  const result = reviewed(await createReviewer({ gateway, source: await testReviewSource() }).review("CD-420516", { now: NOW }))
  assert.equal(result.findings.length, 1)
  assert.ok(logged.some((line) => /cr_agent_runs does not exist/.test(line)))
})

test("the logged request carries no key: the provider adds auth outside it", async () => {
  const store = createMemoryTraceStore()
  const fetch = (async () => new Response(JSON.stringify({
    id: "msg_1", type: "message", role: "assistant", model: "m", stop_reason: "end_turn", stop_sequence: null,
    content: [{ type: "text", text: "done" }], usage: { input_tokens: 10, output_tokens: 2 },
  }), { status: 200, headers: { "content-type": "application/json" } })) as typeof globalThis.fetch
  const gateway = createTracedGateway(createAnthropicGateway({ apiKey: "sk-ant-secret-for-test", fetch }), store, quiet)
  await gateway.chat(request())
  await gateway.flush()
  const [run] = await store.readRuns({ subject: "card-1" })
  const calls = await store.readCalls(run.id)
  assert.equal(calls.length, 1)
  assert.doesNotMatch(JSON.stringify({ run, calls }), /sk-ant-secret-for-test/)
})

test("a reply is handed back without waiting for its trace writes; finish and flush wait for them", async () => {
  const memory = createMemoryTraceStore()
  let release = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  const slow: TraceStore = { ...memory, startRun: async (row) => { await gate; return memory.startRun(row) } }
  const gateway = createTracedGateway(replying("fast"), slow, quiet)
  assert.equal((await gateway.chat(request({ subject: "card-3" }))).message.content, "fast")
  assert.deepEqual(await memory.readRuns({ subject: "card-3" }), [], "nothing stored yet")
  const flushed = gateway.flush()
  release()
  await flushed
  const [run] = await memory.readRuns({ subject: "card-3" })
  assert.equal(run.outcome, "ok")
  assert.equal((await memory.readCalls(run.id)).length, 1)
})
