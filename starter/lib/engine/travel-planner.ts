// The travel planner (spec .scratch/publishing): a rough travel plan for a demanding
// job (publishing.ts decides which), drafted within the order's travel budget. The plan
// is a recommendation only: nothing is booked. Drivers see it with the job on their
// phone; the operator sees it folded away on the order page.
//
// A model drafts the plan from the order's places, windows, route, the dataset's travel
// quotes, the ferry terminals and the budget; its reply is validated and cached (keyed by
// prompt version, model and inputs). Without a model, or when the reply is rejected, a
// template plan made by fixed rules stands in, with the reason. Never throws.

import { createHash } from "node:crypto"
import { num, rows, str, type Bundle } from "@/lib/present/bundle"
import { fmtDateTime } from "@/lib/present/time"
import type { Row } from "@/lib/present/types"
import type { Effort, ModelGateway } from "@/lib/reviewer/gateway"
import { DEFAULT_REVIEWER_MODEL } from "@/lib/reviewer/reviewer"
import { jobWindows, type DemandCheck } from "./publishing"

export const PLAN_VERSION = "travel-plan-v3"
/** Only a drive of more than this many hours of continuous driving gets a hotel night; shorter drives never do. */
export const HOTEL_DRIVE_HOURS = 12
const PLAN_TIMEOUT_MS = 60_000

export type LegKind = "train" | "ferry" | "hotel" | "drive" | "flight" | "local"
export const LEG_KINDS: LegKind[] = ["train", "ferry", "hotel", "drive", "flight", "local"]

export type TravelLeg = {
  kind: LegKind
  from: string
  to: string
  /** When, in words ("evening before pickup, around 18:00"). */
  when: string
  /** Rough cost, whole EUR; 0 when there is nothing to pay (the drive itself). */
  costEur: number
  note: string
}

export type TravelPlan = {
  summary: string
  hotel: { needed: boolean; why: string }
  legs: TravelLeg[]
  totalEur: number
  budgetEur: number
  withinBudget: boolean
  caveats: string[]
  /** "model" or "template" (no model, or its reply was rejected: `note` says why). */
  source: "model" | "template"
  model: string | null
  /** Model cost, USD (0 on a cache hit or a template). */
  cost: number
  cached: boolean
  note: string | null
}

/** What the planner reads about one job. */
export type PlanInput = {
  reference: string
  from: { city: string; country: string; address: string | null; zone: string | null }
  to: { city: string; country: string; address: string | null; zone: string | null }
  pickupWindow: { start: string; end: string; zone: string | null } | null
  deliveryWindow: { start: string; end: string; zone: string | null } | null
  km: number | null
  driveHours: number | null
  demandReasons: string[]
  crossings: string[]
  /** The order's travel quotes in the dataset (train, ferry, flight), as recorded. */
  quotes: { kind: string; provider: string | null; from: string | null; to: string | null; departureAt: string | null; arrivalAt: string | null; eur: number | null; status: string | null; note: string | null }[]
  terminals: { id: string; name: string; city: string; country: string }[]
  roadEstimates: { fromCity: string; toTerminal: string; km: number | null; hoursLow: number | null; hoursHigh: number | null }[]
  budgetEur: number
}

/** Reference data the planner reads besides the order: ferry terminals and city-to-terminal road estimates. */
export type TravelReference = { terminals: Row[]; roadEstimates: Row[] }

export type CachedPlan = Omit<TravelPlan, "cached" | "source" | "note"> & { source: "model" }
export interface PlanCache {
  get(key: string): Promise<CachedPlan | null>
  put(key: string, plan: CachedPlan): Promise<void>
}

export type TravelOptions = {
  gateway?: ModelGateway | null
  cache?: PlanCache
  /** Default: TRAVEL_MODEL, then REVIEWER_MODEL, then the reviewer's default. */
  model?: string
  effort?: Effort
  reference?: TravelReference
  timeoutMs?: number
}

