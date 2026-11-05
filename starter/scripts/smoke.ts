import { appFetch } from "./app-fetch"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

type Source = { id: string; order_id?: string; plan_id?: string; active_plan_id?: string; vehicle_id?: string;
  status?: string; type?: string; synthetic_vin?: string | null; boundary?: string;
  link_state?: string; candidate_order_ids?: string[]; linked_order_ids?: string[];
  contact_name?: string | null; contact_handle?: string | null }
type Related = { id: string; details: Source }
type SmokeCall = { id: string; state: string; line?: string; callee?: { contactType: string }; tier: number; transcript: { wallAt: string }[]; cost: { totalEur: number; operatorEur: number }
  outcome?: string | null; handover?: { question: string; nextStep: string; summary: string; closed: unknown } | null }
type OrderResponse = { order: { id: string }; items: { vehicle: { syntheticVin: string | null } }[];
  related: Record<string, Related[]> }

async function readRows(collection: string): Promise<Source[]> {
  const path = join(process.env.DATASET_DIR ?? join(process.cwd(), "..", "dataset", "data"), `${collection}.jsonl`)
  return (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Source)
}

function sameIds(actual: Related[], expected: Source[], label: string): void {
  const actualIds = actual.map((row) => row.id).sort()
  const expectedIds = expected.map((row) => row.id).sort()
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
    throw new Error(`${label} mismatch: API=${actualIds.join(",")} source=${expectedIds.join(",")}`)
  }
}

