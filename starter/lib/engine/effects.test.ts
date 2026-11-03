// Effect events, the overlay and the re-review loop (ticket 09), through `state`,
// `apply`, `bundle` and `overlaid` only. Expected values come from the dataset
// (looked up by hand) and the scenario fixtures.

import assert from "node:assert/strict"
import { test } from "node:test"
import { NO_USAGE, type ChatRequest } from "@/lib/reviewer/gateway"
import type { Engine, OrderState } from "./engine"
import { scriptedPerson, scriptedSpeech } from "./call-testing"
import { eachStore, testEngine, testGateway, type CountingGateway } from "./testing"

const ORDER_437 = "ord-00437"
// CD-420437's delivery endpoint: Celia Hollowmere, stated by the customer, UNCONFIRMED.
const DELIVERY_437 = "ep-x61821adf903f2d7d"
// CD-420437's delivery promise: 09:00-14:00Z on 21 Oct, source CUSTOMER.
const PROMISE_437 = "win-x3ce81a48192137db"

function find(orders: OrderState[], reference: string): OrderState {
  const found = orders.find((row) => row.reference === reference)
  assert.ok(found, `${reference} is in the snapshot`)
  return found
}

async function overlaidRow(engine: Engine, orderId: string, collection: string, id: string) {
  const bundle = engine.bundle(orderId)
  assert.ok(bundle)
  const row = (await engine.overlaid(bundle)).related[collection]?.find((item) => item.id === id)
  assert.ok(row, `${id} is on the overlaid order`)
  return row.details
}

eachStore("approving a change writes an effect event that the order view applies; the snapshot row is unchanged", async (engine) => {
  await engine.apply({
    type: "proposeChange", orderId: ORDER_437, title: "Confirm the delivery contact", change: "Celia Hollowmere is confirmed as the delivery contact.",
    why: "The customer confirmed her.", source: "test",
    effect: { type: "contact_confirmed", endpointId: DELIVERY_437, confirmedBy: "Calverona Auto (paying customer)" },
  })
  await engine.apply({ type: "advanceClock", minutes: 15 })
  const change = find((await engine.state()).orders, "CD-420437").proposals.find((row) => row.kind === "change")!
  assert.equal(change.status, "proposed")
  assert.equal(find((await engine.state()).orders, "CD-420437").effects.length, 0, "no effect before the yes")

  const order = find((await engine.apply({ type: "approve", proposalId: change.id })).orders, "CD-420437")
  assert.equal(order.effects.length, 1)
  const [effect] = order.effects
  assert.equal(effect.type, "contact_confirmed")
  assert.equal(effect.at, "2026-10-21T09:15:00.000Z")
  assert.equal(effect.by, "operator")
  assert.equal(effect.source, change.id)
  assert.match(effect.text, /Celia Hollowmere/)
  // The history lists it after the approval, with who approved it.
  const kinds = order.history.map((entry) => entry.kind)
  assert.ok(kinds.indexOf("effect") > kinds.indexOf("approved"))
  assert.match(order.history.find((entry) => entry.kind === "effect")!.text, /contact .*confirmed/i)

  const details = await overlaidRow(engine, ORDER_437, "order_endpoint_details", DELIVERY_437)
  assert.equal(details.contact_status, "CONFIRMED")
  assert.equal(details.last_confirmed_at, "2026-10-21T09:15:00.000Z")
  const raw = engine.bundle(ORDER_437)!.related.order_endpoint_details!.find((row) => row.id === DELIVERY_437)!
  assert.equal(raw.details.contact_status, "UNCONFIRMED", "the snapshot is never edited")
})

type Case = { effect: Record<string, unknown>; collection: string; id: string | null; check: (details: Record<string, unknown>) => void }