export function planInput(bundle: Bundle, check: DemandCheck, budgetEur: number, reference: TravelReference = { terminals: [], roadEstimates: [] }): PlanInput {
  const windows = jobWindows(bundle)
  const pickup = bundle.places.get(bundle.order.pickupAddressId)
  const delivery = bundle.places.get(bundle.order.deliveryAddressId)
  const eur = (cents: unknown) => { const value = num(cents); return value === null ? null : Math.round(value / 100) }
  return {
    reference: bundle.order.reference,
    from: { ...check.from, address: str(pickup?.details.address_line1), zone: str(pickup?.details.timezone) },
    to: { ...check.to, address: str(delivery?.details.address_line1), zone: str(delivery?.details.timezone) },
    pickupWindow: windows.pickup, deliveryWindow: windows.delivery,
    km: check.km, driveHours: check.driveHours, demandReasons: check.reasons, crossings: check.crossings,
    quotes: rows(bundle, "travel_options").map(({ details: d }) => ({
      kind: str(d.kind) ?? "?", provider: str(d.provider), from: str(d.from_city), to: str(d.to_city),
      departureAt: str(d.departure_at), arrivalAt: str(d.arrival_at), eur: eur(d.quote_cents), status: str(d.status), note: str(d.capacity_note),
    })),
    terminals: reference.terminals.map((d) => ({ id: str(d.id) ?? "", name: str(d.name) ?? "", city: str(d.city) ?? "", country: str(d.country) ?? "" })),
    roadEstimates: reference.roadEstimates.map((d) => ({
      fromCity: str(d.from_city) ?? "", toTerminal: str(d.to_terminal_id) ?? "", km: num(d.approximate_road_distance_km),
      hoursLow: num(d.drive_minutes_low) === null ? null : num(d.drive_minutes_low)! / 60, hoursHigh: num(d.drive_minutes_high) === null ? null : num(d.drive_minutes_high)! / 60,
    })),
    budgetEur,
  }
}

/** "22 Oct 09:00 CEST" in the place's zone, like the job card; "time to agree" without a time. */
const at = (iso: string | null | undefined, zone: string | null | undefined) => (iso && fmtDateTime(iso, zone)) || "time to agree"

/** The template plan: fixed rules, rough prices. Used without a model or when its reply is rejected. */
export function templatePlan(input: PlanInput, note: string): TravelPlan {
  const legs: TravelLeg[] = []
  const pickupAt = input.pickupWindow?.start ?? null
  const pickupZone = input.pickupWindow?.zone ?? input.from.zone
  legs.push({ kind: "train", from: "Driver's home area", to: input.from.city, when: `Before the pickup slot (${at(pickupAt, pickupZone)})`, costEur: 40, note: "Rough fare; the driver's home is not known before a driver takes the job." })
  const hours = input.driveHours
  const hotel = hours !== null && hours > HOTEL_DRIVE_HOURS
  legs.push({ kind: "drive", from: input.from.city, to: input.to.city, when: `From pickup (${at(pickupAt, pickupZone)})`, costEur: 0, note: hours !== null ? `About ${hours} h for ${input.km} km.` : "Route length not recorded." })
  if (hotel) legs.push({ kind: "hotel", from: "About halfway", to: "About halfway", when: "Night after pickup", costEur: 90, note: `More than ${HOTEL_DRIVE_HOURS} h of driving: one night stop.` })
  if (input.crossings.some((text) => text.includes("ferry"))) {
    const ferry = input.quotes.filter((quote) => quote.kind === "FERRY" && quote.eur !== null && quote.status !== "SOLD_OUT").sort((a, b) => a.eur! - b.eur!)[0]
    legs.push(ferry
      ? { kind: "ferry", from: ferry.from ?? "Terminal", to: ferry.to ?? "Terminal", when: at(ferry.departureAt, input.from.zone), costEur: ferry.eur!, note: `Cheapest open quote in the data (${ferry.provider ?? "provider not recorded"}).` }
      : { kind: "ferry", from: "Departure terminal", to: "Arrival terminal", when: "On the way", costEur: 0, note: "No ferry fare in the data: check the crossing and its price." })
  }
  legs.push({ kind: "train", from: input.to.city, to: "Driver's home area", when: `After delivery (${at(input.deliveryWindow?.end, input.deliveryWindow?.zone ?? input.to.zone)})`, costEur: 60, note: "Rough fare home." })
  const totalEur = legs.reduce((sum, leg) => sum + leg.costEur, 0)
  return {
    summary: `Train to ${input.from.city}, drive to ${input.to.city}${hotel ? " with one night stop" : ""}${legs.some((leg) => leg.kind === "ferry") ? " and a ferry crossing" : ""}, then train home.`,
    hotel: { needed: hotel, why: hotel ? `about ${hours} h of driving` : hours !== null ? `${HOTEL_DRIVE_HOURS} h or less of driving` : "route length not recorded" },
    legs, totalEur, budgetEur: input.budgetEur, withinBudget: totalEur <= input.budgetEur,
    caveats: ["Rough prices, not quotes."],
    source: "template", model: null, cost: 0, cached: false, note,
  }
}

