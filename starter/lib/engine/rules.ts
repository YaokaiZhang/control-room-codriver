// The deterministic rule checks (docs/PRD.md §5.2, spec "Rules"). Each rule is a
// pure function over one order's facts (read once from its bundle), the fleet
// index (other orders' duties of the same driver) and the clock. Each returns
// pass, fail or unknown with the records it read, and declares its first action.
//
// Adding a rule: add its id to `RuleId` in checks.ts, write a function here that
// returns a `RuleResult`, and list it in STRONG or WEAK. Planning and grouping
// pick it up from `outcome` and `firstAction`.

import type { Bundle, RelatedRow } from "@/lib/present/bundle"
import { bool, finalDeliveryPoint, obj, originPickupPoint, rows, str } from "@/lib/present/bundle"
import { CLOSING, type ClosableCollection } from "@/lib/present/closing"
import { fmtDateTime } from "@/lib/present/time"
import { endpointContactType, pickupCallAllowed } from "./contacts"
import { nextChecksOf, type NextCheck } from "./due"
import { currentRecord, latestEta, latestPosition, type PositionStatement } from "./eta"
import { ON_TIME_CLAIM } from "./call-script"
import { isFinished, movingAssignments, selectedPromise, windowOn } from "./order-facts"
import type { Callee, FirstAction, PlannedAction, RuleId, RuleResult, SourceRef, Urgency } from "./checks"

/** One driver duty, indexed across all orders, for the positioning rule. */
export type Duty = { assignmentId: string; orderId: string; reference: string; driverId: string; status: string; pickupStart: string | null }
export type Fleet = { dutiesByDriver: Map<string, Duty[]> }
export type RuleContext = { now: string; fleet: Fleet }

export type Evaluation = { rules: RuleResult[]; planned: PlannedAction[]; urgency: Urgency; finished: boolean }

const HOUR = 3_600_000
/** A weak signal or a release gap plans a site call when pickup is this close. */
export const CALL_AHEAD_HOURS = 48

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null
  const value = new Date(iso).getTime()
  return Number.isNaN(value) ? null : value
}

const ref = (collection: string, row: RelatedRow | { id: string }, label: string): SourceRef => ({ collection, id: row.id, label })

/** What every rule reads about one order, gathered once. */
type Facts = {
  bundle: Bundle
  now: number
  nowIso: string
  finished: boolean
  pickupPoint: RelatedRow | null
  deliveryPoint: RelatedRow | null
  pickupEndpoint: RelatedRow | null
  pickupSlot: RelatedRow | null
  /** The selected customer delivery promise on the final delivery point. */
  promise: RelatedRow | null
  /** Assignments in progress: a driver is on the road with a car of this order. */
  moving: RelatedRow[]
  pickedUp: boolean
  /** Pickup not yet recorded and its slot starts within CALL_AHEAD_HOURS (or has started). */
  pickupSoon: boolean
  callee: Callee | null
}

function gather(bundle: Bundle, context: RuleContext): Facts {
  const now = ms(context.now) ?? 0
  const finished = isFinished(bundle)
  const pickupPoint = originPickupPoint(bundle)
  const deliveryPoint = finalDeliveryPoint(bundle)
  const endpoints = rows(bundle, "order_endpoint_details")
  const pickupEndpoint = endpoints.find((row) => pickupPoint && row.details.point_id === pickupPoint.id)
    ?? endpoints.find((row) => row.details.boundary === "PICKUP") ?? null
  const pickupSlot = windowOn(bundle, pickupPoint?.id, "SELECTED_PICKUP_SLOT", true)
  const promise = selectedPromise(bundle)
  const moving = movingAssignments(bundle)
  const pickedUp = !!pickupPoint && bundle.events.some((event) => event.command === "vehicle.picked_up" && event.targetId === pickupPoint.id)
  const start = ms(str(pickupSlot?.details.start_at))
  const pickupSoon = !finished && !pickedUp && start !== null && start - now <= CALL_AHEAD_HOURS * HOUR
  const handle = str(pickupEndpoint?.details.contact_handle)
  // The rules' site call is a pickup-readiness call: a third-party site, or (ADR 0001 amendment,
  // policy row pickup-readiness) a customer-owned pickup site or a pickup contact the customer gave.
  const callee = pickupEndpoint && handle && pickupCallAllowed(endpointContactType(bundle, pickupEndpoint))
    ? { name: str(pickupEndpoint.details.contact_name), handle, role: str(pickupEndpoint.details.contact_role), endpointId: pickupEndpoint.id }
    : null
  return { bundle, now, nowIso: context.now, finished, pickupPoint, deliveryPoint, pickupEndpoint, pickupSlot, promise, moving, pickedUp, pickupSoon, callee }
}