// One effect of each type on CD-420437, and what the overlaid order shows for it.
const SEVEN: Case[] = [
  { effect: { type: "contact_confirmed", endpointId: DELIVERY_437, confirmedBy: "Calverona Auto" }, collection: "order_endpoint_details", id: DELIVERY_437,
    check: (d) => assert.equal(d.contact_status, "CONFIRMED") },
  { effect: { type: "contact_changed", endpointId: DELIVERY_437, name: "Marten Calver", handle: "+49 89 5550 1234", role: "receiver", statedBy: "Calverona Auto" },
    collection: "order_endpoint_details", id: DELIVERY_437, check: (d) => { assert.equal(d.contact_name, "Marten Calver"); assert.equal(d.contact_handle, "+49 89 5550 1234") } },
  { effect: { type: "window_changed", windowId: PROMISE_437, startAt: "2026-10-21T09:00:00Z", endAt: "2026-10-21T16:00:00Z", statedBy: "Calverona Auto" },
    collection: "time_windows", id: PROMISE_437, check: (d) => assert.equal(d.end_at, "2026-10-21T16:00:00Z") },
  { effect: { type: "call_result_recorded", with: "drv-367 (driver)", claim: "I will be in Munich by 15:30 local.", callId: "call-1" },
    collection: "effect_events", id: null, check: (d) => { assert.equal(d.stated_by, "drv-367 (driver)"); assert.match(String(d.claim), /15:30/) } },
  { effect: { type: "customer_answer_recorded", from: "Calverona Auto (paying customer)", question: "Who may sign?", answer: "Celia Hollowmere may sign." },
    collection: "effect_events", id: null, check: (d) => { assert.equal(d.stated_by, "Calverona Auto (paying customer)"); assert.match(String(d.answer), /Celia/) } },
  { effect: { type: "operator_answer_recorded", question: "Is the note right?", answer: "Yes, still right." },
    collection: "effect_events", id: null, check: (d) => { assert.equal(d.stated_by, "operator"); assert.match(String(d.answer), /still right/) } },
  { effect: { type: "cost_approved", expenseId: "expense-x48b29a9303850109" }, collection: "expenses", id: "expense-x48b29a9303850109",
    check: (d) => assert.equal(d.status, "APPROVED") },
]

for (const { effect, collection, id, check } of SEVEN) {
  eachStore(`effect ${String(effect.type)}: changes the order view and is listed in the history with who committed it`, async (engine) => {
    const order = find((await engine.apply({ type: "recordEffect", effect: { ...effect, orderId: ORDER_437, by: "operator", source: "test" } as never })).orders, "CD-420437")
    assert.equal(order.effects.length, 1)
    assert.equal(order.effects[0].type, effect.type)
    const entry = order.history.find((row) => row.kind === "effect")!
    assert.equal(entry.by, "operator")
    // The card shows who committed it; the line says only what changed, without record ids.
    assert.doesNotMatch(entry.text, /Committed by|-x[0-9a-f]{8,}/)
    const bundle = await engine.overlaid(engine.bundle(ORDER_437)!)
    const records = bundle.related[collection] ?? []
    const row = id ? records.find((item) => item.id === id) : records.find((item) => item.id === order.effects[0].id)
    assert.ok(row, `${collection} shows the effect`)
    check(row.details)
    // Every effect is also an attributed record of its own.
    assert.ok(bundle.related.effect_events?.some((item) => item.id === order.effects[0].id))
  })
}

test("an effect on a record that is not on the order is refused, and nothing is written", async () => {
  const engine = await testEngine()
  await assert.rejects(engine.apply({ type: "recordEffect", effect: { type: "contact_confirmed", endpointId: "ep-nope", confirmedBy: "x", orderId: ORDER_437, by: "operator", source: "test" } }), /no endpoint ep-nope/)
  await assert.rejects(engine.apply({ type: "recordEffect", effect: {
    type: "window_changed", windowId: "win-x59c404d387179b4b", startAt: "2026-10-21T09:00:00Z", endAt: "2026-10-21T10:00:00Z", statedBy: "x", orderId: ORDER_437, by: "operator", source: "test",
  } }), /only the selected pickup slot or the delivery promise/)
  assert.equal(find((await engine.state()).orders, "CD-420437").effects.length, 0)
})

test("the agent commits only attributed statements (call results, reported ETAs); a change to the order needs the operator (ADR 0001)", async () => {
  const engine = await testEngine()
  const window = { type: "window_changed", windowId: PROMISE_437, startAt: "2026-10-21T09:00:00Z", endAt: "2026-10-21T13:00:00Z", statedBy: "Calverona Auto", orderId: ORDER_437, source: "test" } as const
  await assert.rejects(engine.apply({ type: "recordEffect", effect: window }), /needs the operator/)
  await assert.rejects(engine.apply({ type: "recordEffect", effect: { ...window, by: "agent" } }), /needs the operator/)
  await assert.rejects(engine.apply({ type: "recordEffect", effect: { type: "contact_confirmed", endpointId: DELIVERY_437, confirmedBy: "x", orderId: ORDER_437, by: "policy", source: "test" } }), /needs the operator/)
  await assert.rejects(engine.apply({ type: "recordEffect", effect: { type: "operator_answer_recorded", question: "q", answer: "a", orderId: ORDER_437, source: "test" } }), /needs the operator/)
  assert.equal(find((await engine.state()).orders, "CD-420437").effects.length, 0)
  await engine.apply({ type: "recordEffect", effect: { type: "call_result_recorded", with: "Thomas Mellervik (driver)", claim: "On track", orderId: ORDER_437, source: "test" } })
  await engine.apply({ type: "recordEffect", effect: { ...window, by: "operator" } })
  assert.deepEqual(find((await engine.state()).orders, "CD-420437").effects.map((event) => [event.type, event.by]), [["call_result_recorded", "agent"], ["window_changed", "operator"]])
})

