// The Briefing (ticket 13): digests at 09:00, 12:00 and 16:00 on the demo clock and
// urgent pushes. Asserted through the engine only.

import assert from "node:assert/strict"
import { test } from "node:test"
import { createMemoryProseCache } from "./digest-prose"
import type { DigestItem, DigestProse, EngineState, PushItem } from "./engine"
import { eachStore, failingGateway, proseGateway, testEngine } from "./testing"

const START = "2026-10-21T09:00:00.000Z"
const NOON = "2026-10-21T12:00:00.000Z"
const FOUR = "2026-10-21T16:00:00.000Z"

const digests = (state: EngineState) => state.briefing.items.filter((item): item is DigestItem => item.kind === "digest")
const pushes = (state: EngineState) => state.briefing.items.filter((item): item is PushItem => item.kind === "push")
const digest = (state: EngineState, slot: string) => {
  const found = digests(state).find((item) => item.slot === slot)
  assert.ok(found, `the ${slot} digest arrived`)
  return found
}
const minutesTo = (at: string, from = START) => (new Date(at).getTime() - new Date(from).getTime()) / 60_000
/** The prose as plain text, order links shown as their reference. */
const plain = (prose: DigestProse["opener"]) => prose.map((segment) => "text" in segment ? segment.text : `[${segment.order.reference}]`).join("")

const countsMatch = (item: DigestItem, state: EngineState) => {
  const { needs_action, in_progress, solved, normal, done } = item.facts.counts
  assert.deepEqual({ needs_action, in_progress, solved, normal, done }, state.groupCounts)
  assert.equal(item.facts.counts.total, state.orders.length)
  assert.equal(item.facts.counts.urgent, state.orders.filter((row) => row.urgency.urgent).length)
}

eachStore("the 09:00 digest arrives at the start with counts that match the queue", async (engine) => {
  const state = await engine.apply({ type: "deliverBriefing" })
  assert.equal(digests(state).length, 1)
  const morning = digest(state, "09:00")
  assert.equal(morning.at, START)
  countsMatch(morning, state)
  assert.equal(morning.facts.changes, null)
  assert.equal(state.briefing.unread, 1)
})

eachStore("the 12:00 and 16:00 digests arrive when the clock reaches them, with the queue's counts then", async (engine) => {
  await engine.apply({ type: "deliverBriefing" })
  const beforeNoon = await engine.apply({ type: "advanceClock", minutes: minutesTo(NOON) - 15 })
  assert.equal(digests(beforeNoon).length, 1)
  const noon = await engine.apply({ type: "advanceClock", minutes: 15 })
  countsMatch(digest(noon, "12:00"), noon)
  assert.equal(digest(noon, "12:00").facts.since, START)
  const four = await engine.apply({ type: "advanceClock", minutes: minutesTo(FOUR, NOON) })
  countsMatch(digest(four, "16:00"), four)
  assert.deepEqual(digests(four).map((item) => item.slot), ["16:00", "12:00", "09:00"])
})

test("the digests are due items: next due item stops at 12:00 and 16:00", async () => {
  const engine = await testEngine()
  const start = await engine.state()
  const digestItems = start.dueItems.filter((item) => item.kind === "digest")
  assert.deepEqual(digestItems.map((item) => [item.at, item.due]), [[START, true], [NOON, false], [FOUR, false]])
  let state = start
  const stops: string[] = []
  while (state.nextDueAt) { state = await engine.apply({ type: "advanceToNextDue" }); stops.push(state.now) }
  assert.ok(stops.includes(NOON) && stops.includes(FOUR))
  assert.ok(digest(state, "16:00"))
})

test("the 12:00 digest says what changed since 09:00: CD-420009 and CD-420326 joined Needs action, and the 10:00 checks came due", async () => {
  const engine = await testEngine()
  const noon = digest(await engine.apply({ type: "advanceClock", minutes: minutesTo(NOON) }), "12:00")
  const joined = noon.facts.changes?.newNeedsAction.map((row) => row.reference) ?? []
  assert.ok(joined.includes("CD-420009") && joined.includes("CD-420326"), joined.join(", "))
  const due = noon.facts.changes?.cameDue.map((row) => row.reference) ?? []
  assert.ok(["CD-420015", "CD-420458", "CD-420516"].every((reference) => due.includes(reference)), due.join(", "))
})

