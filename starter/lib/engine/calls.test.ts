// Tier-1 calls with a simulated person (ticket 10), read through `state` and `apply`
// only. The person on the other end is scripted per order reference and attempt;
// speech is the scripted TTS (no network). Expected values come from the spec's
// call state machine and the dataset, looked up by hand.

import assert from "node:assert/strict"
import { test } from "node:test"
import type { Engine, OrderState } from "./engine"
import { scriptedPerson, scriptedSpeech } from "./call-testing"
import { orderCalls, tightEta } from "./calls"
import type { PlannedAction, RuleId } from "./checks"
import { eachStore, testEngine, testGateway, type TestEngineOptions } from "./testing"

function find(orders: OrderState[], reference: string): OrderState {
  const found = orders.find((row) => row.reference === reference)
  assert.ok(found, `${reference} is in the snapshot`)
  return found
}

async function order(engine: Engine, reference: string): Promise<OrderState> {
  return find((await engine.state()).orders, reference)
}

function callEngine(scripts: Parameters<typeof scriptedPerson>[0], options: TestEngineOptions = {}): Promise<Engine> {
  return testEngine({ ...options, calls: { person: scriptedPerson(scripts), speech: scriptedSpeech(), ...options.calls } })
}

test("CD-420806's driver check-in runs in the background and ends at tier 1 without a person", async () => {
  const engine = await callEngine({ "CD-420806": [["answer", "1", "1"]] })
  assert.equal((await order(engine, "CD-420806")).group, "in_progress", "the stale-tracking rule plans a driver call")

  await engine.apply({ type: "runCalls" })

  const after = await order(engine, "CD-420806")
  assert.equal(after.calls.length, 1)
  const [call] = after.calls
  assert.equal(call.line, "driver")
  assert.equal(call.callee.handle, "drv-110")
  assert.equal(call.answerer, "simulated")
  assert.deepEqual(call.path, ["ringing", "answered", "availability", "tier1", "ended"])
  assert.equal(call.outcome, "resolved")
  assert.equal(call.tier, 1)
  assert.match(call.summary ?? "", /on track/i)
  assert.notEqual(after.group, "in_progress", "nothing is left for the agent to do")
  assert.ok(!after.planned.some((action) => action.kind === "driver_call"), "the call fulfilled the planned driver call")
})

eachStore("a decline schedules a callback that fires when the demo clock reaches it", async (engine) => {
  await engine.apply({ type: "runCalls" })
  let order806 = await order(engine, "CD-420806")
  assert.equal(order806.calls.length, 1)
  const [first] = order806.calls
  assert.deepEqual(first.path, ["ringing", "declined", "ended"])
  assert.equal(first.outcome, "callback")
  assert.equal(first.callbackAt, "2026-10-21T10:00:00.000Z", "a declined call is retried an hour later")
  assert.equal(order806.group, "in_progress", "a scheduled callback keeps the order In progress")
  assert.match(order806.reason, /Callback to .* at 13:00 EEST/, "operator-facing times are in the control room zone, like the demo clock")
  const state = await engine.state()
  assert.ok(state.dueItems.some((item) => item.id === `callback:${first.id}` && item.kind === "callback" && !item.due))

  await engine.apply({ type: "runCalls" })
  assert.equal((await order(engine, "CD-420806")).calls.length, 1, "nothing happens before the callback time")

  await engine.apply({ type: "advanceToNextDue" })
  assert.equal(await engine.clock(), "2026-10-21T10:00:00.000Z")
  assert.equal((await order(engine, "CD-420806")).callLines.find((line) => line.line === "driver")?.status, "callback_due")
  await engine.apply({ type: "runCalls" })

  order806 = await order(engine, "CD-420806")
  assert.equal(order806.calls.length, 2)
  const second = order806.calls[1]
  assert.equal(second.attempt, 2)
  assert.equal(second.outcome, "resolved")
  assert.equal(second.startedAt, "2026-10-21T10:00:00.000Z")
  assert.notEqual(order806.group, "in_progress")
}, { calls: () => ({ person: scriptedPerson({ "CD-420806": [["decline"], ["answer", "1", "1"]] }), speech: scriptedSpeech() }) })

