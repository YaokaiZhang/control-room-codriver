// Publishing (spec .scratch/publishing): what happens to an order after the agent
// grouped it. Pure: the order's bundle, its publication events, effect events and calls
// in; its stage, the call results waiting for the operator's yes, and the demand
// filter's result out.
//
//   Normal (reviewed), not on the market yet  -> the agent publishes it (ADR 0003)
//   Solved, not on the market yet             -> Fixed, review it; the operator's yes publishes it
//   published, or on the market in the data   -> the demand filter; a demanding order gets a travel plan
//                                                (travel-planner.ts), then it is live on drivers' phones
//
// Publication events are their own append-only table, not effect events: publishing
// changes no record of the order, only its stage, so it must not re-review the order.

import { fmtDateTime } from "@/lib/present/time"
import { finalDeliveryPoint, journeyPlan, num, originPickupPoint, rows, str, type Bundle } from "@/lib/present/bundle"
import type { Call, TranscriptLine } from "./calls"
import type { EffectEvent } from "./effects"
import { windowOn } from "./order-facts"
import type { TravelPlan } from "./travel-planner"

/** Dataset lanes of orders not on the driver market yet: the ones publishing moves. */
const UNPOSTED_LANES = new Set(["intake", "ready"])

/**
 * - `unposted`: not on the market yet and not ready to publish (still being checked, or waiting on a person);
 * - `confirm`: not on the market yet, Solved: waiting for publication approval;
 * - `market`: on the driver market (published here, or Finding a driver in the data);
 * - `posted`: further along in the data (driver assigned, moving, delivered, cancelled).
 */
export type Stage = "unposted" | "confirm" | "market" | "posted"

export type PublicationKind = "published" | "confirmed" | "filtered" | "planned" | "plan_failed"

export type StoredPublicationEvent = {
  orderId: string
  at: string
  by: "agent" | "operator"
  kind: PublicationKind
  text: string
  data: {
    /** `confirmed`: the call results (effect event ids) the operator confirmed. */
    effectIds?: string[]
    check?: DemandCheck
    plan?: TravelPlan
    error?: string
  } | null
}

/** The demand filter's result: is the job demanding, and why. */
export type DemandCheck = {
  demanding: boolean
  /** One line per criterion met; empty when it is not demanding. */
  reasons: string[]
  from: { city: string; country: string }
  to: { city: string; country: string }
  crossBorder: boolean
  /** Route length (journey plan segments). */
  km: number | null
  /** km at DRIVE_KMH; null without a route length. */
  driveHours: number | null
  /** Ferry or train legs the route needs between the endpoints. */
  crossings: string[]
}

/** A call result the agent committed that waits for the operator's yes, as a rewrite of what it settled. */
export type SolvedChange = {
  effectId: string
  at: string
  /** The point it settles (the effect event's fact). */
  point: string
  /** What the calls were about: the rules, checks and proposals the call carried. */
  asked: string[]
  /** What the records said before: one line per superseded record. */
  before: { recordId: string; text: string }[]
  /** What the call says now. */
  after: string
  call: { id: string; line: string; who: string; endedAt: string | null; tier: number; transcript: TranscriptLine[] } | null
}

/** A change a person confirmed on the agent's call, waiting for the operator's yes with the order's other call results. */
export type CallChange = { proposalId: string; title: string; change: string; who: string }

export type Publication = {
  stage: Stage
  /** The dataset lane is New orders or Ready to post: publishing moves this order. */
  inFlow: boolean
  /** The lane to show: the dataset's, or Fixed, review it / Finding a driver once publishing moved it. */
  lane: string
  published: { at: string; by: "agent" | "operator" } | null
  /** Call results waiting for the operator's yes (the Solved group). */
  pending: SolvedChange[]
  /** Changes from the agent's calls waiting for the same yes; on any order, not only one not published yet. */
  changes: CallChange[]
  check: DemandCheck | null
  plan: TravelPlan | null
  planError: string | null
  /** On drivers' phones: on the market, filtered, and planned when demanding. */
  live: boolean
  /** The travel budget, EUR. */
  budgetEur: number
}

/** Average road speed with short stops, km/h: the filter's hours of driving. */
export const DRIVE_KMH = 75
/** More driving than this makes a job demanding. */
export const LONG_DRIVE_HOURS = 12

export const isUnposted = (bundle: Bundle) => UNPOSTED_LANES.has(bundle.order.lane)

/**
 * The order's travel budget, EUR: a stand-in until real budgets exist. A whole
 * number from 30 to 200 in steps of 5, fixed per order by its reference.
 */
export function travelBudget(reference: string): number {
  let hash = 0
  for (const char of reference) hash = (hash * 31 + char.charCodeAt(0)) % 1_000_003
  return 30 + (hash % 35) * 5
}

