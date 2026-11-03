// The reviewer in the engine (ticket 06), read through `state` and `apply` only.
// The model is the scripted gateway: permanent hand-written scenarios for the
// named orders, and "nothing to ask" for every other order. Expected values come
// from the dataset and the scenario fixtures, looked up by hand.

import assert from "node:assert/strict"
import { test } from "node:test"
import { createMemoryReviewCache } from "@/lib/reviewer/cache"
import { createPostgresReviewCache } from "@/lib/reviewer/postgres-cache"
import type { OrderState } from "./engine"
import { createPostgresStore } from "./postgres"
import { reviewResults } from "./schema"
import { failingGateway, testDatabase, testEngine, testGateway } from "./testing"

function find(orders: OrderState[], reference: string): OrderState {
  const found = orders.find((row) => row.reference === reference)
  assert.ok(found, `${reference} is in the snapshot`)
  return found
}

test("without a model key every order is 'not reviewed yet' and nothing fails", async () => {
  const engine = await testEngine()
  const before = await engine.state()
  for (const row of before.orders) {
    assert.equal(row.review.status, "not_reviewed", row.reference)
    assert.match(row.review.reason ?? "", /^not reviewed yet/)
    assert.ok(row.review.recordsRead > 0, `${row.reference} has records to read`)
    assert.equal(row.review.cost, 0)
  }
  const after = await engine.apply({ type: "review" })
  assert.ok(after.orders.every((row) => row.review.status === "not_reviewed"))
  assert.deepEqual(after.groupCounts, before.groupCounts)
})

test("orders with records the rules can't read go to the reviewer; the rest are left to the sweep", async () => {
  const { orders } = await (await testEngine()).state()
  // CD-420516: a customer note and site messages. CD-420089: named by an inbox thread.
  // CD-420593: an open EMPTY_PICKUP incident.
  for (const reference of ["CD-420516", "CD-420089", "CD-420593"]) assert.equal(find(orders, reference).review.trigger, "records", reference)
  assert.ok(find(orders, "CD-420516").review.triggers.some((text) => /note/.test(text)))
  // No conversation, note, claim, inbox thread or open alert/work/incident.
  for (const reference of ["CD-420145", "CD-420311", "CD-421056"]) assert.equal(find(orders, reference).review.trigger, "sweep", reference)
  // 54 orders have such records of their own; CD-420579, 692 and 735 read a conversation linked from another order.
  assert.equal(orders.filter((row) => row.review.trigger === "records").length, 57)
  assert.equal(orders.filter((row) => row.review.trigger === "sweep").length, 43)
})

test("the sweep reviews every order; a quiet Normal order says how many records the reviewer read and that it found no conflict", async () => {
  const gateway = await testGateway()
  const engine = await testEngine({ gateway })
  const state = await engine.apply({ type: "review" })
  assert.ok(state.orders.every((row) => row.review.status === "reviewed"), "every order is reviewed")
  const quiet = find(state.orders, "CD-420145")
  assert.equal(quiet.group, "normal")
  assert.equal(quiet.review.findings.length, 0)
  assert.match(quiet.reason, new RegExp(`Reviewer read ${quiet.review.recordsRead} records, no conflict`))
})

test("an order whose failed reviewer-pass rule the reviewer cleared says so; its reason never claims every check passed", async () => {
  const engine = await testEngine({ gateway: await testGateway() })
  const before = find((await engine.state()).orders, "CD-420338")
  assert.equal(before.rules.find((rule) => rule.id === "R7")?.outcome, "fail", "R7: the promise differs from the requested slot")
  assert.equal(before.group, "in_progress", "a reviewer pass is planned")
  const order = find((await engine.apply({ type: "review" })).orders, "CD-420338")
  assert.equal(order.review.findings.length, 0)
  assert.equal(order.group, "normal", "Normal: it passed the rules' first action, the reviewer")
  assert.match(order.reason, /The reviewer cleared “Delivery promise differs from the customer.s request”: The promise .* differs from the slot the customer requested/)
  assert.doesNotMatch(order.reason, /All \d+ checks passed|The rules found nothing to act on/)
})