test("a busy person picks a callback time; no answer three times in a row needs a person", async () => {
  const engine = await callEngine({
    "CD-420806": [["answer", "2", "1"]],
    "CD-420735": [["no_answer"], ["no_answer"], ["no_answer"]],
  })
  await engine.apply({ type: "runCalls" })
  const busy = (await order(engine, "CD-420806")).calls[0]
  assert.deepEqual(busy.path, ["ringing", "answered", "availability", "callback_time", "ended"])
  assert.equal(busy.callbackAt, "2026-10-21T09:15:00.000Z", "1 = in 15 minutes")
  assert.ok(busy.transcript.some((line) => line.by === "agent" && /call you back at 12:15/.test(line.text)), "the agent says when in the driver's time (the promise is in Helsinki, UTC+3)")

  for (let i = 0; i < 3; i++) {
    await engine.apply({ type: "advanceClock", minutes: 30 })
    await engine.apply({ type: "runCalls" })
  }
  const silent = await order(engine, "CD-420735")
  assert.deepEqual(silent.calls.map((call) => call.outcome), ["callback", "callback", "unreachable"])
  assert.deepEqual(silent.calls.map((call) => call.attempt), [1, 2, 3])
  assert.equal(silent.group, "needs_action")
  assert.match(silent.reason, /No answer from .* after 3 attempts/)
})

test("a reported problem moves the call to tier 2; with no voice agent it ends as a tier-3 handover to a person", async () => {
  const engine = await callEngine({ "CD-420806": [["answer", "1", "2"]] })
  await engine.apply({ type: "runCalls" })
  const order806 = await order(engine, "CD-420806")
  const [call] = order806.calls
  assert.deepEqual(call.path, ["ringing", "answered", "availability", "tier1", "tier2", "ended"])
  assert.equal(call.tier, 3, "handed over to a person")
  assert.equal(call.outcome, "handover")
  assert.equal(order806.group, "needs_action")
  assert.match(order806.reason, /Driver reports a problem/)
})

test("a wrong key is asked again once; a second wrong key escalates", async () => {
  const engine = await callEngine({ "CD-420806": [["answer", "1", "7", "1"]], "CD-420735": [["answer", "1", "7", "8"]] })
  await engine.apply({ type: "runCalls" })
  const retried = (await order(engine, "CD-420806")).calls[0]
  assert.equal(retried.outcome, "resolved")
  assert.ok(retried.transcript.some((line) => line.by === "agent" && line.text.startsWith("Sorry, I didn't catch that.")))
  assert.equal((await order(engine, "CD-420735")).calls[0].outcome, "handover")
})

test("the background site calls go out on their own, including pickup-readiness calls to customer-side pickup contacts", async () => {
  const speech = scriptedSpeech()
  const engine = await testEngine({ calls: { person: scriptedPerson({}), speech } })
  const before = await engine.state()
  const planned = before.orders.filter((row) => row.planned.some((action) => action.kind === "site_call")).map((row) => row.reference)
  // Pickup contacts the customer gave (stated_by CUSTOMER_ORDER_INPUT) or a site the customer owns:
  // a pickup-readiness call acts alone (ADR 0001 amendment, policy row pickup-readiness).
  const customerSide = ["CD-420449", "CD-420719", "CD-421011", "CD-421051"]
  for (const reference of customerSide) assert.ok(planned.includes(reference), `${reference} plans its pickup-readiness call`)
  assert.equal(planned.length, 18)
  assert.ok(planned.includes("CD-420015"), "CD-420015's customer typed in the site's own desk (site-005): the site is called")

  await engine.apply({ type: "runCalls" })
  const after = await engine.state()
  for (const reference of planned) {
    const row = find(after.orders, reference)
    const site = row.calls.filter((call) => call.line === "site")
    assert.equal(site.length, 1, `${reference} had one site call`)
    assert.equal(site[0].answerer, "simulated")
    assert.equal(site[0].outcome, "resolved", `${reference}: the simulated person answered`)
    assert.ok(row.callLines.filter((line) => line.line === "site").every((line) => line.status === "done"), `${reference}: its site line is done`)
  }
  assert.equal(find(after.orders, "CD-420719").calls[0].callee.contactType, "customer_owned_site")
  for (const reference of ["CD-420449", "CD-421011", "CD-421051"]) {
    assert.equal(find(after.orders, reference).calls[0].callee.contactType, "customer_given_contact", reference)
  }
  assert.ok(after.orders.every((row) => row.calls.every((call) => call.callee.contactType !== "paying_customer")), "the paying customer is never called")
  assert.ok(after.orders.every((row) => row.calls.every((call) => call.answerer === "simulated")), "nothing rings live unless asked")
})