/** The journey plan's segments, in order. */
function routeSegments(bundle: Bundle) {
  const planId = journeyPlan(bundle).plan?.id ?? null
  return rows(bundle, "transport_segments")
    .filter((row) => !planId || row.details.plan_id === planId)
    .sort((a, b) => (num(a.details.sequence) ?? 0) - (num(b.details.sequence) ?? 0))
}

function placeOf(bundle: Bundle, addressId: string | null | undefined): { city: string; country: string } {
  const place = addressId ? bundle.places.get(addressId) : undefined
  return { city: place?.city ?? "unknown", country: place?.country ?? "?" }
}

/**
 * The demand filter: cross-country, more than LONG_DRIVE_HOURS of driving, or a ferry
 * or train needed between the endpoints. Deterministic, with its reasons.
 */
export function demandCheck(bundle: Bundle): DemandCheck {
  const from = placeOf(bundle, str(originPickupPoint(bundle)?.details.address_id) ?? bundle.order.pickupAddressId)
  const to = placeOf(bundle, str(finalDeliveryPoint(bundle)?.details.address_id) ?? bundle.order.deliveryAddressId)
  const segments = routeSegments(bundle)
  const lengths = segments.map((row) => num(row.details.distance_km)).filter((km): km is number => km !== null)
  const km = lengths.length ? lengths.reduce((sum, value) => sum + value, 0) : null
  const driveHours = km === null ? null : Math.round((km / DRIVE_KMH) * 10) / 10
  const modes = segments.map((row) => str(row.details.transport_mode) ?? "")
  const crossings = [
    ...(modes.some((mode) => /FERRY/.test(mode)) ? ["ferry crossing on the route"] : []),
    ...(modes.some((mode) => /TRAIN|RAIL/.test(mode)) ? ["rail leg on the route"] : []),
  ]
  if (!crossings.length && rows(bundle, "travel_options").some((row) => row.details.kind === "FERRY")) crossings.push("ferry quotes on the order")
  const crossBorder = from.country !== "?" && to.country !== "?" && from.country !== to.country
  const reasons = [
    ...(crossBorder ? [`Cross-country: ${from.city} (${from.country}) to ${to.city} (${to.country}).`] : []),
    ...(driveHours !== null && driveHours > LONG_DRIVE_HOURS ? [`About ${driveHours} h of driving (${km} km at ${DRIVE_KMH} km/h), more than ${LONG_DRIVE_HOURS} h.`] : []),
    ...crossings.map((text) => `Needs a ${text.startsWith("rail") ? "train" : "ferry"}: ${text}.`),
  ]
  return { demanding: reasons.length > 0, reasons, from, to, crossBorder, km, driveHours, crossings }
}

/** The order's pickup slot and delivery promise, for the planner and the job card. */
export function jobWindows(bundle: Bundle): { pickup: { start: string; end: string; zone: string | null } | null; delivery: { start: string; end: string; zone: string | null } | null } {
  const read = (row: ReturnType<typeof windowOn>) => {
    const start = str(row?.details.start_at)
    const end = str(row?.details.end_at)
    return row && start && end ? { start, end, zone: str(row.details.timezone) } : null
  }
  const pickupPoint = originPickupPoint(bundle)?.id
  const deliveryPoint = finalDeliveryPoint(bundle)?.id
  return {
    pickup: read(windowOn(bundle, pickupPoint, "SELECTED_PICKUP_SLOT", true) ?? windowOn(bundle, pickupPoint, "REQUESTED_PICKUP_SLOT", null) ?? windowOn(bundle, pickupPoint, "PICKUP_AVAILABILITY", null)),
    delivery: read(windowOn(bundle, deliveryPoint, "CUSTOMER_DELIVERY_PROMISE", true) ?? windowOn(bundle, deliveryPoint, "SELECTED_DELIVERY_SLOT", true) ?? windowOn(bundle, deliveryPoint, "REQUESTED_DELIVERY_SLOT", null)),
  }
}

/** Call results the agent commits alone (ADR 0001): what the operator confirms. */
const CALL_RESULTS = new Set(["call_result_recorded", "eta_reported"])

const FIELDS = ["body", "summary", "claim", "text", "note", "description", "estimated_delivery_at", "status"]