function result(id: RuleId, strength: "strong" | "weak", title: string, outcome: RuleResult["outcome"], detail: string, firstAction: FirstAction | null, sources: SourceRef[]): RuleResult {
  return { id, strength, title, outcome, detail, firstAction: outcome === "fail" || (strength === "weak" && firstAction) ? firstAction : null, sources }
}

// R1 — Site requires a signed release and there is no verified RELEASE_AUTHORITY document.
function signedRelease(facts: Facts): RuleResult {
  const title = RULE_CATALOGUE.R1.title
  const { bundle, pickupPoint } = facts
  const siteId = str(pickupPoint?.details.site_id) ?? bundle.order.pickupSiteId
  const site = siteId ? bundle.sites.get(siteId) ?? null : null
  if (!site) return result("R1", "strong", title, "pass", "Pickup is not at a managed site, so no site release rule applies.", null, [])
  const siteRef = ref("sites", site, `Site ${site.name}`)
  const requires = bool(site.details.requires_signed_release)
  if (requires === null) return result("R1", "strong", title, "unknown", `${site.name} does not record whether it needs a signed release.`, null, [siteRef])
  if (!requires) return result("R1", "strong", title, "pass", `${site.name} does not require a signed release.`, null, [siteRef])
  const documents = rows(bundle, "documents").filter((row) => row.details.kind === "RELEASE_AUTHORITY")
  const verified = documents.find((row) => row.details.status === "VERIFIED")
  const docRefs = documents.map((row) => ref("documents", row, `Release authority ${String(row.details.status ?? "").toLowerCase()}`))
  if (verified) return result("R1", "strong", title, "pass", `${site.name} requires a signed release and a verified release authority is on file.`, null, [siteRef, ...docRefs])
  const action: FirstAction = facts.pickupSoon && facts.callee ? "site_call" : "show_person"
  const when = str(facts.pickupSlot?.details.start_at)
  return result("R1", "strong", title, "fail",
    `${site.name} requires a signed release and no verified release authority is on file${when ? ` for the pickup on ${fmtDateTime(when, str(facts.pickupSlot?.details.timezone))}` : ""}.`,
    action, [siteRef, ...docRefs, ...(facts.pickupSlot ? [ref("time_windows", facts.pickupSlot, "Pickup slot")] : [])])
}

const LIVE_DUTY = new Set(["ASSIGNED", "IN_PROGRESS"])

// R3 — The positioning's previous duty skips another live duty of the same driver.
function positioningSkip(facts: Facts, context: RuleContext): RuleResult {
  const title = RULE_CATALOGUE.R3.title
  const positioned = rows(facts.bundle, "work_assignments").filter((row) => LIVE_DUTY.has(String(row.details.status)) && obj(row.details.positioning))
  if (!positioned.length) return result("R3", "strong", title, "pass", "No live assignment on this order records driver positioning.", null, [])
  for (const assignment of positioned) {
    const positioning = obj(assignment.details.positioning) ?? {}
    const driverId = str(assignment.details.driver_id)
    const previousId = str(positioning.previous_assignment_id)
    const from = ms(str(positioning.previous_delivery_eta_at)) ?? facts.now
    const to = ms(str(positioning.next_pickup_start_at))
    if (!driverId || to === null) {
      return result("R3", "strong", title, "unknown", "The positioning record has no driver or next pickup time to compare.", null, [ref("work_assignments", assignment, "Assignment positioning")])
    }
    const skipped = (context.fleet.dutiesByDriver.get(driverId) ?? []).filter((duty) => {
      const start = ms(duty.pickupStart)
      return duty.assignmentId !== assignment.id && duty.assignmentId !== previousId && LIVE_DUTY.has(duty.status)
        && start !== null && start > from && start < to
    })
    if (skipped.length) {
      const previous = facts.bundle.bundleOrderRefs[String(positioning.previous_order_id)] ?? "the previous duty"
      return result("R3", "strong", title, "fail",
        `Positioning assumes the driver comes from ${previous}, but the same driver is booked on ${skipped.map((duty) => duty.reference).join(", ")} in between.`,
        "reviewer_pass", [ref("work_assignments", assignment, "Assignment positioning"), ...skipped.map((duty) => ({ collection: "work_assignments", id: duty.assignmentId, label: `${duty.reference} duty` }))])
    }
  }
  return result("R3", "strong", title, "pass", "The positioning starts from the driver's last live duty before this pickup.", null, positioned.map((row) => ref("work_assignments", row, "Assignment positioning")))
}

function sameWindow(a: RelatedRow, b: RelatedRow): boolean {
  return ms(str(a.details.start_at)) === ms(str(b.details.start_at)) && ms(str(a.details.end_at)) === ms(str(b.details.end_at))
}