test("the tight-ETA check reads the order the way the rules do: the selected promise on the final delivery point, and never a cancelled order", async () => {
  const engine = await testEngine()
  const bundle = engine.bundle((await order(engine, "CD-420437")).id)
  assert.ok(bundle)
  assert.ok(tightEta(bundle), "CD-420437: ETA 13:58Z, 2 min before the promise ends")
  // Cancelled (cancelled_at set while the status still reads in transit): nothing to ask.
  assert.equal(tightEta({ ...bundle, order: { ...bundle.order, details: { ...bundle.order.details, cancelled_at: "2026-10-21T08:00:00Z" } } }), null)
  // The promise sits on another point than the final delivery point: R12 sees no promise, and neither does this check.
  const elsewhere = (bundle.related.time_windows ?? []).map((row) => row.details.purpose === "CUSTOMER_DELIVERY_PROMISE" ? { ...row, details: { ...row.details, point_id: "pt-elsewhere" } } : row)
  assert.equal(tightEta({ ...bundle, related: { ...bundle.related, time_windows: elsewhere } }), null)
})

test("the call layer's own guard: a customer-side pickup contact takes only a pickup-readiness call", async () => {
  const engine = await testEngine()
  const row = await order(engine, "CD-420449")
  const bundle = engine.bundle(row.id)
  assert.ok(bundle)
  const callee = row.callLines.find((line) => line.line === "site")?.callee
  assert.ok(callee?.recordId, "CD-420449 has its pickup-readiness site call")
  assert.equal(callee.contactType, "customer_given_contact")
  const plannedCall = (ruleIds: RuleId[]): PlannedAction[] =>
    [{ kind: "site_call", ruleIds, reason: "test", callee: { name: callee.name, handle: callee.handle, role: callee.role, endpointId: callee.recordId as string } }]
  const now = "2026-10-21T09:00:00Z"
  // A pickup-readiness topic (contact not confirmed) is called.
  assert.equal(orderCalls(bundle, plannedCall(["R5"]), [], [], now).blocked.length, 0)
  // R6 (promise not set by the customer) reaches the pickup place only as a readiness question,
  // never as a question about the delivery promise, which stays the customer's (ADR 0001).
  const r6 = orderCalls(bundle, plannedCall(["R6"]), [], [], now)
  assert.equal(r6.blocked.length, 0)
  const topic = r6.lines[0].open.find((row) => row.id === "rule:R6")
  assert.match(topic?.title ?? "", /ready/i)
  assert.doesNotMatch(topic?.title ?? "", /promise/i)
  // Any other topic for the same customer-given person is blocked: propose only.
  const other = orderCalls(bundle, plannedCall(["R12"]), [], [], now)
  assert.equal(other.blocked.length, 1)
  assert.equal(other.lines.length, 0)
})

test("a confirmed contact becomes a change proposal that waits for a yes in Fixed, review it; the order is not changed", async () => {
  const engine = await callEngine({})
  await engine.apply({ type: "runCalls" })
  const row = await order(engine, "CD-420154")
  const [call] = row.calls
  assert.deepEqual(call.questions.map((question) => question.id), ["contact", "ready"], "R4/R5 ask about the contact, R6 about readiness")
  const change = row.proposals.find((proposal) => proposal.kind === "change")
  assert.ok(change, "the confirmation is proposed as a change")
  assert.equal(change.status, "proposed")
  assert.equal(change.policyRow, "order-change")
  assert.equal(change.source, call.id)
  assert.match(change.change ?? "", /Pickup contact confirmed .*Adrian Aldermere \(site-065@example\.test\)/)
  assert.equal(row.group, "solved")
  assert.match(row.reason, /waiting for your yes.*Confirm the pickup contact/)
  assert.ok(row.rules.some((rule) => rule.id === "R4" && rule.outcome === "unknown"), "the rules still read the snapshot: nothing changed without a yes")
})