test("the rules read the order with its effect events applied", async () => {
  const engine = await testEngine()
  const before = find((await engine.state()).orders, "CD-420437")
  assert.equal(before.rules.find((rule) => rule.id === "R5")!.outcome, "unknown", "delivery contact not confirmed")
  assert.equal(before.rules.find((rule) => rule.id === "R12")!.outcome, "pass", "ETA 13:58Z is inside the promise ending 14:00Z")
  await engine.apply({ type: "recordEffect", effect: { type: "contact_confirmed", endpointId: DELIVERY_437, confirmedBy: "Calverona Auto", orderId: ORDER_437, by: "operator", source: "test" } })
  assert.equal(find((await engine.state()).orders, "CD-420437").rules.find((rule) => rule.id === "R5")!.outcome, "pass")
  await engine.apply({ type: "recordEffect", effect: {
    type: "window_changed", windowId: PROMISE_437, startAt: "2026-10-21T09:00:00Z", endAt: "2026-10-21T13:00:00Z", statedBy: "Calverona Auto", orderId: ORDER_437, by: "operator", source: "test",
  } })
  assert.equal(find((await engine.state()).orders, "CD-420437").rules.find((rule) => rule.id === "R12")!.outcome, "fail", "the ETA is now after the moved promise end")
  assert.equal(engine.bundle(ORDER_437)!.related.time_windows!.find((row) => row.id === PROMISE_437)!.details.end_at, "2026-10-21T14:00:00Z", "the snapshot is unchanged")
})

// -- The re-review loop and journey 1 ------------------------------------------

function caseFileOf(request: ChatRequest): string {
  return request.messages.map((message) => typeof message.content === "string" ? message.content : "").join("\n")
}

const RECEIVER_LEAVES = /\[([^\]]+)\] (recorded_answer|effect_events)[^\n]*\n[^\n]*Marten Calver[^\n]*/

/**
 * The scripted reviewer, plus one reaction: on CD-420437, an answer (recorded or
 * committed) naming Marten Calver, who leaves at 14:30 local, conflicts with the
 * 15:58 local ETA. That is a new finding for the customer.
 */
async function reactingGateway(): Promise<CountingGateway> {
  const inner = await testGateway()
  const calls: ChatRequest[] = []
  return {
    calls,
    async chat(request) {
      calls.push(request)
      const match = request.subject === "CD-420437" ? RECEIVER_LEAVES.exec(caseFileOf(request)) : null
      if (!match) return inner.chat(request)
      const finding = {
        title: "The receiver the customer named leaves before the car arrives",
        conflict: [
          { record_id: match[1], field: "answer", quote: "he leaves the site at 14:30" },
          { record_id: "track-x0e9acf00fc4d6673", field: "estimated_delivery_local", quote: "21 Oct 15:58 CEST" },
        ],
        ask: { role: "customer", contact_type: "paying_customer", contact_record_id: "conv-x0eed829e1b54984f", contact_quote: "cus-025", name: "Calverona Auto (cus-025)" },
        who_pays: "cus-025 Calverona Auto pays Bahn: propose only.", policy_row: "customer-side",
        question: "For CD-420437: Marten Calver leaves at 14:30 but the car arrives about 15:58. Who can receive and sign after 15:30?",
        why: "Nobody authorised would be there when the car arrives.",
      }
      const args = JSON.stringify({ summary: "The named receiver leaves before the ETA.", findings: [finding] })
      return {
        model: "scripted", finishReason: "tool_calls", usage: { ...NO_USAGE, cost: 0.002 },
        message: { role: "assistant", content: null, tool_calls: [{ id: "call_react", type: "function", function: { name: "submit_findings", arguments: args } }] },
      }
    },
  }
}