const windowText = (row: RelatedRow) => `${fmtDateTime(str(row.details.start_at), str(row.details.timezone), false)}–${fmtDateTime(str(row.details.end_at), str(row.details.timezone))}`

// R7 — The selected delivery promise differs from the customer's requested delivery slot.
function promiseVersusRequest(facts: Facts): RuleResult {
  const title = RULE_CATALOGUE.R7.title
  const promise = facts.promise
  if (facts.finished && !promise) return result("R7", "strong", title, "pass", "The order is finished.", null, [])
  if (!promise) return result("R7", "strong", title, "unknown", "No delivery promise is selected yet.", null, [])
  const requested = rows(facts.bundle, "time_windows").find((row) =>
    row.details.point_id === promise.details.point_id && row.details.purpose === "REQUESTED_DELIVERY_SLOT" && row.details.source === "CUSTOMER")
  const promiseRef = ref("time_windows", promise, "Delivery promise")
  if (!requested) return result("R7", "strong", title, "pass", "The customer requested no other delivery slot.", null, [promiseRef])
  const requestedRef = ref("time_windows", requested, "Requested delivery slot")
  if (sameWindow(promise, requested)) return result("R7", "strong", title, "pass", "The promise is the slot the customer requested.", null, [promiseRef, requestedRef])
  if (facts.finished) return result("R7", "strong", title, "pass", "The promise differed from the request, but the order is finished.", null, [promiseRef, requestedRef])
  return result("R7", "strong", title, "fail",
    `The promise ${windowText(promise)} differs from the slot the customer requested, ${windowText(requested)}.`,
    "reviewer_pass", [promiseRef, requestedRef])
}

/** Tracking older than this, with no open alert, is stale. */
export const STALE_TRACKING_HOURS = 4
const OPEN_ALERT = new Set(["OPEN", "ACKNOWLEDGED"])

// R10 — In transit with tracking missing or older than 4 h, and no open alert. It reads
// current records only: once a call result or a reported ETA supersedes the latest
// tracking row, the driver's word on the call is the latest position statement.
function staleTracking(facts: Facts): RuleResult {
  const title = RULE_CATALOGUE.R10.title
  const { bundle } = facts
  if (!facts.moving.length) return result("R10", "strong", title, "pass", "No driver is on the road with this car.", null, [])
  const alerts = bundle.alerts.filter((alert) => OPEN_ALERT.has(alert.status))
  const stale: PositionStatement[] = []
  const missing: RelatedRow[] = []
  const sources: SourceRef[] = []
  for (const assignment of facts.moving) {
    const last = latestPosition(bundle, assignment.id)
    if (!last) {
      sources.push(ref("work_assignments", assignment, "Assignment in progress"))
      missing.push(assignment)
      continue
    }
    sources.push(ref(last.collection, last.row, last.collection === "tracking_observations" ? "Latest position" : "Driver's word on a call"))
    const observed = ms(last.at)
    if (observed === null || facts.now - observed > STALE_TRACKING_HOURS * HOUR) stale.push(last)
  }
  if (!stale.length && !missing.length) {
    const spoke = sources.some((source) => source.collection === "effect_events")
    return result("R10", "strong", title, "pass", spoke
      ? `The driver spoke on a call less than ${STALE_TRACKING_HOURS} h ago, after the last tracked position.`
      : `The latest position is less than ${STALE_TRACKING_HOURS} h old.`, null, sources)
  }
  const what = [
    ...stale.map((last) => last.collection === "tracking_observations"
      ? `the last position is from ${fmtDateTime(last.at, null)}` : `the driver last spoke on a call at ${fmtDateTime(last.at, null)}`),
    ...missing.map(() => "no position has been received"),
  ].join("; ")
  if (alerts.length) {
    return result("R10", "strong", title, "pass", `Tracking is stale (${what}), but an open alert already covers the order.`, null,
      [...sources, ...alerts.map((alert) => ({ collection: "alerts", id: alert.id, label: `Alert ${alert.signal.toLowerCase().replace(/_/g, " ")}` }))])
  }
  return result("R10", "strong", title, "fail", `Car in transit and ${what}, with no alert open.`, "driver_call", sources)
}