test("CD-420516's site call about the keys goes out without approval, and its answer waits in Fixed, review it", async () => {
  const engine = await callEngine({ "CD-420516": [["answer", "1", "3"]] }, { gateway: await testGateway() })
  await engine.apply({ type: "review" })
  const before = await order(engine, "CD-420516")
  const keyCall = before.proposals.find((proposal) => proposal.kind === "call")
  assert.ok(keyCall)
  assert.equal(keyCall.status, "approved", "acts alone under site-routine")
  assert.equal(before.group, "in_progress")

  await engine.apply({ type: "runCalls" })
  const after = await order(engine, "CD-420516")
  const [call] = after.calls
  assert.equal(call.callee.handle, "site-001@example.test")
  assert.deepEqual(call.questions.map((question) => question.id), ["keys"])
  assert.equal(call.outcome, "resolved")
  const answered = after.proposals.find((proposal) => proposal.id === keyCall.id)
  assert.equal(answered?.status, "answered")
  assert.match(answered?.history.at(-1)?.text ?? "", /Keys are collected at stock control/)
  const change = after.proposals.find((proposal) => proposal.kind === "change")
  assert.equal(change?.status, "proposed")
  assert.match(change?.change ?? "", /collected at stock control/)
  // Not published yet: the change from the call is part of the Solved review, not a Blocked decision.
  assert.equal(after.group, "solved")
  assert.equal(after.publication.stage, "confirm")

  await engine.apply({ type: "confirmChanges", orderId: after.id })
  const confirmed = await order(engine, "CD-420516")
  assert.equal(confirmed.proposals.find((proposal) => proposal.id === change?.id)?.status, "approved", "the yes approves the change from the call")
  assert.equal(confirmed.publication.published?.by, "operator")
  assert.notEqual(confirmed.group, "solved")
})

test("CD-420516's next check fires at 10:00 and starts a routine site call", async () => {
  const engine = await callEngine({ "CD-420516": [["answer", "1", "1"]] })
  await engine.apply({ type: "runCalls" })
  assert.equal((await order(engine, "CD-420516")).calls.length, 0, "no call before the next check (no reviewer here)")
  await engine.apply({ type: "advanceToNextDue" })
  assert.equal(await engine.clock(), "2026-10-21T10:00:00.000Z")
  await engine.apply({ type: "runCalls" })
  const row = await order(engine, "CD-420516")
  assert.equal(row.calls.length, 1)
  assert.ok(row.calls[0].topics.some((topic) => topic.id === "rule:NEXT"))
  assert.equal(row.calls[0].startedAt, "2026-10-21T10:00:00.000Z")
  assert.equal(row.calls[0].outcome, "resolved")
})

test("the cost meter sums speech cost and phone time against an operator's time; fixed prompts are spoken once", async () => {
  const speech = scriptedSpeech()
  const engine = await testEngine({ calls: { person: scriptedPerson({}), speech, rates: { operatorPerMinuteEur: 0.7, phonePerMinuteEur: 0.01, eurPerUsd: 1 } } })
  await engine.apply({ type: "runCalls" })
  const call = (await order(engine, "CD-420806")).calls[0]
  const spoken = call.transcript.filter((line) => line.by === "agent")
  assert.ok(spoken.every((line) => line.audioId), "every prompt has audio")
  assert.ok(call.cost.phoneSeconds > 0)
  assert.ok(call.cost.ringSeconds > 0)
  assert.equal(call.cost.phoneEur, Math.round(call.cost.phoneSeconds / 60 * 0.01 * 1e6) / 1e6)
  assert.ok(call.cost.operatorEur >= 0.7, "an operator costs at least a minute")
  assert.ok(call.cost.totalEur < call.cost.operatorEur / 10, "a tier-1 call is far cheaper than an operator")
  // The same question on another driver call is a cache hit: spoken once in total.
  const onTrack = "Are you still on track with this delivery? Press 1 for yes, or 2 if there is a problem."
  assert.ok(speech.spoken.filter((text) => text === onTrack).length >= 2)
  const other = (await order(engine, "CD-420735")).calls[0]
  const cachedLine = other.transcript.find((line) => line.text === onTrack)
  const firstLine = call.transcript.find((line) => line.text === onTrack)
  assert.equal(cachedLine?.audioId, firstLine?.audioId)
})