test("every order line in a digest links to its order", async () => {
  const engine = await testEngine()
  const state = await engine.apply({ type: "deliverBriefing" })
  const morning = digest(state, "09:00")
  const byId = new Map(state.orders.map((row) => [row.id, row.reference]))
  const lines = [...morning.facts.urgent, ...morning.facts.needsAction]
  assert.ok(lines.length > 0)
  for (const line of lines) assert.equal(byId.get(line.orderId), line.reference)
  assert.ok(morning.facts.urgent.some((line) => line.reference === "CD-420437"), "CD-420437 is in the urgent block")
  const links = [...morning.prose.opener, ...morning.prose.firstMove].filter((segment) => "order" in segment)
  assert.ok(links.length > 0, "the template prose names orders as links")
  for (const segment of links) if ("order" in segment) assert.equal(byId.get(segment.order.orderId), segment.order.reference)
})

test("the model's prose is filled in: counts from the facts, order references as links", async () => {
  const gateway = proseGateway({
    opener: "{{count.needs_action}} orders need you, {{count.urgent}} of them urgent; {{order:CD-420437}} is due {{due:CD-420437}}.",
    firstMove: "Start with {{order:CD-420437}}.",
  })
  const engine = await testEngine({ briefing: { gateway } })
  const state = await engine.apply({ type: "deliverBriefing" })
  const { prose } = digest(state, "09:00")
  assert.equal(prose.source, "model")
  assert.equal(gateway.calls.length, 1)
  assert.equal(gateway.calls[0].effort, "low")
  assert.equal(gateway.calls[0].job, "digest")
  // "Urgent" in the prose is urgent and Blocked, like the Urgent tile; the time is in the control room's zone.
  const urgent = state.orders.filter((row) => row.urgency.urgent && row.group === "needs_action").length
  assert.ok(urgent < state.orders.filter((row) => row.urgency.urgent).length, "some urgent orders are not Blocked, so the count is a real check")
  assert.match(plain(prose.opener), new RegExp(`^${state.groupCounts.needs_action} orders need you, ${urgent} of them urgent; \\[CD-420437\\] is due 11:58\\.$`))
  const sent = JSON.parse(String(gateway.calls[0].messages[1].content)) as { counts: { urgent: number }; urgent: unknown[] }
  assert.equal(sent.counts.urgent, urgent, "the model reads the urgent Blocked count")
  assert.equal(sent.urgent.length, Math.min(urgent, 12), "the model's urgent list holds Blocked orders only")
  assert.equal(plain(prose.firstMove), "Start with [CD-420437].")
})

test("prose containing a typed digit is rejected and replaced with template text", async () => {
  const gateway = proseGateway({ opener: "There are 20 orders that need action.", firstMove: "Start with {{order:CD-420437}}." })
  const state = await (await testEngine({ briefing: { gateway } })).apply({ type: "deliverBriefing" })
  const { prose } = digest(state, "09:00")
  assert.equal(prose.source, "template")
  assert.match(prose.note ?? "", /digit/)
  assert.ok(!plain(prose.opener).includes("There are 20"))
  const urgentBlocked = state.orders.filter((row) => row.group === "needs_action" && row.urgency.urgent).length
  assert.ok(urgentBlocked > 0 && urgentBlocked < state.groupCounts.needs_action, "the demo has some, not all, Blocked orders urgent")
  assert.match(plain(prose.opener), new RegExp(`^Good morning\\. ${urgentBlocked} of the ${state.groupCounts.needs_action} blocked orders (is|are) urgent`))
  assert.doesNotMatch(plain(prose.opener), /\b0 /, "no zero counts")
  assert.doesNotMatch(plain(prose.firstMove), /work item:/, "the first move names the work, not its label")
})

test("prose that spells a count out in words is rejected too", async () => {
  const gateway = proseGateway({ opener: "Twenty urgent orders need attention.", firstMove: "Start with {{order:CD-420437}}." })
  const { prose } = digest(await (await testEngine({ briefing: { gateway } })).apply({ type: "deliverBriefing" }), "09:00")
  assert.equal(prose.source, "template")
  assert.match(prose.note ?? "", /number in words/)
})

test("prose naming an order that is not in the facts is rejected", async () => {
  const gateway = proseGateway({ opener: "Look at {{order:CD-999999}}.", firstMove: "Start there." })
  const { prose } = digest(await (await testEngine({ briefing: { gateway } })).apply({ type: "deliverBriefing" }), "09:00")
  assert.equal(prose.source, "template")
  assert.match(prose.note ?? "", /unknown placeholder/)
})