// R12 — The latest ETA is after the promise end. The latest ETA is the newest one
// stated: a tracking estimate, or the driver's own word on a call (`eta_reported`).
// A late ETA the driver reported needs no second call: the operator decides what to
// tell the customer (the promise is the customer's; ADR 0001).
function etaAfterPromise(facts: Facts): RuleResult {
  const title = RULE_CATALOGUE.R12.title
  if (!facts.moving.length || facts.finished) return result("R12", "strong", title, "pass", "The car is not on the road, so there is no ETA to compare.", null, [])
  const promise = facts.promise
  const latest = latestEta(facts.bundle)
  if (!promise || !latest) {
    return result("R12", "strong", title, "unknown", promise ? "The car is moving but no ETA has been received." : "The car is moving but no delivery promise is selected.", null,
      promise ? [ref("time_windows", promise, "Delivery promise")] : [])
  }
  const sources = [ref(latest.collection, { id: latest.recordId }, latest.reported ? "ETA the driver reported" : "Latest ETA"), ref("time_windows", promise, "Delivery promise")]
  const eta = latest.at
  const end = str(promise.details.end_at)
  const zone = str(promise.details.timezone)
  if ((ms(eta) ?? 0) > (ms(end) ?? Infinity)) {
    // A tracking ETA a call result superseded: the driver already answered on a call.
    const tracked = latest.superseded ? rows(facts.bundle, latest.collection).find((row) => row.id === latest.recordId) : undefined
    const answer = tracked ? currentRecord(facts.bundle, tracked) : undefined
    if (answer && answer.id !== tracked?.id && answer.details.effect === "CALL_RESULT_RECORDED") {
      const said = String(answer.details.claim ?? "")
      const answerSources = [ref("effect_events", answer, "Driver's answer on a call"), ref("time_windows", promise, "Delivery promise")]
      if (said.split("; ").includes(ON_TIME_CLAIM)) {
        return result("R12", "strong", title, "pass",
          `The tracking ETA ${fmtDateTime(eta, zone)} was after the promise end, but on a call the driver said: ${said}.`, null, answerSources)
      }
      return result("R12", "strong", title, "fail",
        `The tracking ETA ${fmtDateTime(eta, zone)} is after the promise ends at ${fmtDateTime(end, zone)}, and on a call the driver said: ${said}. Decide what to tell the customer.`,
        "show_person", answerSources)
    }
    if (latest.reported) {
      return result("R12", "strong", title, "fail",
        `${latest.statedBy ?? "The driver"} reported an ETA of ${fmtDateTime(eta, zone)}, after the promise ends at ${fmtDateTime(end, zone)}. Decide what to tell the customer.`,
        "show_person", sources)
    }
    return result("R12", "strong", title, "fail", `The latest ETA ${fmtDateTime(eta, zone)} is after the promise ends at ${fmtDateTime(end, zone)}.`, "driver_call", sources)
  }
  return result("R12", "strong", title, "pass", `The latest ETA ${fmtDateTime(eta, zone)} is inside the promise.`, null, sources)
}

// R11 — The pickup slot passed with no pickup recorded.
function missedPickup(facts: Facts): RuleResult {
  const title = RULE_CATALOGUE.R11.title
  const slot = facts.pickupSlot
  if (facts.pickedUp) return result("R11", "strong", title, "pass", "The pickup is recorded.", null, slot ? [ref("time_windows", slot, "Pickup slot")] : [])
  if (facts.finished) return result("R11", "strong", title, "pass", "The order is finished.", null, [])
  if (!slot) return result("R11", "strong", title, "pass", "No pickup slot is selected yet.", null, [])
  const end = str(slot.details.end_at) ?? str(slot.details.start_at)
  const zone = str(slot.details.timezone)
  if ((ms(end) ?? Infinity) >= facts.now) return result("R11", "strong", title, "pass", `The pickup slot ends ${fmtDateTime(end, zone)}; it has not passed.`, null, [ref("time_windows", slot, "Pickup slot")])
  return result("R11", "strong", title, "fail", `The pickup slot ended ${fmtDateTime(end, zone)} and no pickup is recorded.`, "show_person", [ref("time_windows", slot, "Pickup slot")])
}

const SETTLED_EXPENSE = new Set(["REJECTED", "SUPERSEDED"])

// R13 — A positioning expense with no matching reservation.
function expenseWithoutReservation(facts: Facts): RuleResult {
  const title = RULE_CATALOGUE.R13.title
  const { bundle } = facts
  const claims = rows(bundle, "expenses").filter((row) => String(row.details.kind ?? "").endsWith("_POSITIONING") && !SETTLED_EXPENSE.has(String(row.details.status)))
  if (!claims.length) return result("R13", "strong", title, "pass", "No positioning cost is claimed on this order.", null, [])
  const reservations = rows(bundle, "travel_reservations")
  const unmatched = claims.filter((claim) => !str(claim.details.reservation_id)
    && !reservations.some((reservation) => reservation.details.assignment_id === claim.details.assignment_id))
  const claimRef = (row: RelatedRow) => ref("expenses", row, `${String(row.details.kind).replace(/_POSITIONING$/, "").toLowerCase()} positioning claim`)
  if (!unmatched.length) return result("R13", "strong", title, "pass", "Every positioning claim has a reservation on its assignment.", null, claims.map(claimRef))
  return result("R13", "strong", title, "fail",
    `${unmatched.length === 1 ? "A positioning claim has" : `${unmatched.length} positioning claims have`} no travel reservation on the assignment.`,
    "reviewer_pass", unmatched.map(claimRef))
}