test("a finding quotes its cited records; a routine site finding puts the order In progress (the agent calls)", async () => {
  const engine = await testEngine({ gateway: await testGateway() })
  const before = find((await engine.state()).orders, "CD-420516")
  assert.notEqual(before.group, "needs_action")
  const order = find((await engine.apply({ type: "review" })).orders, "CD-420516")
  assert.equal(order.group, "in_progress")
  assert.match(order.reason, /Agent will call .*Pickup key holder unknown/)
  const [finding] = order.review.findings
  assert.equal(finding.policyRow, "site-routine")
  const note = finding.cited.find((cited) => cited.recordId === "note-x7b4b75e5977108cd")
  assert.ok(note, "the customer's note is cited")
  assert.equal(note.role, "conflict")
  assert.equal(note.quote, "Use the side gate for vehicle collection.")
  assert.equal(note.value, "Use the side gate for vehicle collection.")
  const contact = finding.cited.find((cited) => cited.role === "contact")
  assert.equal(contact?.recordId, "ep-xf77895617a67a311")
  assert.ok(order.review.highlights.includes("msg-x5d8006558b9e7cc6"))
})

test("'nothing to ask' keeps a reviewed order out of Needs action on the reviewer's account", async () => {
  const engine = await testEngine({ gateway: await testGateway() })
  const order = find((await engine.apply({ type: "review" })).orders, "CD-420458")
  assert.equal(order.review.status, "reviewed")
  assert.equal(order.review.findings.length, 0)
  assert.match(order.review.summary ?? "", /nothing new to ask/)
})

test("the reviewer's model cost is recorded per order and kept when the review is served from the cache", async () => {
  const gateway = await testGateway()
  const reviewCache = createMemoryReviewCache()
  const first = await testEngine({ gateway, reviewCache })
  const state = await first.apply({ type: "review" })
  assert.equal(find(state.orders, "CD-420516").review.cost, 0.0213)
  // CD-420399: a finding, then a repair turn: 0.0201 + 0.0162.
  assert.ok(Math.abs(find(state.orders, "CD-420399").review.cost - 0.0363) < 1e-9)
  assert.ok(state.reviews.cost > 0.0213)
  // A second engine on the same cache (as the app after the seed sweep) makes no model call.
  const calls = gateway.calls.length
  const second = await testEngine({ gateway, reviewCache })
  const again = await second.apply({ type: "review" })
  assert.equal(gateway.calls.length, calls)
  assert.equal(find(again.orders, "CD-420516").review.cost, 0.0213)
})

test("moving the demo clock does not re-review: reviews read a stable time", async () => {
  const gateway = await testGateway()
  const engine = await testEngine({ gateway })
  await engine.apply({ type: "review" })
  const calls = gateway.calls.length
  const later = await engine.apply({ type: "advanceClock", minutes: 90 })
  assert.equal(find(later.orders, "CD-420516").review.status, "reviewed")
  await engine.apply({ type: "review" })
  assert.equal(gateway.calls.length, calls)
})

test("a failing model fails fast: few calls, and orders stay 'not reviewed yet' with the cause", async () => {
  const gateway = failingGateway("CONNECT 403")
  const engine = await testEngine({ gateway })
  const state = await engine.apply({ type: "review" })
  assert.ok(gateway.calls.length <= 8, `stopped after ${gateway.calls.length} calls`)
  for (const row of state.orders) assert.equal(row.review.status, "not_reviewed")
  assert.ok(state.orders.some((row) => /CONNECT 403/.test(row.review.reason ?? "")))
})

test("a review can be run for chosen orders only", async () => {
  const gateway = await testGateway()
  const engine = await testEngine({ gateway })
  const state = await engine.apply({ type: "review", orderIds: ["ord-00516"] })
  assert.equal(find(state.orders, "CD-420516").review.status, "reviewed")
  assert.equal(find(state.orders, "CD-420145").review.status, "not_reviewed")
  assert.equal(state.reviews.reviewed, 1)
})

test("reviews swept by one process are read by another from the Postgres cache, and survive a reset [postgres]", { skip: process.env.TEST_DATABASE_URL ? false : "set TEST_DATABASE_URL" }, async () => {
  const db = testDatabase()!
  await db.delete(reviewResults)
  const sweeper = await testEngine({ store: createPostgresStore(db), gateway: await testGateway(), reviewCache: createPostgresReviewCache(db) })
  await sweeper.apply({ type: "review", orderIds: ["ord-00516"] })
  // The app: no model key, its own cache instance.
  const app = await testEngine({ store: createPostgresStore(db), reviewCache: createPostgresReviewCache(db) })
  const order = find((await app.apply({ type: "reset" })).orders, "CD-420516")
  assert.equal(order.review.status, "reviewed")
  assert.equal(order.review.cost, 0.0213)
  assert.equal(order.group, "in_progress")
  await db.delete(reviewResults)
})