async function handOver437(engine: Engine) {
  await engine.apply({ type: "review" })
  const proposal = find((await engine.state()).orders, "CD-420437").proposals[0]
  await engine.apply({ type: "approve", proposalId: proposal.id })
  await engine.apply({ type: "advanceClock", minutes: 15 })
  return proposal
}

eachStore("journey 1: finding -> handed over -> answer recorded -> update approved (effect event) -> re-review -> Normal", async (engine, gateway) => {
  const asked = await handOver437(engine)
  const answer = "Celia Hollowmere may sign; she is there until 18:00."
  const answered = find((await engine.apply({ type: "recordAnswer", proposalId: asked.id, answer })).orders, "CD-420437")
  assert.equal(answered.group, "needs_action", "the order update waits for a yes")
  assert.equal(answered.effects.length, 0, "an answer is not a committed change until the update is approved")
  const update = answered.proposals.find((row) => row.kind === "change")!

  const calls = gateway.calls.length
  await engine.apply({ type: "advanceClock", minutes: 5 })
  const done = find((await engine.apply({ type: "approve", proposalId: update.id })).orders, "CD-420437")
  assert.equal(done.effects.length, 1)
  assert.equal(done.effects[0].type, "customer_answer_recorded")
  assert.equal(done.effects[0].at, "2026-10-21T09:20:00.000Z")
  assert.equal(done.effects[0].source, update.id)

  // The effect re-ran the reviewer, as of the effect's time, with the committed answer as a record.
  const rerun = gateway.calls.slice(calls)
  assert.ok(rerun.length > 0 && rerun.every((request) => request.subject === "CD-420437"))
  const caseFile = caseFileOf(rerun[0])
  assert.match(caseFile, /Now: 2026-10-21T09:20:00.000Z/)
  assert.match(caseFile, new RegExp(`\\[${done.effects[0].id}\\] effect_events`))
  assert.match(caseFile, /CUSTOMER_ANSWER_RECORDED/)
  // Versioning: the answer is version 2 of the point the question settles. The customer's own
  // earlier statements on it (the 09:44 and 08:42 messages) are superseded history, still
  // there to cite; records by others (the ETA, the promise, the work item) stay live.
  assert.equal(done.effects[0].version, 2)
  assert.deepEqual([...done.effects[0].supersedes].sort(), ["msg-x0049fe6fc2fd0b0e", "msg-x47456eacbe1e0e07"])
  assert.match(caseFile, /version 2 of \\"For CD-420437, the Bentley Flying Spur/, "the point it settles is the question asked")
  assert.match(caseFile, /\[msg-x0049fe6fc2fd0b0e\] message[^\n]*SUPERSEDED by eff-/)
  assert.match(caseFile, /\[msg-x47456eacbe1e0e07\] message[^\n]*SUPERSEDED by eff-/)
  assert.match(caseFile, /I still cannot confirm who is authorized/, "the superseded statement is kept")
  assert.doesNotMatch(caseFile, /\[track-x0e9acf00fc4d6673\][^\n]*SUPERSEDED/)
  assert.doesNotMatch(caseFile, /\[work-x6c27e55269d19e01\][^\n]*SUPERSEDED/)
  assert.doesNotMatch(caseFile, /recorded_answer/, "the committed answer is read once, as the effect event")
  assert.equal(done.review.reviewAt, "2026-10-21T09:20:00.000Z")

  assert.equal(done.group, "normal")
  assert.deepEqual(done.history.map((entry) => entry.kind), ["proposed", "approved", "answered", "proposed", "approved", "effect"])
}, { gateway: reactingGateway })

eachStore("journey 1 variant: an answer that creates a new conflict re-runs the reviewer, shows the new finding and lands in Needs action", async (engine) => {
  const asked = await handOver437(engine)
  const answer = "Celia Hollowmere may not sign. Only Marten Calver may sign, and he leaves the site at 14:30 local."
  const answered = find((await engine.apply({ type: "recordAnswer", proposalId: asked.id, answer })).orders, "CD-420437")
  const fresh = answered.proposals.filter((row) => row.kind === "customer_contact" && row.status === "proposed")
  assert.equal(fresh.length, 1, "the re-review raised a new finding")
  assert.match(fresh[0].title, /leaves before the car arrives/)
  assert.ok(answered.review.findings.some((finding) => finding.title === fresh[0].title))

  // Committing the answer keeps the conflict: the new finding now cites the effect event.
  const update = answered.proposals.find((row) => row.kind === "change")!
  const committed = find((await engine.apply({ type: "approve", proposalId: update.id })).orders, "CD-420437")
  assert.equal(committed.group, "needs_action")
  assert.match(committed.reason, /leaves before the car arrives/)
  assert.ok(committed.review.findings[0].cited.some((cited) => cited.recordId === committed.effects[0].id))
}, { gateway: reactingGateway })

eachStore("the operator's answer to a question is committed at once as an effect event, and re-reviewed", async (engine, gateway) => {
  await engine.apply({ type: "review" })
  const question = find((await engine.state()).orders, "CD-420089").proposals[0]
  const calls = gateway.calls.length
  const order = find((await engine.apply({ type: "answerQuestion", proposalId: question.id, answer: "No: the driver starts from Helsinki." })).orders, "CD-420089")
  assert.equal(order.effects.length, 1)
  assert.equal(order.effects[0].type, "operator_answer_recorded")
  assert.equal(order.effects[0].source, question.id)
  const caseFile = caseFileOf(gateway.calls.slice(calls)[0])
  assert.match(caseFile, /OPERATOR_ANSWER_RECORDED/)
  assert.match(caseFile, /the driver starts from Helsinki/)
}, { gateway: testGateway })

eachStore("reset clears effect events and the order reads the snapshot again", async (engine) => {
  await engine.apply({ type: "recordEffect", effect: { type: "contact_confirmed", endpointId: DELIVERY_437, confirmedBy: "Calverona Auto", orderId: ORDER_437, by: "operator", source: "test" } })
  const order = find((await engine.apply({ type: "reset" })).orders, "CD-420437")
  assert.equal(order.effects.length, 0)
  assert.equal(order.rules.find((rule) => rule.id === "R5")!.outcome, "unknown")
  assert.equal((await overlaidRow(engine, ORDER_437, "order_endpoint_details", DELIVERY_437)).contact_status, "UNCONFIRMED")
})

test("each effect on the same fact writes the next version; the row shows the current one and keeps the earlier ones as history", async () => {
  const engine = await testEngine()
  const change = (name: string) => engine.apply({ type: "recordEffect", effect: {
    type: "contact_changed", endpointId: DELIVERY_437, name, statedBy: "Calverona Auto", orderId: ORDER_437, by: "operator", source: `test-${name}`,
  } })
  await change("Marten Calver")
  const order = find((await change("Ilse Varnholt")).orders, "CD-420437")
  assert.deepEqual(order.effects.map((event) => event.version), [2, 3])
  const row = await overlaidRow(engine, ORDER_437, "order_endpoint_details", DELIVERY_437)
  assert.equal(row.contact_name, "Ilse Varnholt")
  assert.equal(row.version, 3)
  const previous = row.previous_versions as { version: number; contact_name: string; status: string; superseded_by: string }[]
  assert.deepEqual(previous.map((item) => [item.version, item.contact_name, item.status]), [[1, "Celia Hollowmere", "SUPERSEDED"], [2, "Marten Calver", "SUPERSEDED"]])
  assert.equal(previous[1].superseded_by, order.effects[1].id)
  // The older effect event's own record is marked superseded by the newer one.
  const bundle = await engine.overlaid(engine.bundle(ORDER_437)!)
  const older = bundle.related.effect_events!.find((item) => item.id === order.effects[0].id)!
  assert.equal(older.details.superseded_by, order.effects[1].id)
})

test("a finished call's result is committed as a call result effect event, attributed to the callee, and the order is re-reviewed", async () => {
  const gateway = await testGateway()
  const engine = await testEngine({ gateway, calls: { person: scriptedPerson({ "CD-420516": [["answer", "1", "3"]] }), speech: scriptedSpeech() } })
  await engine.apply({ type: "review" })
  const keyCall = find((await engine.state()).orders, "CD-420516").proposals.find((proposal) => proposal.kind === "call")!
  const calls = gateway.calls.length
  await engine.apply({ type: "runCalls" })
  const order = find((await engine.state()).orders, "CD-420516")
  const [call] = order.calls
  const effect = order.effects.find((event) => event.type === "call_result_recorded")
  assert.ok(effect, "the call result is an effect event")
  assert.equal(effect.source, call.id)
  assert.equal(effect.by, "agent")
  assert.deepEqual(effect.answers, [keyCall.id])
  assert.match(effect.text, /Keys are collected at stock control/)
  assert.ok(gateway.calls.slice(calls).some((request) => request.subject === "CD-420516" && /CALL_RESULT_RECORDED/.test(caseFileOf(request))), "re-reviewed with the call result")
  // The confirmed change still waits for a yes; it is not committed by the call.
  assert.equal(order.proposals.find((proposal) => proposal.kind === "change")?.status, "proposed")
})

// -- Done ------------------------------------------------------------------------

eachStore("a delivered order moves into Done only when nothing is open: an open change holds it, its yes releases it", async (engine) => {
  // CD-420111 is delivered with nothing open (Done at the snapshot).
  assert.equal(find((await engine.state()).orders, "CD-420111").group, "done")
  await engine.apply({ type: "proposeChange", orderId: "ord-00111", title: "Note the handover", change: "The receiver signed on paper.", why: "Test.", source: "test" })
  const held = find((await engine.state()).orders, "CD-420111")
  assert.equal(held.group, "needs_action")
  const change = held.proposals.find((proposal) => proposal.kind === "change")!
  const released = find((await engine.apply({ type: "approve", proposalId: change.id })).orders, "CD-420111")
  assert.equal(released.group, "done")
  assert.equal(released.effects.length, 1)
})

test("a delivered order with a gap is not Done; an effect that closes the gap moves it into Done", async () => {
  const engine = await testEngine()
  // CD-420747 is delivered, but its delivery contact has no name: a weak gap keeps it Normal.
  const before = find((await engine.state()).orders, "CD-420747")
  assert.equal(before.group, "normal")
  assert.equal(before.rules.find((rule) => rule.id === "R5")!.outcome, "unknown")
  await engine.apply({ type: "recordEffect", effect: {
    type: "contact_changed", endpointId: "ep-x0886594ff127ef57", name: "Petra Lindqvist", statedBy: "the customer", orderId: "ord-00747", by: "operator", source: "test",
  } })
  assert.equal(find((await engine.state()).orders, "CD-420747").group, "done")
  // CD-420004 is delivered with a proof still SUBMITTED: an unrelated effect does not make it Done.
  await engine.apply({ type: "recordEffect", effect: { type: "operator_answer_recorded", question: "Anything else?", answer: "No.", orderId: "ord-00004", by: "operator", source: "test" } })
  const open = find((await engine.state()).orders, "CD-420004")
  assert.equal(open.group, "needs_action")
  assert.equal(open.rules.find((rule) => rule.id === "CLOSE")!.outcome, "fail")
})

// CD-420725: delivered; its only open record is a submitted pickup-photo proof.
const ORDER_725 = "ord-00725"
const PROOF_725 = "proof-x01adc3c829defb21"

eachStore("closing an open record: the operator accepts the proof, the overlay marks it approved and the finished order has nothing open", async (engine) => {
  const before = find((await engine.state()).orders, "CD-420725")
  const close = before.rules.find((rule) => rule.id === "CLOSE")!
  assert.equal(close.outcome, "fail")
  assert.deepEqual(close.sources.map((source) => [source.id, source.close]), [[PROOF_725, "Accept"]])

  const order = find((await engine.apply({ type: "closeRecords", orderId: ORDER_725, records: [{ collection: "proofs", recordId: PROOF_725 }] })).orders, "CD-420725")
  assert.equal(order.effects.length, 1)
  const [effect] = order.effects
  assert.equal(effect.type, "record_closed")
  assert.equal(effect.by, "operator")
  assert.equal(effect.text, "Pickup photos accepted")
  assert.equal(order.rules.find((rule) => rule.id === "CLOSE")!.outcome, "pass")
  assert.notEqual(order.group, "needs_action")

  const details = await overlaidRow(engine, ORDER_725, "proofs", PROOF_725)
  assert.equal(details.status, "APPROVED")
  assert.equal(details.reviewed_by, "operator")
  const raw = engine.bundle(ORDER_725)!.related.proofs!.find((row) => row.id === PROOF_725)!
  assert.equal(raw.details.status, "SUBMITTED", "the snapshot is never edited")

  // Closed once: a second close is refused and writes nothing.
  await assert.rejects(engine.apply({ type: "closeRecords", orderId: ORDER_725, records: [{ collection: "proofs", recordId: PROOF_725 }] }), /already closed/)
  await assert.rejects(engine.apply({ type: "closeRecords", orderId: ORDER_725, records: [{ collection: "expenses", recordId: "x" }] }), /can't be closed/)
  assert.equal(find((await engine.state()).orders, "CD-420725").effects.length, 1)
})