async function main(): Promise<void> {
  const [orders, plans, points, segments] = await Promise.all([
    readRows("orders"), readRows("transport_plans"),
    readRows("transport_points"), readRows("transport_segments"),
  ])
  const order = orders.find((row) => {
    const planId = row.active_plan_id
    return planId && points.some((point) => point.plan_id === planId)
      && segments.some((segment) => segment.plan_id === planId)
  })
  if (!order?.active_plan_id) throw new Error("No order with a plan, points and segments in the source dataset")

  const base = process.env.APP_URL ?? "http://localhost:3000"
  const response = await appFetch(`${base}/api/orders/${order.id}`)
  if (!response.ok) throw new Error(`Order API returned ${response.status} from ${base}`)
  const body = await response.json() as OrderResponse
  if (body.order.id !== order.id) throw new Error("Order API returned a different order")
  const orderPlans = plans.filter((plan) => plan.order_id === order.id)
  const planIds = new Set(orderPlans.map((plan) => plan.id))
  sameIds(body.related.transport_plans ?? [], orderPlans, "plans")
  sameIds(body.related.transport_points ?? [], points.filter((point) => planIds.has(point.plan_id ?? "")), "plan points")
  sameIds(body.related.transport_segments ?? [], segments.filter((segment) => planIds.has(segment.plan_id ?? "")), "plan segments")
  const [vehicles, items, ferryBookings, custodyReports, terminals, roadEstimates, proposals, steps] = await Promise.all([
    readRows("vehicles"), readRows("order_items"), readRows("travel_reservations"),
    readRows("custody_reports"), readRows("ferry_terminals"), readRows("terminal_road_estimates"),
    readRows("agent_proposals"), readRows("assignment_steps"),
  ])
  const vehicleById = new Map(vehicles.map((vehicle) => [vehicle.id, vehicle]))
  const expectedVins = items.filter((item) => item.order_id === order.id)
    .map((item) => vehicleById.get(String(item.vehicle_id))?.synthetic_vin).sort()
  const actualVins = body.items.map((item) => item.vehicle.syntheticVin).sort()
  if (JSON.stringify(actualVins) !== JSON.stringify(expectedVins)) throw new Error("Order API lost synthetic VINs")

  const [missedResponse, custodyResponse, referenceResponse, relayResponse, proposalResponse, travelResponse, bundleResponse] = await Promise.all([
    appFetch(`${base}/api/orders/ord-00194`),
    appFetch(`${base}/api/orders/ord-00004`),
    appFetch(`${base}/api/reference-data`),
    appFetch(`${base}/api/orders/ord-00702`),
    appFetch(`${base}/api/orders/ord-00299`),
    appFetch(`${base}/api/orders/ord-00449`),
    appFetch(`${base}/api/orders/ord-00384`),
  ])
  if (!missedResponse.ok || !custodyResponse.ok || !referenceResponse.ok ||
      !relayResponse.ok || !proposalResponse.ok || !travelResponse.ok || !bundleResponse.ok) {
    throw new Error("One of the detailed evidence routes did not load")
  }
  const missed = await missedResponse.json() as OrderResponse
  const custody = await custodyResponse.json() as OrderResponse
  const reference = await referenceResponse.json() as { related: Record<string, Related[]> }
  const relay = await relayResponse.json() as OrderResponse
  const proposalCase = await proposalResponse.json() as OrderResponse
  const travelCase = await travelResponse.json() as OrderResponse
  const bundleCase = await bundleResponse.json() as OrderResponse & {
    events: { command: string; targetId: string }[]
  }
  sameIds(missed.related.travel_reservations ?? [], ferryBookings.filter((row) => row.order_id === "ord-00194"), "ferry history")
  if (!missed.related.travel_reservations?.some((row) => row.details.status === "MISSED_CHECK_IN")) {
    throw new Error("Original missed ferry status disappeared")
  }
  sameIds(custody.related.custody_reports ?? [], custodyReports.filter((row) => row.order_id === "ord-00004"), "custody reports")
  sameIds(reference.related.ferry_terminals ?? [], terminals, "shared ferry terminals")
  sameIds(reference.related.terminal_road_estimates ?? [], roadEstimates, "shared road estimates")
  const relayPlanIds = new Set(plans.filter((row) => row.order_id === "ord-00702").map((row) => row.id))
  sameIds(relay.related.transport_segments ?? [], segments.filter((row) => relayPlanIds.has(row.plan_id ?? "")), "relay legs")
  sameIds(proposalCase.related.agent_proposals ?? [], proposals.filter((row) => row.order_id === "ord-00299"), "agent review records")
  sameIds(travelCase.related.assignment_steps ?? [], steps.filter((row) => row.order_id === "ord-00449"), "assignment itinerary")
  const bundleOffer = (bundleCase.related.market_offers ?? []).find((row) =>
    row.details.type === "BUNDLE" && row.details.status === "ACCEPTED")
  if (!bundleOffer) {
    throw new Error("Second bundle order lost the shared accepted offer")
  }
  if (!bundleCase.events.some((row) => row.command === "offer.accepted" && row.targetId === bundleOffer.id)) {
    throw new Error("Second bundle order lost the shared acceptance history")
  }
  const [ownedBoardResponse, ownedDetailResponse, resolvedDetailResponse] = await Promise.all([
    appFetch(`${base}/api/overview?q=CD-420593`),
    appFetch(`${base}/api/orders/ord-00593`),
    appFetch(`${base}/api/orders/ord-00020`),
  ])
  if (!ownedBoardResponse.ok || !ownedDetailResponse.ok || !resolvedDetailResponse.ok) {
    throw new Error("Alert lifecycle routes did not load")
  }
  const ownedBoard = await ownedBoardResponse.json() as { visible: { id: string; acknowledgedAlerts: string[] }[] }
  const ownedDetail = await ownedDetailResponse.json() as { alerts: { status: string; details: { owner?: string } }[] }
  const resolvedDetail = await resolvedDetailResponse.json() as { alerts: { status: string }[] }
  if (ownedBoard.visible.find((row) => row.id === "ord-00593")?.acknowledgedAlerts.length !== 1 ||
      !ownedDetail.alerts.some((alert) => alert.status === "ACKNOWLEDGED" && alert.details.owner === "ops-shift") ||
      !resolvedDetail.alerts.some((alert) => alert.status === "RESOLVED")) {
    throw new Error("Acknowledged or resolved alert evidence disappeared from the starter API")
  }
  const [identityResponse, contactResponse, streetResponse, supportResponse] = await Promise.all([
    appFetch(`${base}/api/orders/ord-00009`),
    appFetch(`${base}/api/orders/ord-00010`),
    appFetch(`${base}/api/orders/ord-00023`),
    appFetch(`${base}/api/orders/ord-00015`),
  ])
  if ([identityResponse, contactResponse, streetResponse, supportResponse].some((res) => !res.ok)) {
    throw new Error("One of the incomplete-input or support cases did not load")
  }
  const identity = await identityResponse.json() as OrderResponse
  const contact = await contactResponse.json() as OrderResponse
  const street = await streetResponse.json() as OrderResponse & { pickup: { details: { address_line1: string | null } } }
  const support = await supportResponse.json() as OrderResponse & {
    conversations: { details: { waiting_on?: string; owner?: string } }[];
    messages: { body: string }[]
  }
  if (!identity.items.some((item) => item.vehicle.syntheticVin === null)) {
    throw new Error("Missing vehicle identity was filled in by the starter")
  }
  if (!contact.related.order_endpoint_details?.some((row) => row.details.boundary === "PICKUP" &&
      row.details.contact_name === null && row.details.contact_handle === null)) {
    throw new Error("Missing pickup contact was filled in by the starter")
  }
  if (street.pickup.details.address_line1 !== null) {
    throw new Error("Missing pickup street was filled in by the starter")
  }
  if (support.messages.length !== 5 ||
      !support.conversations.some((row) => row.details.waiting_on === "SITE_CONFIRMATION" &&
        row.details.owner === "ops-readiness")) {
    throw new Error("Delayed support handoff was lost from the starter API")
  }
  const inboxResponse = await appFetch(`${base}/api/inbox`)
  if (!inboxResponse.ok) throw new Error("Unlinked support inbox did not load")
  const inbox = await inboxResponse.json() as {
    threads: { id: string; order_id?: string; link_state: string;
      candidate_order_ids: string[]; linked_order_ids: string[] }[];
    messages: { id: string; thread_id: string; order_id?: string }[]
  }
  const [sourceThreads, sourceMessages] = await Promise.all([
    readRows("support_inbox_threads"), readRows("support_inbox_messages"),
  ])
  if (inbox.threads.length !== sourceThreads.length || inbox.messages.length !== sourceMessages.length ||
      inbox.threads.some((thread) => "order_id" in thread) ||
      inbox.messages.some((message) => "order_id" in message) ||
      !inbox.threads.some((thread) => thread.link_state === "PENDING_MATCH" &&
        thread.candidate_order_ids.length > 1 && thread.linked_order_ids.length === 0) ||
      !inbox.threads.some((thread) => thread.link_state === "NO_ORDER_REQUIRED" &&
        thread.linked_order_ids.length === 0) ||
      !inbox.threads.some((thread) => thread.link_state === "CONFIRMED_SINGLE" &&
        thread.linked_order_ids.length === 1)) {
    throw new Error("Inbox link uncertainty was lost from the starter API")
  }
  // The board and the order record must agree on whether an order needs a person.
  // Background calls run in the server while smoke reads (ticket 10): an order whose call moved after this
  // moment may change group between the queue read and the order read, so those are not compared.
  const overviewReadAt = Date.now()
  const overviewResponse = await appFetch(`${base}/api/overview`)
  if (!overviewResponse.ok) throw new Error("Overview did not load")
  const overview = await overviewResponse.json() as {
    total: number; groupCounts: Record<string, number>; now: string
    visible: { id: string; reference: string; attention: unknown[]; verdict?: { group: string } }[]
  }
  // The shell's demo clock and the queue read the same engine clock (read only: smoke never moves it).
  const clockResponse = await appFetch(`${base}/api/clock`)
  if (!clockResponse.ok) throw new Error(`Clock API returned ${clockResponse.status}`)
  const clock = await clockResponse.json() as { now: string; nextDueAt: string | null }
  if (clock.now !== overview.now) throw new Error(`The demo clock says ${clock.now} but the queue was computed at ${overview.now}`)
  const groupTotal = Object.values(overview.groupCounts ?? {}).reduce((sum, count) => sum + count, 0)
  if (groupTotal !== overview.total || overview.visible.length !== overview.total) {
    throw new Error(`Group counts add up to ${groupTotal}, not ${overview.total} orders`)
  }
  // Ticket 13: the Briefing has a digest for every slot the clock reached, and the latest
  // digest's counts match the queue when the clock sits at its time. (Reading it delivers
  // what is due, which never moves the clock.)
  const briefingResponse = await appFetch(`${base}/api/briefing`)
  if (!briefingResponse.ok) throw new Error(`Briefing API returned ${briefingResponse.status}`)
  const briefing = await briefingResponse.json() as { now: string; items: { kind: string; slot?: string; at: string; facts?: { counts: Record<string, number> } }[] }
  const reached = ["09:00", "12:00", "16:00"].filter((slot) => `${overview.now.slice(0, 10)}T${slot}:00.000Z` <= overview.now)
  const slots = briefing.items.filter((item) => item.kind === "digest").map((item) => item.slot)
  if (overview.now.slice(0, 10) === "2026-10-21" && reached.some((slot) => !slots.includes(slot))) {
    throw new Error(`The Briefing has digests for ${slots.join(", ") || "nothing"}, but the clock reached ${reached.join(", ")}`)
  }
  const latest = briefing.items.find((item) => item.kind === "digest")
  // Background calls (ticket 10) change groups without moving the clock: a digest delivered before
  // a call moved is checked against the queue only when no call moved since (see below).
  let digestOff: string[] = []
  if (latest?.facts && latest.at === overview.now) {
    digestOff = Object.entries(overview.groupCounts).filter(([group, count]) => latest.facts!.counts[group] !== count).map(([group]) => group)
    if (!digestOff.length) console.log(`Briefing: the ${latest.slot} digest's counts match the queue.`)
  } else {
    console.log(`Briefing: ${slots.length} digests; the clock is not at a digest time, so counts are not compared.`)
  }
  let lastCallMove = 0
  const disagreements: string[] = []
  const groupDisagreements: string[] = []
  const reviewProblems: string[] = []
  let reviewed = 0
  const callProblems: string[] = []
  let callCount = 0
  let running = 0
  let movedByCalls = 0
  const effectProblems: string[] = []
  let effectCount = 0
  for (let index = 0; index < overview.visible.length; index += 10) {
    const cards = overview.visible.slice(index, index + 10)
    const views = await Promise.all(cards.map(async (card) => {
      const detailResponse = await appFetch(`${base}/api/orders/${card.id}`)
      if (!detailResponse.ok) throw new Error(`Order API returned ${detailResponse.status} for ${card.id}`)
      const detail = await detailResponse.json() as { view: { attention: unknown[] }; checks: { group: string; review?: { status: string; recordsRead: number; findings: unknown[] }; calls?: SmokeCall[]
        effects?: { id: string; type: string; version: number; text: string; by: string }[]; history?: { kind: string; effectId: string | null }[] } | null }
      return detail
    }))
    cards.forEach((card, position) => {
      const recordAttention = views[position].view.attention
      const recordGroup = views[position].checks?.group
      // Ticket 10: every call shows its tier, state, transcript and a cost below the operator's.
      const calls = views[position].checks?.calls
      if (!Array.isArray(calls)) callProblems.push(`${card.reference} (no calls list)`)
      for (const call of calls ?? []) {
        callCount += 1
        lastCallMove = Math.max(lastCallMove, Date.parse(call.transcript.at(-1)?.wallAt ?? "") || 0)
        if (call.state !== "ended") running += 1
        // ADR 0001 (amended): never the paying customer; the customer side only on the pickup (site) line.
        const customerSideCall = call.callee?.contactType === "paying_customer"
          || (["customer_given_contact", "customer_owned_site"].includes(call.callee?.contactType ?? "") && call.line !== "site")
        if (customerSideCall || ![1, 2, 3].includes(call.tier) || !call.transcript?.length || !(call.cost?.operatorEur > 0) || !(call.cost.totalEur <= call.cost.operatorEur)) {
          callProblems.push(`${card.reference} ${call.id}`)
        }
        // Ticket 14: a handover is tier 3 with its open question, next step and summary; an open one holds Needs action.
        if (call.outcome === "handover" && (call.tier !== 3 || !call.handover?.question || !call.handover.nextStep || !call.handover.summary)) {
          callProblems.push(`${card.reference} ${call.id} (handover without tier 3, question, next step or summary)`)
        }
        if (call.handover && !call.handover.closed && recordGroup !== "needs_action") callProblems.push(`${card.reference} ${call.id} (open handover outside Needs action)`)
      }
      const moved = (calls ?? []).some((call) => call.state !== "ended" || Date.parse(call.transcript.at(-1)?.wallAt ?? "") >= overviewReadAt - 2_000)
      if (moved) movedByCalls += 1
      if (!moved && (!card.verdict || card.verdict.group !== recordGroup)) {
        groupDisagreements.push(`${card.reference} (queue ${card.verdict?.group ?? "none"}, order ${recordGroup ?? "none"})`)
      }
      // Ticket 09: every order lists its effect events (each a version >= 2 with who committed it), and each is in its history.
      const checks = views[position].checks
      if (checks && (!Array.isArray(checks.effects) || !Array.isArray(checks.history))) effectProblems.push(`${card.reference} (no effects or history list)`)
      for (const effect of checks?.effects ?? []) {
        effectCount += 1
        if (!(effect.version >= 2) || !effect.text || !effect.by || !checks?.history?.some((entry) => entry.effectId === effect.id)) effectProblems.push(`${card.reference} ${effect.id}`)
      }
      // Ticket 06: every order says whether the reviewer read it, and how many records.
      const review = views[position].checks?.review
      if (!review || !["reviewed", "not_reviewed"].includes(review.status) || !(review.recordsRead > 0)) reviewProblems.push(card.reference)
      else if (review.status === "reviewed") reviewed += 1
      if ((card.attention.length > 0) !== (recordAttention.length > 0)) {
        disagreements.push(`${card.reference} (board ${card.attention.length}, record ${recordAttention.length})`)
      }
    })
  }
  if (groupDisagreements.length) {
    throw new Error(`Queue and order API disagree on the group: ${groupDisagreements.join(", ")}`)
  }
  if (disagreements.length) {
    throw new Error(`Board and record disagree on "needs a person": ${disagreements.join(", ")}`)
  }
  if (reviewProblems.length) {
    throw new Error(`Order API has no reviewer status or records-read count for: ${reviewProblems.join(", ")}`)
  }
  console.log(`Reviewer: ${reviewed} of ${overview.visible.length} orders reviewed; the rest read "not reviewed yet".`)
  if (effectProblems.length) throw new Error(`Effect events without a version, text, committer or history entry: ${effectProblems.join(", ")}`)
  console.log(`Effect events: ${effectCount} committed change(s) across the orders, each with a version and a history entry.`)
  if (callProblems.length) throw new Error(`Calls without a calls list, tier, transcript or a cost below the operator's, or to a customer-side contact outside a pickup-readiness call: ${callProblems.join(", ")}`)
  if (digestOff.length) {
    const delivered = Date.parse((latest as { deliveredAt?: string } | undefined)?.deliveredAt ?? "")
    if (!(lastCallMove > delivered)) throw new Error(`The ${latest?.slot} digest's counts differ from the queue for ${digestOff.join(", ")}`)
    console.log(`Briefing: the ${latest?.slot} digest's counts differ for ${digestOff.join(", ")}, but calls moved orders after it was delivered.`)
  }
  console.log(`Calls: ${callCount} on record, ${running} running; ${movedByCalls} orders with call activity during the read were not compared for group.`)
  // Ticket 07: every proposal waiting for a yes shows its evidence, contact type, who pays,
  // policy row and what approving will do; the Rules page renders. Read-only: nothing is approved.
  const approvalsResponse = await appFetch(`${base}/api/proposals`)
  if (!approvalsResponse.ok) throw new Error(`Proposals API returned ${approvalsResponse.status}`)
  const approvals = await approvalsResponse.json() as { waiting: { reference: string; kind?: string; policyRow?: string; whoPays?: string; onApprove?: string | null; contact?: { type?: string; handle?: string | null }; evidence?: unknown[] }[] }
  const incomplete = approvals.waiting.filter((row) => !row.policyRow || !row.whoPays || !row.onApprove || !row.contact?.type || (row.kind !== "change" && !row.evidence?.length))
  if (incomplete.length) throw new Error(`Proposals missing evidence, contact type, who pays, policy row or approval text: ${incomplete.map((row) => row.reference).join(", ")}`)
  // Ticket 08 (ADR 0001): a customer-side proposal is propose-only and gives the agent no channel.
  const customerSide = new Set(["paying_customer", "customer_given_contact", "customer_owned_site"])
  const leaking = approvals.waiting.filter((row) => row.kind !== "change" && customerSide.has(row.contact?.type ?? "")
    && (row.kind !== "customer_contact" || row.contact?.handle || row.policyRow !== "customer-side"))
  if (leaking.length) throw new Error(`Customer-side proposals the agent could act on: ${leaking.map((row) => row.reference).join(", ")}`)
  const lessonsPage = await appFetch(`${base}/lessons`)
  if (!lessonsPage.ok || !(await lessonsPage.text()).includes("Lessons")) throw new Error(`Lessons page did not render (${lessonsPage.status})`)
  console.log(`Proposals: ${approvals.waiting.length} waiting for a yes, each with its policy row; the Lessons page renders.`)
  // Spec story 14: the starter's lane board stays on its own route, cards in lane order without the engine's verdict.
  const boardPage = await appFetch(`${base}/board`)
  if (!boardPage.ok) throw new Error(`The lane board did not render (${boardPage.status})`)
  const boardCards = await (await appFetch(`${base}/api/overview?view=board`)).json() as { visible: { verdict?: unknown }[]; total: number }
  if (boardCards.visible.length !== boardCards.total || boardCards.visible.some((card) => card.verdict)) throw new Error("The lane board's cards are not the starter's view")
  console.log("Lane board: /board renders the starter's lanes for reference.")
  // Ticket 11: each persona's phone holds at most one live call of its own line; the rest queue. Read-only.
  for (const persona of ["site", "driver"] as const) {
    const phoneResponse = await fetch(`${base}/api/phone`, { headers: { cookie: `persona=${persona}` } })
    if (!phoneResponse.ok) throw new Error(`Phone API for ${persona} returned ${phoneResponse.status}`)
    const phone = await phoneResponse.json() as { persona: string; current: { line: string; answerer: string; state: string } | null; queued: { line: string }[] }
    if (phone.persona !== persona) throw new Error(`The ${persona} phone answered as ${phone.persona}`)
    const strays = [phone.current, ...phone.queued].filter((call) => call && call.line !== persona)
    if (strays.length) throw new Error(`The ${persona} phone holds calls for another line`)
    if (phone.current && (phone.current.answerer !== "live" || phone.current.state === "ended")) throw new Error(`The ${persona} phone holds a call that is not live`)
    console.log(`Phone (${persona}): ${phone.current ? `1 live call (${phone.current.state})` : "idle"}, ${phone.queued.length} queued.`)
  }
  // Ticket 12: the push-to-talk route is reachable by the Driver persona and refuses a turn without a recording (no model call).
  const voice = await fetch(`${base}/api/phone/voice`, { method: "POST", headers: { cookie: "persona=driver", "content-type": "application/json" }, body: JSON.stringify({ callId: "none" }) })
  if (voice.status !== 400) throw new Error(`The tier-2 voice route answered ${voice.status} to a turn without a recording (expected 400)`)
  // Ticket 12: CD-420437's driver can be rung live about the tight ETA (on request, or already called).
  const order437 = overview.visible.find((card: { reference: string }) => card.reference === "CD-420437") as { id: string } | undefined
  if (order437) {
    const detail437 = await (await appFetch(`${base}/api/orders/${order437.id}`)).json() as { checks: { callLines?: { line: string; status: string }[]; calls?: unknown[] } | null }
    const driverLine = detail437.checks?.callLines?.find((line) => line.line === "driver")
    if (!driverLine) throw new Error("CD-420437 has no driver line to ring about its tight ETA")
    console.log(`Tier 2: CD-420437's driver line is ${driverLine.status}; ${detail437.checks?.calls?.length ?? 0} call(s) on record.`)
  }
  console.log(`Verified ${order.id}: ${orderPlans.length} plans, ${(body.related.transport_points ?? []).length} points, ${(body.related.transport_segments ?? []).length} segments. Board and record agree on "needs a person" and on the group for ${overview.visible.length} orders (${Object.entries(overview.groupCounts).map(([group, count]) => `${group} ${count}`).join(", ")}).`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
