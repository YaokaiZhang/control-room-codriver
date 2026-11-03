// Rule checks and the four groups, read through the engine's `state(now)` only.
// Expected values come from the dataset (docs/PRD.md §5.2) and the spec, not from
// the rule code: each named order was looked up by hand in dataset/data.

import assert from "node:assert/strict"
import { test } from "node:test"
import { rankNeedsAction, type EngineState, type OrderState } from "./engine"
import { testEngine } from "./testing"

let atStart: Promise<EngineState> | null = null
function snapshotState(): Promise<EngineState> {
  atStart ??= testEngine().then((engine) => engine.state())
  return atStart
}

async function order(reference: string, now?: string): Promise<OrderState> {
  const state = now ? await (await testEngine()).state(now) : await snapshotState()
  const found = state.orders.find((row) => row.reference === reference)
  assert.ok(found, `${reference} is in the snapshot`)
  return found
}

function rule(state: OrderState, id: string) {
  const found = state.rules.find((row) => row.id === id)
  assert.ok(found, `${state.reference} reports rule ${id}`)
  return found
}

test("every order is in exactly one of the four groups and the counts add up to 100", async () => {
  const state = await snapshotState()
  const groups = ["needs_action", "in_progress", "normal", "done"]
  for (const row of state.orders) assert.ok(groups.includes(row.group), `${row.reference} has group ${row.group}`)
  const total = Object.values(state.groupCounts).reduce((sum, count) => sum + count, 0)
  assert.equal(total, 100)
  for (const group of groups) {
    assert.equal(state.groupCounts[group as keyof typeof state.groupCounts], state.orders.filter((row) => row.group === group).length)
  }
})

function failing(state: EngineState, id: string): string[] {
  return state.orders.filter((row) => row.rules.find((r) => r.id === id)?.outcome === "fail").map((row) => row.reference).sort()
}

test("signed release: a missing verified release-authority document fires; within 48 h it plans a site call", async () => {
  const soon = await order("CD-420399") // site-043 requires a release, pickup 22 Oct 09:00Z, no document
  assert.equal(rule(soon, "R1").outcome, "fail")
  assert.equal(rule(soon, "R1").firstAction, "site_call")
  assert.ok(soon.planned.some((action) => action.kind === "site_call" && action.ruleIds.includes("R1") && action.callee?.handle))

  const later = await order("CD-420404") // site-011 requires a release, pickup 27 Oct, no document
  assert.equal(rule(later, "R1").outcome, "fail")
  assert.equal(rule(later, "R1").firstAction, "show_person")
  assert.equal(later.group, "needs_action")

  const noContact = await order("CD-420405") // pickup 23 Oct 08:00Z, but no pickup contact handle
  assert.equal(rule(noContact, "R1").firstAction, "show_person")

  // CD-420458 (seller withdrew release, doc-0262 MISSING) and CD-421044 are intake orders with no plan yet:
  // the order's own pickup site still requires a release.
  const verified = await order("CD-420071") // doc-release-00071 VERIFIED
  assert.equal(rule(verified, "R1").outcome, "pass")
  assert.ok(rule(verified, "R1").sources.some((source) => source.id === "doc-release-00071"))

  assert.deepEqual(failing(await snapshotState(), "R1"),
    ["CD-420399", "CD-420404", "CD-420405", "CD-420412", "CD-420442", "CD-420458", "CD-420578", "CD-420585", "CD-420719", "CD-421044"])
})

test("positioning that skips another live duty of the same driver fires on CD-420089 only, for a reviewer pass", async () => {
  // drv-055 positions for CD-420089 from CD-420576, but is also booked on CD-420719 (pickup 22 Oct) in between.
  const skipped = await order("CD-420089")
  assert.equal(rule(skipped, "R3").outcome, "fail")
  assert.equal(rule(skipped, "R3").firstAction, "reviewer_pass")
  assert.ok(rule(skipped, "R3").sources.some((source) => source.id === "asg-xb8ad81e2d1e793a9"))
  assert.ok(skipped.planned.some((action) => action.kind === "reviewer_pass" && action.ruleIds.includes("R3")))

  assert.equal(rule(await order("CD-420405"), "R3").outcome, "pass") // drv-275 has no other duty
  assert.equal(rule(await order("CD-420004"), "R3").outcome, "pass") // no positioning recorded
  assert.deepEqual(failing(await snapshotState(), "R3"), ["CD-420089"])
})