test("a live call waits for the phone: ringing keeps the order In progress, and the phone's moves drive it", async () => {
  const engine = await callEngine({}, { calls: { answererFor: (header) => header.reference === "CD-420806" ? "live" : "simulated" } })
  await engine.apply({ type: "runCalls" })
  let row = await order(engine, "CD-420806")
  const [call] = row.calls
  assert.equal(call.answerer, "live")
  assert.equal(call.state, "ringing")
  assert.deepEqual(call.expecting, { type: "ring" })
  assert.equal(row.group, "in_progress")
  assert.match(row.reason, /Calling /)

  await assert.rejects(engine.apply({ type: "callEvent", callId: call.id, input: { type: "key", digit: "1" } }), /ringing/)
  await engine.apply({ type: "callEvent", callId: call.id, input: { type: "answer" } })
  row = await order(engine, "CD-420806")
  assert.equal(row.calls[0].state, "availability")
  assert.equal(row.calls[0].expecting?.type, "key")
  await engine.apply({ type: "callEvent", callId: call.id, input: { type: "key", digit: "1" } })
  await engine.apply({ type: "callEvent", callId: call.id, input: { type: "key", digit: "1" } })
  row = await order(engine, "CD-420806")
  assert.equal(row.calls[0].outcome, "resolved")
  await assert.rejects(engine.apply({ type: "callEvent", callId: call.id, input: { type: "key", digit: "1" } }), /ended/)
})

test("the operator can start a call on a line, ringing live", async () => {
  const engine = await callEngine({})
  await engine.apply({ type: "startCall", orderId: (await order(engine, "CD-420806")).id, line: "driver", live: true })
  const row = await order(engine, "CD-420806")
  assert.equal(row.calls[0].answerer, "live")
  await assert.rejects(engine.apply({ type: "startCall", orderId: row.id, line: "driver" }), /already running/)
  // A customer-given pickup contact takes a pickup-readiness call; the delivery side has nothing to call.
  await engine.apply({ type: "startCall", orderId: (await order(engine, "CD-420449")).id, line: "site" })
  assert.equal((await order(engine, "CD-420449")).calls[0].callee.contactType, "customer_given_contact")
})

test("paced like a real phone: the simulated person rings and waits for each prompt to finish before pressing", async () => {
  let now = Date.parse("2026-10-21T09:00:00Z")
  const engine = await callEngine({ "CD-420806": [["answer", "1", "1"]] }, { calls: { pace: 1, wallClock: () => now } })
  const step = async () => { await engine.apply({ type: "runCalls", steps: 1 }); return (await order(engine, "CD-420806")).calls[0] }
  assert.equal((await step()).state, "ringing", "the call starts ringing")
  assert.equal((await step()).state, "ringing", "nobody answers within the same second")
  now += 6_000
  const answered = await step()
  assert.equal(answered.state, "availability", "answered after six seconds of ringing; the agent asks at once")
  const prompt = answered.transcript.at(-1)!
  now += 1_000
  assert.equal((await step()).answers.length, 0, "the person is still listening to the prompt")
  now += 60_000
  assert.equal((await step()).state, "tier1", "pressed 1 once the prompt ended")
  assert.ok(prompt.text.startsWith("Hello"))
})

eachStore("reset clears calls and callbacks", async (engine) => {
  await engine.apply({ type: "runCalls" })
  assert.ok((await engine.state()).orders.some((row) => row.calls.length))
  await engine.apply({ type: "reset" })
  const state = await engine.state()
  assert.ok(state.orders.every((row) => row.calls.length === 0))
  assert.ok(!state.dueItems.some((item) => item.kind === "callback"))
}, { calls: () => ({ person: scriptedPerson({ "CD-420806": [["decline"]] }) }) })