const STRONG: ((facts: Facts, context: RuleContext) => RuleResult)[] = [
  signedRelease, positioningSkip, promiseVersusRequest, staleTracking, missedPickup, etaAfterPromise, expenseWithoutReservation,
]

const OPEN_PROOF = new Set(["REQUIRED", "SUBMITTED", "REJECTED"])
const OPEN_WORK = new Set(["OPEN", "NEEDS_EXTERNAL_INPUT", "IN_PROGRESS", "WAITING"])
const OPEN_PROPOSAL = new Set(["PENDING_REVIEW", "APPROVED_AWAITING_EXECUTION", "FAILED"])
const OPEN_DOCUMENT = new Set(["MISSING", "REQUESTED"])

function sentenceCase(text: string): string {
  const lower = text.toLowerCase()
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

function countLabels(sources: SourceRef[]): string {
  const counts = new Map<string, number>()
  for (const source of sources) counts.set(source.label.toLowerCase(), (counts.get(source.label.toLowerCase()) ?? 0) + 1)
  return [...counts].map(([label, count]) => count > 1 ? `${label} (${count})` : label).join(", ")
}

// CLOSE — Only on a delivered or cancelled order: is anything still open? (spec "Grouping": Done)
function nothingOpen(facts: Facts): RuleResult {
  const title = RULE_CATALOGUE.CLOSE.title
  const { bundle } = facts
  // Each open record carries the operator's verb for closing it (lib/present/closing.ts).
  const closable = (collection: ClosableCollection, row: RelatedRow, label: string): SourceRef =>
    ({ ...ref(collection, row, label), close: CLOSING[collection].verb(row.details, str(row.details.status)) })
  const open: SourceRef[] = [
    ...rows(bundle, "proofs").filter((row) => OPEN_PROOF.has(String(row.details.status))).map((row) => closable("proofs", row, `Proof ${String(row.details.status).toLowerCase()}`)),
    ...rows(bundle, "documents").filter((row) => row.details.required === true && OPEN_DOCUMENT.has(String(row.details.status)))
      .map((row) => closable("documents", row, sentenceCase(`${String(row.details.kind).replace(/_/g, " ")} ${String(row.details.status)}`))),
    ...rows(bundle, "endpoint_claims").filter((row) => row.details.resolution_status === "OPEN").map((row) => closable("endpoint_claims", row, "Unresolved claim")),
    ...bundle.alerts.filter((alert) => OPEN_ALERT.has(alert.status)).map((alert) => ({ collection: "alerts", id: alert.id, label: `Alert ${alert.status.toLowerCase()}`, close: CLOSING.alerts.verb(alert.details, alert.status) })),
    ...rows(bundle, "work_items").filter((row) => OPEN_WORK.has(String(row.details.status))).map((row) => closable("work_items", row, "Open work item")),
    ...rows(bundle, "incidents").filter((row) => !str(row.details.resolved_at)).map((row) => closable("incidents", row, "Open incident")),
    ...rows(bundle, "agent_proposals").filter((row) => OPEN_PROPOSAL.has(String(row.details.status))).map((row) => closable("agent_proposals", row, "Proposal not settled")),
    ...rows(bundle, "custody_assets").filter((row) => str(row.details.next_action)).map((row) => closable("custody_assets", row, "Custody follow-up")),
    ...rows(bundle, "work_assignments").filter((row) => row.details.order_id === bundle.order.id && LIVE_DUTY.has(String(row.details.status)))
      .map((row) => closable("work_assignments", row, "A car of this order is still on the road")),
  ]
  if (!open.length) return result("CLOSE", "strong", title, "pass", "No proof, document, claim, alert, work item, proposal, custody follow-up or trade-in is open.", null, [])
  // A failing check reads as the problem, not the condition it checks.
  return result("CLOSE", "strong", "Finished order still has loose ends", "fail",
    `The order is ${str(bundle.order.details.cancelled_at) ? "cancelled" : "delivered"} but ${open.length === 1 ? "one record is" : `${open.length} records are`} still open: ${countLabels(open)}.`,
    "show_person", open)
}

/**
 * What a next check waits on, when it is the pickup site: a routine site call follows up.
 * Anything else (the customer, a seller hold, Ops' own review) becomes a proposal to the
 * operator (proposals.ts `nextCheckDrafts`): a customer-side contact or an operator question.
 */
const SITE_WAITS = new Set(["SITE_CONFIRMATION", "STOCK_CONTROL_REPLY"])

const humanise = (code: string) => code.toLowerCase().replace(/_/g, " ")

// NEXT — Only on an order with a next check recorded on an open conversation
// (`next_check_at`): once the clock reaches it, plan its follow-up (spec "Call state machine").
function nextCheckDue(facts: Facts, checks: NextCheck[]): RuleResult {
  const title = RULE_CATALOGUE.NEXT.title
  const source = (check: NextCheck): SourceRef => ({ collection: "conversations", id: check.conversationId, label: `${humanise(check.category)} thread` })
  const what = (check: NextCheck) => `the ${fmtDateTime(check.at)} next check on the ${humanise(check.category)} thread${check.waitingOn ? ` (waiting on ${humanise(check.waitingOn)})` : ""}`
  const due = checks.filter((check) => check.at <= facts.nowIso)
  if (!due.length) {
    return result("NEXT", "strong", title, "pass", `Not due yet: ${checks.map(what).join("; ")}.`, null, checks.map(source))
  }
  const toSite = due.every((check) => check.waitingOn !== null && SITE_WAITS.has(check.waitingOn))
  const action: FirstAction = toSite && facts.callee ? "site_call" : "operator_proposal"
  const follow = action === "site_call" ? "a routine site call follows up" : "the open question is not one a site call can settle, so the agent proposes the next step to the operator"
  const listed = due.map(what).join("; ")
  return result("NEXT", "strong", title, "fail", `${listed[0].toUpperCase()}${listed.slice(1)} ${due.length === 1 ? "is" : "are"} due; ${follow}.`, action, due.map(source))
}

type Endpoint = { row: RelatedRow; label: string; ahead: boolean }

/**
 * The order's endpoint details, each marked `ahead` while its handover is still to
 * come. After a recorded pickup or delivery (or on a finished order) an old
 * unconfirmed status is history (dataset/SCHEMA.md), not a gap; a contact that was
 * never on record stays a gap.
 */
function endpointsOf(facts: Facts): Endpoint[] {
  const delivered = !!facts.deliveryPoint && facts.bundle.events.some((event) => event.command === "vehicle.delivered" && event.targetId === facts.deliveryPoint?.id)
  return rows(facts.bundle, "order_endpoint_details").map((row) => {
    const pickup = row.details.boundary === "PICKUP"
    return { row, label: pickup ? "Pickup" : "Delivery", ahead: !facts.finished && !(pickup ? facts.pickedUp : delivered) }
  })
}

function openEndpoints(facts: Facts): Endpoint[] {
  return endpointsOf(facts).filter((endpoint) => endpoint.ahead)
}

/** A weak signal plans a routine site call when pickup is near and the pickup contact is known. */
const weakAction = (facts: Facts): FirstAction | null => facts.pickupSoon && facts.callee ? "site_call" : null

// R5 — The contact name or handle is missing, or nobody confirmed the contact for this order.
function contactOnRecord(facts: Facts): RuleResult {
  const title = RULE_CATALOGUE.R5.title
  const all = endpointsOf(facts)
  const missing = ({ row }: Endpoint) => !str(row.details.contact_name) || !str(row.details.contact_handle)
  const gaps = all.filter((endpoint) => missing(endpoint) || (endpoint.ahead && endpoint.row.details.contact_status !== "CONFIRMED"))
  const sources = all.map(({ row, label }) => ref("order_endpoint_details", row, `${label} contact`))
  if (!gaps.length) return result("R5", "weak", title, "pass", "Every contact is on record, and every handover still ahead has a confirmed one.", null, sources)
  const text = gaps.map(({ row, label }) => !str(row.details.contact_name) && !str(row.details.contact_handle) ? `${label.toLowerCase()} contact not on record`
    : !str(row.details.contact_handle) ? `${label.toLowerCase()} contact has no phone or email`
    : !str(row.details.contact_name) ? `${label.toLowerCase()} contact has no name`
    : `${label.toLowerCase()} contact not confirmed for this order`)
  return result("R5", "weak", title, "unknown", `${text.join("; ").replace(/^./, (c) => c.toUpperCase())}.`, weakAction(facts),
    gaps.map(({ row, label }) => ref("order_endpoint_details", row, `${label} contact`)))
}

// R4 — Confirmed only from the site profile, not by anyone about this car.
function confirmedFromProfile(facts: Facts): RuleResult {
  const title = RULE_CATALOGUE.R4.title
  const open = openEndpoints(facts)
  const profile = open.filter(({ row }) => row.details.last_confirmed_source === "MANAGED_SITE_PROFILE")
  if (!profile.length) return result("R4", "weak", title, "pass", "No open handover relies on the site profile alone.", null, open.map(({ row, label }) => ref("order_endpoint_details", row, `${label} details`)))
  return result("R4", "weak", title, "unknown",
    `${profile.length === 2 ? "Pickup and delivery" : profile[0].label} confirmed only from the site profile, not for this car.`, weakAction(facts),
    profile.map(({ row, label }) => ref("order_endpoint_details", row, `${label} details`)))
}

// R6 — The promise source is not the customer.
function promiseFromCustomer(facts: Facts): RuleResult {
  const title = RULE_CATALOGUE.R6.title
  const promise = facts.promise
  if (!promise) return result("R6", "weak", title, "pass", "No delivery promise is selected yet.", null, [])
  const source = str(promise.details.source)
  const promiseRef = ref("time_windows", promise, "Delivery promise")
  if (source === "CUSTOMER") return result("R6", "weak", title, "pass", "The customer set the delivery promise.", null, [promiseRef])
  return result("R6", "weak", title, "unknown", `The delivery promise comes from ${source === "SYSTEM" ? "a system estimate" : source === "OPS" ? "Ops" : "an unrecorded source"}, not the customer.`,
    weakAction(facts), [promiseRef])
}

const WEAK: ((facts: Facts) => RuleResult)[] = [confirmedFromProfile, contactOnRecord, promiseFromCustomer]

const CALL_REASON: Record<PlannedAction["kind"], string> = {
  site_call: "Routine site call planned",
  driver_call: "Routine driver call planned",
  reviewer_pass: "Reviewer pass planned",
}

function plan(facts: Facts, rules: RuleResult[]): PlannedAction[] {
  const planned: PlannedAction[] = []
  for (const kind of ["site_call", "driver_call", "reviewer_pass"] as const) {
    const asking = rules.filter((row) => row.firstAction === kind && (row.outcome === "fail" || row.strength === "weak"))
    if (!asking.length) continue
    planned.push({
      kind,
      ruleIds: asking.map((row) => row.id),
      sources: Object.fromEntries(asking.map((row) => [row.id, row.sources])),
      reason: `${CALL_REASON[kind]}. ${asking.map((row) => row.detail).join(" ")}`,
      callee: kind === "site_call" ? facts.callee : null,
    })
  }
  return planned
}

/** Urgency windows (docs/PRD.md §9). */
export const ACTION_DUE_HOURS = 2
export const PICKUP_URGENT_HOURS = 24
export const PROMISE_TODAY_HOURS = 24

/**
 * Urgent when an action is due within 2 h (an open work item or a conversation's
 * next check), a promise at risk ends within 24 h (ETA after its end), or pickup is
 * within 24 h with no confirmed contact or a missing release.
 */
function urgencyOf(facts: Facts, rules: RuleResult[]): Urgency {
  const reasons: Urgency["reasons"] = []
  const deadlines: string[] = []
  const { bundle, now } = facts
  const dueSoon = (at: string | null) => at !== null && (ms(at) ?? Infinity) - now <= ACTION_DUE_HOURS * HOUR
  for (const row of rows(bundle, "work_items")) {
    const at = str(row.details.due_at)
    if (!OPEN_WORK.has(String(row.details.status)) || !at) continue
    deadlines.push(at)
    if (dueSoon(at)) reasons.push({ kind: "action_due", text: `${(ms(at) ?? 0) < now ? "Overdue" : "Due"} work item: ${str(row.details.next_action) ?? str(row.details.summary) ?? "follow-up"}`, at })
  }
  for (const thread of bundle.conversations) {
    const at = str(thread.details.next_check_at)
    if (thread.status !== "OPEN" || !at) continue
    deadlines.push(at)
    if (dueSoon(at)) reasons.push({ kind: "action_due", text: `Next check on the ${thread.category.toLowerCase().replace(/_/g, " ")} thread`, at })
  }
  const promiseEnd = str(facts.promise?.details.end_at)
  if (facts.moving.length && promiseEnd && !facts.finished) deadlines.push(promiseEnd)
  const late = rules.find((row) => row.id === "R12" && row.outcome === "fail")
  if (late && promiseEnd && (ms(promiseEnd) ?? Infinity) - now <= PROMISE_TODAY_HOURS * HOUR) {
    reasons.push({ kind: "promise_at_risk", text: late.detail, at: promiseEnd })
  }
  const slotStart = str(facts.pickupSlot?.details.start_at)
  if (slotStart && !facts.pickedUp && !facts.finished) {
    deadlines.push(slotStart)
    const releaseMissing = rules.some((row) => row.id === "R1" && row.outcome === "fail")
    const contactConfirmed = facts.pickupEndpoint?.details.contact_status === "CONFIRMED" && !!str(facts.pickupEndpoint?.details.contact_handle)
    if ((ms(slotStart) ?? Infinity) - now <= PICKUP_URGENT_HOURS * HOUR && (releaseMissing || !contactConfirmed)) {
      reasons.push({ kind: "pickup_unready", text: `Pickup ${fmtDateTime(slotStart, str(facts.pickupSlot?.details.timezone))} with ${releaseMissing ? "no verified release" : "no confirmed contact"}`, at: slotStart })
    }
  }
  const dueAt = [...reasons.map((reason) => reason.at).filter((at): at is string => !!at), ...deadlines].sort()[0] ?? null
  return { urgent: reasons.length > 0, reasons, dueAt }
}

export function evaluateRules(bundle: Bundle, context: RuleContext): Evaluation {
  const facts = gather(bundle, context)
  const nextChecks = nextChecksOf(bundle)
  let rules = [
    ...STRONG.map((check) => check(facts, context)),
    ...(facts.finished ? [nothingOpen(facts)] : []),
    ...(nextChecks.length ? [nextCheckDue(facts, nextChecks)] : []),
    ...WEAK.map((check) => check(facts)),
  ]
  // A finished order has no call left to make: any strong gap goes to a person.
  if (facts.finished) rules = rules.map((row) => row.outcome === "fail" ? { ...row, firstAction: "show_person" } : row.strength === "weak" ? { ...row, firstAction: null } : row)
  return { rules, planned: plan(facts, rules), urgency: urgencyOf(facts, rules), finished: facts.finished }
}

export function buildFleet(bundles: Bundle[]): Fleet {
  const dutiesByDriver = new Map<string, Duty[]>()
  for (const bundle of bundles) {
    const pickup = originPickupPoint(bundle)
    const slot = windowOn(bundle, pickup?.id, "SELECTED_PICKUP_SLOT", true)
    for (const assignment of rows(bundle, "work_assignments")) {
      const driverId = str(assignment.details.driver_id)
      if (!driverId || assignment.details.order_id !== bundle.order.id) continue
      const duty: Duty = {
        assignmentId: assignment.id, orderId: bundle.order.id, reference: bundle.order.reference, driverId,
        status: String(assignment.details.status ?? ""), pickupStart: str(slot?.details.start_at),
      }
      dutiesByDriver.set(driverId, [...(dutiesByDriver.get(driverId) ?? []), duty])
    }
  }
  return { dutiesByDriver }
}

/** Every rule with its strength, what it checks and its first action: the Rules page lists these. */
export type RuleInfo = { id: RuleId; strength: "strong" | "weak"; title: string; firstAction: string }

export const RULE_CATALOGUE: Record<RuleId, RuleInfo> = {
  R1: { id: "R1", strength: "strong", title: "Signed release on file when the pickup site requires one", firstAction: "Routine site call when pickup is within 48 h and a contact is known; otherwise shown to a person" },
  R3: { id: "R3", strength: "strong", title: "Driver positioning follows the driver's actual previous duty", firstAction: "Reviewer pass (it becomes an operator question)" },
  R7: { id: "R7", strength: "strong", title: "Delivery promise matches the customer's requested slot", firstAction: "Reviewer pass" },
  R10: { id: "R10", strength: "strong", title: `Live position within ${STALE_TRACKING_HOURS} h while the car is moving`, firstAction: "Routine driver check-in call" },
  R11: { id: "R11", strength: "strong", title: "Pickup recorded once the pickup slot has passed", firstAction: "Shown to a person" },
  R12: { id: "R12", strength: "strong", title: "Latest ETA within the delivery promise", firstAction: "Routine driver call (\"can you still deliver on time?\")" },
  R13: { id: "R13", strength: "strong", title: "Positioning costs match a travel reservation", firstAction: "Reviewer pass" },
  CLOSE: { id: "CLOSE", strength: "strong", title: "No loose ends on the finished order", firstAction: "Shown to a person (finished orders only)" },
  NEXT: { id: "NEXT", strength: "strong", title: "Scheduled next checks are followed up when due", firstAction: "Routine site call when the check waits on the pickup site; otherwise a proposal to the operator (a customer-side contact or an operator question)" },
  R4: { id: "R4", strength: "weak", title: "Handover details confirmed by someone about this order", firstAction: "Couldn't check; a routine site call when pickup is within 48 h and a contact is known" },
  R5: { id: "R5", strength: "weak", title: "Handover contacts on record and confirmed for this order", firstAction: "Couldn't check; a routine site call when pickup is within 48 h and a contact is known" },
  R6: { id: "R6", strength: "weak", title: "Delivery promise set by the customer", firstAction: "Couldn't check; a routine site call when pickup is within 48 h and a contact is known" },
}