/** One record of the snapshot (or an earlier effect event) as one line, for the "before" side of a rewrite. */
export function recordLine(bundle: Bundle, effects: EffectEvent[], recordId: string): string {
  const effect = effects.find((event) => event.id === recordId)
  if (effect) return effect.text
  const message = bundle.messages.find((row) => row.id === recordId)
  if (message) return `${message.authorType.toLowerCase()} message, ${fmtDateTime(message.authoredAt)}: "${message.body}"`
  const alert = bundle.alerts.find((row) => row.id === recordId)
  if (alert) return `Alert (${alert.signal.toLowerCase().replace(/_/g, " ")}): ${alert.summary}`
  const thread = bundle.conversations.find((row) => row.id === recordId)
  if (thread) return `Conversation (${thread.category.toLowerCase().replace(/_/g, " ")}), ${thread.status.toLowerCase()}`
  for (const [collection, list] of Object.entries(bundle.related)) {
    const row = list?.find((item) => item.id === recordId)
    if (!row) continue
    const name = collection.replace(/_/g, " ").replace(/s$/, "")
    const field = FIELDS.find((key) => str(row.details[key]))
    if (collection === "tracking_observations") {
      const eta = str(row.details.estimated_delivery_at)
      return `Tracking ${fmtDateTime(str(row.details.observed_at))}${eta ? `: ETA ${fmtDateTime(eta)}` : ""}`
    }
    return field ? `${name[0].toUpperCase()}${name.slice(1)}: ${String(row.details[field]).replace(/_/g, " ")}` : `${name[0].toUpperCase()}${name.slice(1)} ${recordId}`
  }
  return `Record ${recordId}`
}

/** The confirmed call results: every effect id a `confirmed` event names. */
function confirmedIds(events: StoredPublicationEvent[]): Set<string> {
  return new Set(events.filter((event) => event.kind === "confirmed").flatMap((event) => event.data?.effectIds ?? []))
}

/**
 * The call results waiting for the operator's yes before publishing, as rewrites: the
 * agent's own call results (not one the operator wrote, such as a closed handover), not
 * confirmed yet. Only an order not published yet has any: once an order is on the market
 * or past it, call results are committed as they are, and the order is never Solved
 * (orders not published and orders on the road are kept apart).
 * `raw` is the snapshot bundle, so "before" reads the records as they were.
 */
export function pendingChanges(raw: Bundle, effects: EffectEvent[], calls: Call[], events: StoredPublicationEvent[]): SolvedChange[] {
  if (!isUnposted(raw) || events.some((event) => event.kind === "published")) return []
  const confirmed = confirmedIds(events)
  // A result a newer version replaced (the operator's closed handover, a later ETA) is history, not a change to confirm.
  const replaced = new Set(effects.flatMap((event) => event.supersedes))
  return effects
    .filter((event) => event.by === "agent" && CALL_RESULTS.has(event.type) && !confirmed.has(event.id) && !replaced.has(event.id))
    .map((event) => {
      const call = calls.find((row) => row.id === event.source) ?? null
      const who = call ? call.callee.name ?? call.callee.handle : null
      const asked = call ? call.topics.map((topic) => topic.title) : []
      // "what the site said on the call" says less than the topics the call asked about.
      const generic = !event.fact || event.fact.key.startsWith("call:")
      return {
        effectId: event.id, at: event.at,
        point: generic && asked.length ? asked.join("; ") : event.fact?.label ?? "What the call settled",
        asked,
        before: event.supersedes.map((recordId) => ({ recordId, text: recordLine(raw, effects, recordId) })),
        after: event.type === "call_result_recorded" ? event.claim : event.text,
        call: call && who ? { id: call.id, line: call.line, who, endedAt: call.endedAt, tier: call.tier, transcript: call.transcript } : null,
      }
    })
}

/** What the Solved group's reason says about each pending result. */
export const solvedText = (change: SolvedChange) => `${change.call ? `${change.call.who} (${change.call.line})` : "A call"}: ${change.after}`

/** The order's publication: its stage, lane, filter, plan and whether drivers see it. */
export function publicationOf(bundle: Bundle, group: string, pending: SolvedChange[], events: StoredPublicationEvent[], changes: CallChange[] = []): Publication {
  const inFlow = isUnposted(bundle)
  const published = events.find((event) => event.kind === "published") ?? null
  const onMarket = bundle.order.lane === "market" || (inFlow && !!published)
  const stage: Stage = onMarket ? "market" : !inFlow ? "posted" : group === "solved" ? "confirm" : "unposted"
  const filtered = [...events].reverse().find((event) => event.kind === "filtered")
  const planned = [...events].reverse().find((event) => event.kind === "planned" || event.kind === "plan_failed")
  const check = filtered?.data?.check ?? null
  const plan = planned?.kind === "planned" ? planned.data?.plan ?? null : null
  return {
    stage, inFlow,
    lane: stage === "market" ? "market" : stage === "confirm" ? "confirm" : bundle.order.lane,
    published: published ? { at: published.at, by: published.by } : null,
    pending, changes, check, plan,
    planError: planned?.kind === "plan_failed" ? planned.data?.error ?? "The planner failed." : null,
    live: stage === "market" && !!check && (!check.demanding || !!planned),
    budgetEur: travelBudget(bundle.order.reference),
  }
}