test("a selected promise that differs from the customer's requested delivery slot fires on five open orders, for a reviewer pass", async () => {
  // CD-420338: promise 21 Oct 10:00–14:00Z, customer asked for 22 Oct 10:00–14:00Z.
  const differs = await order("CD-420338")
  assert.equal(rule(differs, "R7").outcome, "fail")
  assert.equal(rule(differs, "R7").firstAction, "reviewer_pass")
  assert.deepEqual(rule(differs, "R7").sources.map((source) => source.collection), ["time_windows", "time_windows"])

  // CD-420694 had the same mismatch but was delivered; the promise is history.
  assert.equal(rule(await order("CD-420694"), "R7").outcome, "pass")
  assert.deepEqual(failing(await snapshotState(), "R7"), ["CD-420338", "CD-420405", "CD-420578", "CD-420584", "CD-420719"])
})

test("CD-420806 is flagged for a stale-tracking driver check-in and is not shown as late", async () => {
  // Last driver-app position 21 Oct 02:12Z (6.8 h before 09:00Z), no alert; ETA 11:40Z inside the 09:00–13:00Z promise.
  const stale = await order("CD-420806")
  assert.equal(rule(stale, "R10").outcome, "fail")
  assert.equal(rule(stale, "R10").firstAction, "driver_call")
  assert.ok(rule(stale, "R10").sources.some((source) => source.collection === "tracking_observations"))
  assert.equal(rule(stale, "R12").outcome, "pass")
  assert.ok(!stale.urgency.reasons.some((reason) => reason.kind === "promise_at_risk"))
  assert.ok(stale.planned.some((action) => action.kind === "driver_call" && action.ruleIds.includes("R10")))
  assert.equal(stale.group, "in_progress")

  // CD-420322's position is as old but a tracking-gap alert is open: a person already has it.
  assert.equal(rule(await order("CD-420322"), "R10").outcome, "pass")
  // CD-420735 and CD-421013 are in transit with no position at all.
  assert.deepEqual(failing(await snapshotState(), "R10"), ["CD-420735", "CD-420806", "CD-421013"])
})

test("an ETA after the promise end plans a driver call", async () => {
  // CD-420439: latest ETA 26 Oct 13:43Z, promise ends 13:00Z.
  const late = await order("CD-420439")
  assert.equal(rule(late, "R12").outcome, "fail")
  assert.equal(rule(late, "R12").firstAction, "driver_call")
  assert.ok(late.planned.some((action) => action.kind === "driver_call" && action.ruleIds.includes("R12")))
  assert.deepEqual(failing(await snapshotState(), "R12"), ["CD-420439"])
  // An order in transit with no ETA can't be checked.
  assert.equal(rule(await order("CD-420735"), "R12").outcome, "unknown")
})

test("a pickup slot that passed with no pickup is shown to a person, and the clock moves it", async () => {
  // CD-420593: slot 21 Oct 06:00–08:00Z, no vehicle.picked_up event.
  const missed = await order("CD-420593")
  assert.equal(rule(missed, "R11").outcome, "fail")
  assert.equal(rule(missed, "R11").firstAction, "show_person")
  assert.equal(missed.group, "needs_action")
  assert.deepEqual(failing(await snapshotState(), "R11"), ["CD-420593"])

  // CD-420399's slot is 22 Oct from 09:00Z; a day later it has passed too.
  assert.equal(rule(await order("CD-420399"), "R11").outcome, "pass")
  const dayLater = await order("CD-420399", "2026-10-23T00:00:00Z")
  assert.equal(rule(dayLater, "R11").outcome, "fail")
  assert.equal(dayLater.group, "needs_action")
})