const SYSTEM = `You are the travel planner of a car-delivery company. A freelance driver will take a demanding car-delivery job (cross-country, a long drive, or a ferry or train crossing). Draft a rough, practical travel plan the driver can use as a suggestion. Nothing is booked.

You receive the job as JSON: pickup and delivery places, the pickup slot and delivery promise (UTC with the local zone), route length and estimated hours of driving, why the job counts as demanding, the order's recorded travel quotes, the company's ferry terminals with city-to-terminal road estimates, and the driver's travel budget in EUR.

Plan, in order: getting the driver to the pickup city in time for the pickup slot (train, or a flight only when much cheaper or faster), the drive itself, a hotel night only when the drive from pickup to delivery needs more than ${HOTEL_DRIVE_HOURS} hours of continuous driving, ferry or train tickets the route needs, and the way home after delivery.

Rules:
- Hotels: recommend one only when the estimated hours of driving are more than ${HOTEL_DRIVE_HOURS}. Otherwise set hotel.needed to false and plan no hotel leg, even with a ferry or train crossing or a late arrival.
- Use the recorded quotes when they fit (same crossing, open, before the delivery promise); never pick a quote marked SOLD_OUT.
- Prices are rough whole euros. Say "rough" in a leg's note when you estimate.
- Keep the total within the budget when you can; when you cannot, choose the cheapest workable plan and say so in the caveats.
- The driver's home is not known yet: write "Driver's home area".
- Times in "when" are short phrases with UTC times from the input, e.g. "evening before pickup, train arriving by 2026-10-24 18:00 UTC".
- At most four caveats, one short sentence each.
- Plain English, short. No markdown.

Reply with only a JSON object:
{"summary": "...", "hotel": {"needed": true|false, "why": "..."}, "legs": [{"kind": "train|ferry|hotel|drive|flight|local", "from": "...", "to": "...", "when": "...", "costEur": 0, "note": "..."}], "caveats": ["..."]}`

export function planKey(input: PlanInput, model: string): string {
  return createHash("sha256").update(`${PLAN_VERSION}\n${model}\n${JSON.stringify(input)}`).digest("hex")
}

class PlanRejected extends Error {}

function text(value: unknown, max: number, what: string): string {
  if (typeof value !== "string" || !value.trim()) throw new PlanRejected(`${what} is missing`)
  if (value.length > max) throw new PlanRejected(`${what} is too long`)
  return value.trim()
}