test("with no API key, a failing model or a slow model the digest still arrives with template text", async () => {
  const cases = [
    { name: "no key", briefing: undefined, note: /no model key/ },
    { name: "failing", briefing: { gateway: failingGateway("blocked") }, note: /failed/ },
    { name: "slow", briefing: { gateway: proseGateway({ opener: "Fine.", firstMove: "Fine." }, 10_000), timeoutMs: 100 }, note: /too slow/ },
  ]
  for (const item of cases) {
    const engine = await testEngine({ briefing: item.briefing })
    const began = Date.now()
    const state = await engine.apply({ type: "deliverBriefing" })
    const { prose } = digest(state, "09:00")
    assert.equal(prose.source, "template", item.name)
    assert.match(prose.note ?? "", item.note, item.name)
    assert.ok(Date.now() - began < 5_000, `${item.name}: the digest did not wait for the model`)
  }
})

test("digest prose is cached by its facts: a reset and re-delivery makes no second model call", async () => {
  const gateway = proseGateway({ opener: "{{count.urgent}} urgent.", firstMove: "Start with {{order:CD-420437}}." })
  const engine = await testEngine({ briefing: { gateway, cache: createMemoryProseCache() } })
  await engine.apply({ type: "deliverBriefing" })
  const again = await engine.apply({ type: "reset" })
  assert.equal(gateway.calls.length, 1)
  const { prose } = digest(again, "09:00")
  assert.equal(prose.source, "model")
  assert.equal(prose.cached, true)
})

eachStore("no push goes out at the start: the 09:00 digest covers what is urgent then", async (engine) => {
  const state = await engine.apply({ type: "deliverBriefing" })
  assert.deepEqual(pushes(state), [])
})

eachStore("an order turning urgent sends one push for that reason and no repeats", async (engine) => {
  await engine.apply({ type: "deliverBriefing" })
  // CD-420020's next check is at 13:00: within two hours from 11:00.
  const before = await engine.apply({ type: "advanceClock", minutes: minutesTo("2026-10-21T10:45:00Z") })
  assert.ok(!pushes(before).some((item) => item.reference === "CD-420020"))
  const at11 = await engine.apply({ type: "advanceClock", minutes: 15 })
  const sent = pushes(at11).filter((item) => item.reference === "CD-420020")
  assert.equal(sent.length, 1)
  assert.equal(sent[0].reason, "action_due")
  assert.equal(sent[0].at, "2026-10-21T11:00:00.000Z")
  assert.equal(sent[0].read, false)
  for (let step = 0; step < 4; step += 1) await engine.apply({ type: "advanceClock", minutes: 15 })
  await engine.apply({ type: "deliverBriefing" })
  const later = await engine.state()
  assert.equal(pushes(later).filter((item) => item.reference === "CD-420020").length, 1)
  const keys = pushes(later).map((item) => `${item.orderId}:${item.reason}`)
  assert.equal(new Set(keys).size, keys.length, "at most one push per order per reason")
})

test("an order already urgent at the start for a reason is not pushed again for it (CD-420347's 12:00 check)", async () => {
  const engine = await testEngine()
  const four = await engine.apply({ type: "advanceClock", minutes: minutesTo(FOUR) })
  assert.ok(!pushes(four).some((item) => item.reference === "CD-420347"))
  assert.deepEqual(pushes(four).map((item) => item.reference).sort(), ["CD-420010", "CD-420020", "CD-420023"])
})

eachStore("marking items read clears the badge; reset empties the Briefing and brings the 09:00 digest back", async (engine) => {
  await engine.apply({ type: "advanceClock", minutes: minutesTo(NOON) })
  const noon = await engine.state()
  assert.equal(noon.briefing.unread, noon.briefing.items.length)
  const read = await engine.apply({ type: "markBriefingRead", ids: [digest(noon, "09:00").id] })
  assert.equal(read.briefing.unread, noon.briefing.items.length - 1)
  assert.equal((await engine.apply({ type: "markBriefingRead" })).briefing.unread, 0)
  const reset = await engine.apply({ type: "reset" })
  assert.deepEqual(reset.briefing.items.map((item) => item.id), ["digest:09:00"])
  assert.equal(reset.briefing.unread, 1)
})