test("a positioning expense with no reservation on its assignment asks for a reviewer pass", async () => {
  // CD-420399: €137.10 train positioning claim, the assignment has no travel reservation.
  const claim = await order("CD-420399")
  assert.equal(rule(claim, "R13").outcome, "fail")
  assert.equal(rule(claim, "R13").firstAction, "reviewer_pass")
  assert.ok(rule(claim, "R13").sources.some((source) => source.id === "expense-x9d676667cdd4f893"))
  // CD-420089's bus and taxi claims sit beside a booked train reservation.
  assert.equal(rule(await order("CD-420089"), "R13").outcome, "pass")
  assert.deepEqual(failing(await snapshotState(), "R13"), ["CD-420291", "CD-420399", "CD-420537"])
})

const STRONG = ["R1", "R3", "R7", "R10", "R11", "R12", "R13"]
const FIRST_ACTIONS = ["site_call", "driver_call", "reviewer_pass", "show_person", "operator_proposal"]

test("every order reports every strong rule as passed, failed or not evaluable, and each failure declares a first action", async () => {
  const state = await snapshotState()
  for (const row of state.orders) {
    assert.deepEqual(row.rules.filter((r) => r.strength === "strong" && r.id !== "CLOSE" && r.id !== "NEXT").map((r) => r.id), STRONG, row.reference)
    for (const r of row.rules) {
      assert.ok(["pass", "fail", "unknown"].includes(r.outcome))
      if (r.outcome === "fail") assert.ok(FIRST_ACTIONS.includes(r.firstAction ?? ""), `${row.reference} ${r.id} declares a first action`)
      if (r.strength === "weak") assert.notEqual(r.outcome, "fail", "weak rules never fail")
    }
    // No Needs action order without something to decide.
    if (row.group === "needs_action") assert.ok(row.rules.some((r) => r.outcome === "fail" && r.firstAction === "show_person"), row.reference)
  }
})

test("18 orders have a weak-signal site call planned at load, and only to a known contact", async () => {
  const state = await snapshotState()
  const weak = new Set(["R4", "R5", "R6"])
  const calls = state.orders.filter((row) => row.planned.some((action) => action.kind === "site_call" && action.ruleIds.some((id) => weak.has(id))))
  // 18 pickups within 48 h have a contact handle. 4 of them are on the customer side and are
  // still called, as pickup-readiness calls (ADR 0001 amendment): CD-420719's site is the
  // customer's own, CD-420449/1011/1051's pickup contact is a person the customer gave.
  assert.equal(calls.length, 18)
  for (const row of calls) {
    const call = row.planned.find((action) => action.kind === "site_call")
    assert.ok(call?.callee?.handle, `${row.reference} calls a known contact`)
  }
  // CD-420015: pickup 22 Oct 08:00Z, both contacts unconfirmed (customer order input).
  assert.ok(calls.some((row) => row.reference === "CD-420015"))
  // CD-420123 and CD-421024 pick up within 48 h but have no pickup contact handle: no call, only "couldn't check".
  for (const reference of ["CD-420123", "CD-421024"]) {
    const silent = await order(reference)
    assert.equal(silent.planned.length, 0, reference)
    assert.ok(silent.rules.some((r) => r.id === "R5" && r.outcome === "unknown"), reference)
  }
})

test("weak signals go to couldn't check: contact missing, confirmed only from the site profile, promise not from the customer", async () => {
  // CD-420010: the pickup contact has no name and no handle.
  assert.equal(rule(await order("CD-420010"), "R5").outcome, "unknown")
  // CD-420154: pickup confirmed from MANAGED_SITE_PROFILE; promise source SYSTEM or OPS.
  const profile = await order("CD-420154")
  assert.equal(rule(profile, "R4").outcome, "unknown")
  assert.ok(rule(profile, "R4").sources.some((source) => source.collection === "order_endpoint_details"))
  assert.equal(rule(profile, "R6").outcome, "unknown")
  // CD-420449: both contacts named and confirmed by nobody yet, promise from the customer.
  const unconfirmed = await order("CD-420449")
  assert.equal(rule(unconfirmed, "R5").outcome, "unknown")
  assert.equal(rule(unconfirmed, "R4").outcome, "pass")
  assert.equal(rule(unconfirmed, "R6").outcome, "pass")
})