/** The model's reply as a plan, or PlanRejected. The total and the budget check are computed here, never taken from the model. */
export function parsePlan(content: string | null, input: PlanInput): Omit<TravelPlan, "source" | "model" | "cost" | "cached" | "note"> {
  const raw = (content ?? "").trim()
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as Record<string, unknown>
  } catch {
    throw new PlanRejected("the reply was not JSON")
  }
  const hotel = (parsed.hotel ?? {}) as Record<string, unknown>
  if (typeof hotel.needed !== "boolean") throw new PlanRejected("hotel.needed is missing")
  if (!Array.isArray(parsed.legs) || parsed.legs.length === 0 || parsed.legs.length > 12) throw new PlanRejected("the legs are missing or too many")
  const legs = parsed.legs.map((value, index): TravelLeg => {
    const leg = (value ?? {}) as Record<string, unknown>
    if (!LEG_KINDS.includes(leg.kind as LegKind)) throw new PlanRejected(`leg ${index + 1} has an unknown kind`)
    const cost = typeof leg.costEur === "number" ? leg.costEur : Number(leg.costEur)
    if (!Number.isFinite(cost) || cost < 0 || cost > 5000) throw new PlanRejected(`leg ${index + 1} has no sensible cost`)
    return {
      kind: leg.kind as LegKind, from: text(leg.from, 120, `leg ${index + 1} from`), to: text(leg.to, 120, `leg ${index + 1} to`),
      when: text(leg.when, 160, `leg ${index + 1} when`), costEur: Math.round(cost), note: typeof leg.note === "string" ? leg.note.trim().slice(0, 240) : "",
    }
  })
  if (hotel.needed && !legs.some((leg) => leg.kind === "hotel")) throw new PlanRejected("a hotel is needed but no hotel leg is planned")
  const shortDrive = input.driveHours !== null && input.driveHours <= HOTEL_DRIVE_HOURS
  if (shortDrive && (hotel.needed || legs.some((leg) => leg.kind === "hotel"))) throw new PlanRejected(`a hotel is planned for a drive of ${HOTEL_DRIVE_HOURS} h or less`)
  const totalEur = legs.reduce((sum, leg) => sum + leg.costEur, 0)
  const caveats = Array.isArray(parsed.caveats) ? parsed.caveats.filter((item): item is string => typeof item === "string").map((item) => item.slice(0, 400)).slice(0, 6) : []
  return {
    summary: text(parsed.summary, 600, "the summary"),
    hotel: { needed: hotel.needed, why: typeof hotel.why === "string" ? hotel.why.slice(0, 240) : "" },
    legs, totalEur, budgetEur: input.budgetEur, withinBudget: totalEur <= input.budgetEur, caveats,
  }
}

/** The plan for one job: a cached model plan, a fresh one, or the template with the reason. */
export async function planTrip(input: PlanInput, options: TravelOptions = {}): Promise<TravelPlan> {
  const { gateway, cache } = options
  if (!gateway) return templatePlan(input, "Template plan: no model key is set.")
  const model = options.model ?? process.env.TRAVEL_MODEL ?? process.env.REVIEWER_MODEL ?? DEFAULT_REVIEWER_MODEL
  const key = planKey(input, model)
  try {
    const hit = await cache?.get(key)
    if (hit) return { ...hit, cost: 0, cached: true, note: null }
  } catch {
    // A cache that cannot be read is a miss.
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const call = gateway.chat({
      job: "travel-plan", subject: input.reference, model, effort: options.effort ?? "low", maxTokens: 8000,
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: JSON.stringify(input) }],
    })
    const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new PlanRejected("the model was too slow")), options.timeoutMs ?? PLAN_TIMEOUT_MS) })
    const response = await Promise.race([call, late])
    const plan: CachedPlan = { ...parsePlan(response.message.content, input), source: "model", model: response.model || model, cost: response.usage.cost }
    await cache?.put(key, plan).catch(() => {})
    return { ...plan, cached: false, note: null }
  } catch (error) {
    const reason = error instanceof PlanRejected ? `the model's plan was rejected (${error.message})` : "the model call failed"
    return templatePlan(input, `Template plan: ${reason}.`)
  } finally {
    clearTimeout(timer)
  }
}