test("urgency comes from the rules and the clock, and Needs action is ranked by it", async () => {
  // CD-420458: the open release thread's next check is 21 Oct 10:00Z, within 2 h.
  const due = await order("CD-420458")
  assert.ok(due.urgency.urgent)
  assert.ok(due.urgency.reasons.some((reason) => reason.kind === "action_due"))
  // CD-420593: the slot passed this morning and the pickup contact is unconfirmed.
  assert.ok((await order("CD-420593")).urgency.reasons.some((reason) => reason.kind === "pickup_unready"))
  // CD-420404 picks up on 27 Oct: not urgent.
  assert.equal((await order("CD-420404")).urgency.urgent, false)

  const ranked = rankNeedsAction((await snapshotState()).orders)
  assert.ok(ranked.every((row) => row.group === "needs_action"))
  const position = (reference: string) => ranked.findIndex((row) => row.reference === reference)
  assert.ok(position("CD-420458") < position("CD-420404"))
  assert.ok(position("CD-420593") < position("CD-420404"))
  const firstCalm = ranked.findIndex((row) => !row.urgency.urgent)
  assert.ok(ranked.slice(firstCalm).every((row) => !row.urgency.urgent), "urgent orders come first")
})

test("Done holds only finished orders with nothing open; a delivered order with a gap is not Done", async () => {
  // CD-420164: delivered, but the signed handover (doc-0264) is MISSING and an alert and a work item are open.
  const handover = await order("CD-420164")
  assert.equal(handover.group, "needs_action")
  assert.equal(rule(handover, "CLOSE").outcome, "fail")
  assert.ok(rule(handover, "CLOSE").sources.some((source) => source.id === "doc-0264"))
  assert.equal(rule(handover, "CLOSE").title, "Finished order still has loose ends")
  assert.equal(rule(handover, "CLOSE").sources.find((source) => source.id === "doc-0264")?.label, "Signed handover missing")
  // CD-420055: delivered, but the trade-in leg (asg-xb21b8c6f3175033c) is still on the road.
  const tradeIn = await order("CD-420055")
  assert.equal(tradeIn.group, "needs_action")
  assert.ok(rule(tradeIn, "CLOSE").sources.some((source) => source.id === "asg-xb21b8c6f3175033c"))
  // CD-420291: delivered with nothing open, but two positioning claims have no reservation (strong gap).
  const strongGap = await order("CD-420291")
  assert.equal(rule(strongGap, "R13").outcome, "fail")
  assert.equal(rule(strongGap, "R13").firstAction, "show_person")
  assert.equal(strongGap.group, "needs_action")
  // CD-420747: delivered, nothing open, but the delivery contact was never on record: Normal, gap listed.
  const weakGap = await order("CD-420747")
  assert.equal(weakGap.group, "normal")
  assert.equal(rule(weakGap, "R5").outcome, "unknown")
  assert.equal(weakGap.planned.length, 0)
  // CD-420111 (delivered) and CD-420201 (cancelled) have nothing open.
  assert.equal((await order("CD-420111")).group, "done")
  assert.equal((await order("CD-420201")).group, "done")

  const state = await snapshotState()
  for (const row of state.orders.filter((o) => o.group === "done")) {
    assert.ok(["DELIVERED", "CANCELLED"].includes(row.status) || row.reference === "CD-420201" || row.reference === "CD-420419", row.reference)
    assert.ok(row.rules.every((r) => r.outcome === "pass"), `${row.reference} has nothing open`)
  }
})
