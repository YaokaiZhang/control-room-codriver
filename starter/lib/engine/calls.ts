// Calls (ticket 10): the agent's mock phone calls to sites and drivers.
//
// State machine (spec "Call state machine"):
//
//   ringing ──answer──> answered ──> availability ──1──> tier1 ──all answered──> ended (resolved)
//      │                                 │                 │
//      ├─decline──> declined ─┐          └─2─> callback_time ──digit──> ended (callback)
//      └─no answer─> no_answer┴──> ended (callback; "unreachable" after MAX_ATTEMPTS)
//                                                          └─problem / unclear──> tier2
//   tier2: the voice agent (ticket 12, voice-agent.ts) takes the call there. It opens
//   with what it knows and one question; then the callee speaks (push-to-talk on a live
//   call, a model playing them in text on a simulated one) and the agent answers, until
//   it ends "resolved" or "handover". Without a voice agent, or a simulated callee that
//   cannot talk, the call ends politely as "handover" (ticket 14: a tier-3 handover).
//
// A call is an append-only list of events in the store; `foldCall` reads the current
// state from them. Two turns alternate:
// - the callee's (`expecting` is set): ring response or a keypad digit. Background
//   calls are answered by the simulated person; live calls (ticket 11) wait for the
//   phone page to send a `callEvent` command.
// - the agent's (`expecting` is null): `agentTurn` decides what to say next.
//
// "Who answers" is the seam: `CallOptions.answererFor(header)` returns "simulated" or
// "live" when a call starts; the engine only drives simulated callees itself.
//
// Lines: an order has at most one site line and one driver line. A line's topics are
// the rules' planned calls (`rule:R10`) and the reviewer's call proposals
// (`proposal:<id>`). A topic is covered once a call that carried it ended for good
// (resolved, handover, unreachable); a callback keeps it open until the callback runs.

import { createHash } from "node:crypto"
import { rows, str, type Bundle } from "@/lib/present/bundle"
import { endpointContactType, pickupCallAllowed } from "./contacts"
import { CONTACT_TYPE_LABEL, isCustomerSide, type ContactType } from "@/lib/reviewer/policy"
import {
  AVAILABLE_OPTIONS, CALLBACK_MINUTES, CALLBACK_OPTIONS, CALLBACK_QUESTION, callbackLine, CLOSING, greeting, HANDOVER_LINE,
  questionsFor, RETRY_PREFIX, TRANSFER_LINE, type KeyOption, type OptionEffect, type Question, type Topic,
} from "./call-script"
import type { PlannedAction, RuleId, SourceRef } from "./checks"
import type { DueItem } from "./due"
import { latestEta } from "./eta"
import { isFinished, movingAssignments, selectedPromise } from "./order-facts"
import type { Proposal } from "./proposals"
import type { TurnCheck, TurnPath } from "./voice-agent"
import { capital, plainName } from "@/lib/present/names"

export type CallLine = "site" | "driver"
export type CallState =
  | "ringing" | "answered" | "declined" | "no_answer"
  | "availability" | "callback_time" | "tier1" | "tier2" | "ended"
export type CallOutcome = "resolved" | "callback" | "handover" | "unreachable"
export type Answerer = "simulated" | "live"
export type CalleeInput = { type: "answer" } | { type: "decline" } | { type: "no_answer" } | { type: "key"; digit: string } | { type: "hang_up" }
export type Tier = 1 | 2 | 3

export type CallCallee = { name: string | null; handle: string; role: string | null; contactType: ContactType; recordId: string | null }

/** What a call is about and who it goes to; fixed when it starts. */
export type CallHeader = {
  callId: string
  orderId: string
  reference: string
  line: CallLine
  /** 1 for a first call; 2, 3 for callbacks in a row. */
  attempt: number
  answerer: Answerer
  callee: CallCallee
  topics: Topic[]
  questions: Question[]
  /** Why the agent calls, one line. */
  reason: string
  car: string | null
  /** The callee's time zone, for times said on the phone. */
  zone: string
}

export type CallEventKind =
  | "started" | "answered" | "declined" | "no_answer" | "said" | "pressed" | "tier" | "callback" | "ended"
  /** Tier 2: what the callee said (transcribed), and the checker's structured result for the turn. */
  | "heard" | "checked"
  /** The callee hung up. */
  | "hung_up"

/**
 * A tier-3 handover (ticket 14): a call the agent could not resolve ends politely and
 * hands an operator the open question, the proposed next step and the summary (the
 * transcript is on the call). Stored on the "ended" event as a `HandoverNote`.
 */
export type HandoverNote = { question: string; nextStep: string; summary: string }

/** How the operator closed a handover: what they learned, as the effect event they committed. */
export type HandoverClosed = { at: string; result: string; effectId: string }

/** A handover as the call shows it: open (`closed` null) until the operator records what they learned. */
export type Handover = HandoverNote & { closed: HandoverClosed | null }

export type CallChange = { title: string; change: string; claim: string }

export type StoredCallEvent = {
  callId: string
  orderId: string
  /** 0-based position in the call; (callId, seq) is unique, so two writers can't both append the same step. */
  seq: number
  /** Demo clock. */
  at: string
  /** Real time, for pacing and for measuring live answers. */
  wallAt: string
  by: "agent" | "callee"
  kind: CallEventKind
  text: string
  data: {
    header?: CallHeader
    /** "available", "callback_time" or "q<index>" for a tier-1 question; absent on a statement. */
    ask?: string
    audioId?: string | null
    /** How long the step took on the phone. */
    seconds?: number
    /** Model cost in USD (speech generation). */
    cost?: number
    cached?: boolean
    digit?: string
    label?: string
    tier?: Tier
    callbackAt?: string
    outcome?: CallOutcome
    summary?: string
    claims?: string[]
    changes?: CallChange[]
    /** Tier 2: the checker's result ("checked"), how the reply was made ("said"), the model that made it. */
    check?: TurnCheck
    path?: TurnPath
    model?: string | null
    /** Why a tier-2 step fell back (audio model or checker failed). */
    error?: string | null
    handover?: HandoverNote
  } | null
}

export type Expecting =
  | { type: "ring" }
  | { type: "key"; ask: string; text: string; options: { digit: string; label: string }[] }
  /** Tier 2: the callee's turn to speak (push-to-talk). */
  | { type: "speech" }

export type TranscriptLine = {
  at: string
  wallAt: string
  by: "agent" | "callee" | "system"
  text: string
  tier: Tier
  audioId: string | null
  /** Model cost of this step, USD. */
  cost: number
  /** Tier 2: the checker's structured result for the turn (on its "checked" line). */
  check?: TurnCheck
  /** Tier 2: the agent's reply came from the audio model or the fallback. */
  path?: TurnPath
}

export type CostRates = {
  /** Mock phone time, EUR per connected minute. */
  phonePerMinuteEur: number
  /** What an operator's minute costs, EUR (the comparison line). */
  operatorPerMinuteEur: number
  /** Model costs are reported in USD. */
  eurPerUsd: number
}

export const DEFAULT_RATES: CostRates = { phonePerMinuteEur: 0.01, operatorPerMinuteEur: 0.7, eurPerUsd: 0.92 }

export type CallCost = {
  /** Summed model `usage.cost` (speech), USD. */
  modelUsd: number
  ringSeconds: number
  /** Connected phone time. */
  phoneSeconds: number
  modelEur: number
  phoneEur: number
  totalEur: number
  /** The same call made by an operator: at least one minute. */
  operatorEur: number
  rates: CostRates
}

export type Call = Omit<CallHeader, "callId"> & {
  id: string
  state: CallState
  /** Every state the call went through, in order. */
  path: CallState[]
  tier: Tier
  /** What the callee must do next; null on the agent's turn or once ended. */
  expecting: Expecting | null
  answers: { ask: string; digit: string; label: string }[]
  transcript: TranscriptLine[]
  callbackAt: string | null
  outcome: CallOutcome | null
  summary: string | null
  claims: string[]
  changes: CallChange[]
  /** A call that ended unresolved (tier 3): what a person must pick up, and whether they did (ticket 14). */
  handover: Handover | null
  cost: CallCost
  startedAt: string
  endedAt: string | null
  /** Real time of the latest event (for pacing). */
  lastWallAt: string
  lastSeconds: number
}

export const MAX_ATTEMPTS = 3
const NO_ANSWER_CALLBACK_MINUTES = 30
const DECLINED_CALLBACK_MINUTES = 60
const UNCLEAR_CALLBACK_MINUTES = 60

const round = (value: number, digits = 6) => Math.round(value * 10 ** digits) / 10 ** digits

export function costOf(events: StoredCallEvent[], rates: CostRates): CallCost {
  let modelUsd = 0
  let ringSeconds = 0
  let phoneSeconds = 0
  let connected = false
  for (const event of events) {
    modelUsd += event.data?.cost ?? 0
    const seconds = event.data?.seconds ?? 0
    if (event.kind === "answered" || event.kind === "declined" || event.kind === "no_answer") { ringSeconds += seconds; connected = event.kind === "answered"; continue }
    if (connected) phoneSeconds += seconds
  }
  const modelEur = modelUsd * rates.eurPerUsd
  const phoneEur = (phoneSeconds / 60) * rates.phonePerMinuteEur
  const operatorEur = Math.max(1, (ringSeconds + phoneSeconds) / 60) * rates.operatorPerMinuteEur
  return {
    modelUsd: round(modelUsd), ringSeconds: round(ringSeconds, 1), phoneSeconds: round(phoneSeconds, 1),
    modelEur: round(modelEur), phoneEur: round(phoneEur), totalEur: round(modelEur + phoneEur), operatorEur: round(operatorEur, 4), rates,
  }
}

function optionsFor(header: CallHeader, ask: string): { text: string; options: KeyOption[] } | null {
  if (ask === "available") return { text: greeting({ name: header.callee.name, reference: header.reference, car: header.car, line: header.line }), options: AVAILABLE_OPTIONS }
  if (ask === "callback_time") return { text: CALLBACK_QUESTION, options: CALLBACK_OPTIONS }
  const question = header.questions[Number(ask.slice(1))]
  return question ? { text: question.text, options: question.options } : null
}

/** The fixed prompts a call may say, in the order it would say them: generated while it rings, they are ready when it is answered. */
export function promptsFor(header: CallHeader): string[] {
  return [optionsFor(header, "available")!.text, ...header.questions.map((question) => question.text), CLOSING, TRANSFER_LINE]
}

/** The call as it stands, from its events (oldest first). */
export function foldCall(events: StoredCallEvent[], rates: CostRates = DEFAULT_RATES): Call {
  const header = events[0]?.data?.header
  if (!header) throw new Error(`Call ${events[0]?.callId ?? "?"} has no start event`)
  let state: CallState = "ringing"
  const path: CallState[] = ["ringing"]
  let tier: Tier = 1
  let asking: string | null = null
  const answers: Call["answers"] = []
  const transcript: TranscriptLine[] = []
  let callbackAt: string | null = null
  let outcome: CallOutcome | null = null
  let summary: string | null = null
  let claims: string[] = []
  let changes: CallChange[] = []
  let handover: Handover | null = null
  let endedAt: string | null = null
  const move = (next: CallState) => { if (state !== next) { state = next; path.push(next) } }
  const line = (event: StoredCallEvent, by: TranscriptLine["by"], text: string) =>
    transcript.push({
      at: event.at, wallAt: event.wallAt, by, text, tier, audioId: event.data?.audioId ?? null, cost: event.data?.cost ?? 0,
      ...(event.data?.check ? { check: event.data.check } : {}), ...(event.data?.path ? { path: event.data.path } : {}),
    })
  for (const event of events) {
    switch (event.kind) {
      case "started":
        line(event, "system", event.text)
        break
      case "answered": case "declined": case "no_answer":
        move(event.kind)
        line(event, event.kind === "answered" ? "callee" : "system", event.text)
        break
      case "said": {
        const ask = event.data?.ask
        if (ask === "available") move("availability")
        else if (ask === "callback_time") move("callback_time")
        else if (ask && tier === 1) move("tier1")
        asking = ask ?? null
        line(event, "agent", event.text)
        break
      }
      case "pressed":
        answers.push({ ask: asking ?? "", digit: event.data?.digit ?? "", label: event.data?.label ?? "" })
        asking = null
        line(event, "callee", event.text)
        break
      case "tier":
        tier = event.data?.tier ?? 2
        move(tier === 2 ? "tier2" : state)
        line(event, "system", event.text)
        break
      case "heard":
        line(event, "callee", event.text)
        break
      case "checked":
        line(event, "system", event.text)
        break
      case "hung_up":
        line(event, "callee", event.text)
        break
      case "callback":
        callbackAt = event.data?.callbackAt ?? null
        line(event, "system", event.text)
        break
      case "ended":
        move("ended")
        outcome = event.data?.outcome ?? "resolved"
        summary = event.data?.summary ?? null
        claims = event.data?.claims ?? []
        changes = event.data?.changes ?? []
        handover = event.data?.handover ? { ...event.data.handover, closed: null } : null
        endedAt = event.at
        // Handed over: the call now sits with an operator (tier 3).
        if (outcome === "handover") tier = 3
        line(event, "system", event.text)
        break
    }
  }
  const last = events[events.length - 1]
  let expecting: Expecting | null = null
  if (state === "ringing") expecting = { type: "ring" }
  else if (state !== "ended" && asking && last.kind === "said") {
    const asked = optionsFor(header, asking)
    if (asked) expecting = { type: "key", ask: asking, text: last.text, options: asked.options.map(({ digit, label }) => ({ digit, label })) }
  } else if (state === "tier2" && last.kind === "said") {
    expecting = { type: "speech" }
  }
  const { callId, ...rest } = header
  return {
    ...rest, id: callId, state, path, tier, expecting, answers, transcript, callbackAt, outcome, summary, claims, changes, handover,
    cost: costOf(events, rates), startedAt: events[0].at, endedAt, lastWallAt: last.wallAt, lastSeconds: last.data?.seconds ?? 0,
  }
}

/** One step the agent takes: say something, or record a fact. Speech is added by the layer. */
export type AgentStep =
  | { kind: "said"; text: string; ask?: string }
  /** The voice agent's first words at tier 2: written by the call layer once the escalation is logged. */
  | { kind: "opener" }
  | { kind: "tier"; tier: Tier; text: string }
  | { kind: "callback"; callbackAt: string; text: string }
  | { kind: "ended"; outcome: CallOutcome; text: string; summary: string; claims: string[]; changes: CallChange[]; handover?: HandoverNote }

const MINUTE = 60_000
const addMinutes = (iso: string, minutes: number) => new Date(new Date(iso).getTime() + minutes * MINUTE).toISOString()

/** "14:15" in the callee's own zone: what the agent says on the phone. */
export function localTime(iso: string, zone: string): string {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: zone }).format(new Date(iso))
}

/** "11:15 UTC": operator-facing times, like the demo clock in the bar. */
export function utcTime(iso: string): string {
  return `${localTime(iso, "UTC")} UTC`
}

/** The callee's time zone: the pickup slot's for a site, the delivery promise's for a driver. */
function zoneOf(bundle: Bundle, line: CallLine): string {
  const purpose = line === "site" ? "SELECTED_PICKUP_SLOT" : "CUSTOMER_DELIVERY_PROMISE"
  const window = rows(bundle, "time_windows").find((row) => row.details.purpose === purpose && row.details.is_selected === true)
    ?? rows(bundle, "time_windows").find((row) => row.details.purpose === purpose)
  return str(window?.details.timezone) ?? "Europe/Helsinki"
}

function who(callee: CallCallee): string {
  return callee.name ? plainName(callee.name) : callee.handle
}

/** What the person said on the call, in order: claims, changes (as claims) and escalations. */
function said(call: Call): { claims: string[]; changes: CallChange[]; escalation: string | null } {
  const claims: string[] = []
  const changes: CallChange[] = []
  let escalation: string | null = null
  for (const answer of call.answers) {
    if (!answer.ask.startsWith("q")) continue
    const option = call.questions[Number(answer.ask.slice(1))]?.options.find((row) => row.digit === answer.digit)
    if (!option) continue
    const effect: OptionEffect = option.effect
    if (effect.type === "claim") claims.push(effect.text)
    if (effect.type === "change") { claims.push(effect.claim); changes.push({ title: effect.title, change: effect.change, claim: effect.claim }) }
    if (effect.type === "escalate") { claims.push(effect.text); escalation = effect.text }
  }
  return { claims, changes, escalation }
}

/**
 * Everything the person said on the call: the keypad's claims and changes, then the
 * latest successful tier-2 check's (each check lists the whole call so far). The voice
 * agent never agreed to any of them: changes become change proposals when the call ends.
 */
export function tier2Said(call: Call): { claims: string[]; changes: CallChange[] } {
  const keypad = said(call)
  const latest = [...call.transcript].reverse().find((line) => line.check && !line.check.failed)?.check
  const claims = [...keypad.claims]
  const changes = [...keypad.changes]
  for (const claim of latest?.claims ?? []) if (!claims.includes(claim)) claims.push(claim)
  for (const change of latest?.changes ?? []) if (!changes.some((row) => row.title === change.title && row.change === change.change)) changes.push(change)
  return { claims, changes }
}

/** A new ETA the callee stated on the call, as a time: when they said it and what they said. */
export type ReportedEta = { at: string; statedAt: string; claim: string }

/**
 * The newest ETA the callee gave at tier 2 (the latest successful check that carries
 * one), read from their local "HH:MM" in the call's zone, on the day the call took
 * place (the next day when that time is more than 12 h before the call).
 */
export function reportedEta(call: Call): ReportedEta | null {
  const line = [...call.transcript].reverse().find((row) => row.check && !row.check.failed && row.check.eta)
  const eta = line?.check?.eta
  if (!line || !eta) return null
  const at = eta.at ?? localToUtc(eta.local, call.zone, line.at)
  return at ? { at, statedAt: line.at, claim: eta.claim } : null
}

/** "16:30" in `zone`, on the local day of `around` (or the next day if that is over 12 h earlier), as ISO UTC. */
export function localToUtc(local: string, zone: string, around: string): string | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(local.trim())
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  const parts = (instant: number) => Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(instant)).map((part) => [part.type, part.value]))
  const base = new Date(around).getTime()
  const day = parts(base)
  // The zone's offset at that moment: wall time read as UTC, minus the instant.
  const offsetAt = (instant: number) => {
    const wall = parts(instant)
    return Date.UTC(Number(wall.year), Number(wall.month) - 1, Number(wall.day), Number(wall.hour), Number(wall.minute)) - Math.floor(instant / MINUTE) * MINUTE
  }
  const naive = Date.UTC(Number(day.year), Number(day.month) - 1, Number(day.day), hours, minutes)
  let utc = naive - offsetAt(naive)
  utc = naive - offsetAt(utc)
  if (base - utc > 12 * 60 * MINUTE) utc += 24 * 60 * MINUTE
  return new Date(utc).toISOString()
}

function ending(call: Call, outcome: CallOutcome, text: string, extra: { escalation?: string | null } = {}): AgentStep {
  const { claims, changes } = said(call)
  const name = who(call.callee)
  const Name = capital(name)
  const summary = outcome === "resolved" ? `${Name}: ${claims.length ? claims.join("; ") : "nothing to report"}.`
    : outcome === "handover" ? `${Name}: ${extra.escalation ?? "needs a conversation"}. A person should follow up.`
    : outcome === "unreachable" ? `No answer from ${name} after ${call.attempt} attempts.`
    : call.path.includes("declined") ? `${Name} declined the call.`
    : call.path.includes("no_answer") ? `${Name} did not answer.`
    : `${name} was busy and asked for a callback.`
  // An escalation nobody could talk through (no voice agent, or a simulated callee that cannot talk) is a tier-3 handover too.
  const handover: HandoverNote | undefined = outcome === "handover" ? {
    question: `${extra.escalation ?? "The callee needs a conversation"}: what does the order need now?`,
    nextStep: `Call ${name} back (${call.topics.map((topic) => topic.title).join("; ") || "the call's topics"}), then record what you learned.`,
    summary: `${Name}: ${extra.escalation ?? "needs a conversation"}.`,
  } : undefined
  return { kind: "ended", outcome, text: summary, summary, claims, changes, ...(handover ? { handover } : {}) }
}

/**
 * The agent's next steps on a call whose turn it is (`expecting` null), as of the
 * demo time `now`. `tier2`: a voice agent can take the call over (ticket 12), so an
 * escalation moves to tier 2 and the agent opens; otherwise it ends as a handover.
 */
export function agentTurn(call: Call, now: string, tier2: boolean, lastEvent: StoredCallEvent): AgentStep[] {
  if (call.state === "ended" || call.expecting) return []
  const next = (from: number): AgentStep[] => {
    const answered = new Set(call.answers.filter((row) => row.ask.startsWith("q") && call.questions[Number(row.ask.slice(1))]?.options.some((option) => option.digit === row.digit)).map((row) => row.ask))
    const index = call.questions.findIndex((_question, i) => i >= from && !answered.has(`q${i}`))
    if (index < 0) return [{ kind: "said", text: CLOSING }, ending(call, "resolved", CLOSING)]
    return [{ kind: "said", text: call.questions[index].text, ask: `q${index}` }]
  }
  const callback = (minutes: number, line: boolean): AgentStep[] => {
    if (call.attempt >= MAX_ATTEMPTS) return [ending(call, "unreachable", "")]
    const callbackAt = addMinutes(now, minutes)
    return [
      ...(line ? [{ kind: "said" as const, text: callbackLine(localTime(callbackAt, call.zone ?? "Europe/Helsinki")) }] : []),
      { kind: "callback", callbackAt, text: `Callback scheduled for ${utcTime(callbackAt)}.` },
      ending(call, "callback", ""),
    ]
  }
  switch (lastEvent.kind) {
    case "answered":
      return [{ kind: "said", text: optionsFor(headerOf(call), "available")!.text, ask: "available" }]
    case "declined":
      return callback(DECLINED_CALLBACK_MINUTES, false)
    case "no_answer":
      return callback(NO_ANSWER_CALLBACK_MINUTES, false)
    case "hung_up":
      return call.tier >= 2 ? [hungUp(call)] : callback(UNCLEAR_CALLBACK_MINUTES, false)
    case "pressed": {
      const answer = call.answers[call.answers.length - 1]
      const asked = optionsFor(headerOf(call), answer.ask)
      const option = asked?.options.find((row) => row.digit === answer.digit)
      const retried = call.answers.filter((row) => row.ask === answer.ask).length > 1
      if (!option) {
        if (!retried && asked) return [{ kind: "said", text: RETRY_PREFIX + asked.text, ask: answer.ask }]
        if (answer.ask === "available" || answer.ask === "callback_time") return callback(UNCLEAR_CALLBACK_MINUTES, true)
        return escalate(call, "Unclear keypad answers", tier2)
      }
      if (answer.ask === "available") return option.digit === "1" ? next(0) : [{ kind: "said", text: CALLBACK_QUESTION, ask: "callback_time" }]
      if (answer.ask === "callback_time") return callback(CALLBACK_MINUTES[option.digit] ?? UNCLEAR_CALLBACK_MINUTES, true)
      if (option.effect.type === "escalate") return escalate(call, option.effect.text, tier2)
      return next(Number(answer.ask.slice(1)) + 1)
    }
    default:
      return []
  }
}

function hungUp(call: Call): AgentStep {
  const latest = [...call.transcript].reverse().find((line) => line.check && !line.check.failed)?.check
  const learned = latest ? ` So far: ${latest.summary}` : ""
  const summary = `${capital(who(call.callee))} hung up during the voice call.${learned} A person should follow up.`
  const { claims, changes } = tier2Said(call)
  return { kind: "ended", outcome: "handover", text: summary, summary, claims, changes,
    handover: { question: latest?.openQuestion ?? "The callee hung up before the problem was settled.", nextStep: latest?.nextStep ?? `Call ${who(call.callee)} back.`, summary } }
}

function escalate(call: Call, why: string, tier2: boolean): AgentStep[] {
  const move: AgentStep = { kind: "tier", tier: 2, text: `Moved to tier 2: ${why}.` }
  if (tier2) return [{ kind: "said", text: TRANSFER_LINE }, move, { kind: "opener" }]
  return [move, { kind: "said", text: HANDOVER_LINE }, ending(call, "handover", HANDOVER_LINE, { escalation: why })]
}

function headerOf(call: Call): CallHeader {
  return {
    callId: call.id, orderId: call.orderId, reference: call.reference, line: call.line, attempt: call.attempt, answerer: call.answerer,
    callee: call.callee, topics: call.topics, questions: call.questions, reason: call.reason, car: call.car, zone: call.zone,
  }
}

/** Is the callee's input acceptable now? Returns why not, or null. */
export function refuseInput(call: Call, input: CalleeInput): string | null {
  if (call.state === "ended") return `${call.id} has ended`
  if (input.type === "hang_up") return call.state === "ringing" ? `${call.id} is ringing: decline it instead` : null
  if (!call.expecting) return `${call.id} is waiting for the agent`
  if (call.expecting.type === "speech") return `${call.id} is listening: speak (push-to-talk) or hang up`
  if (call.expecting.type === "ring" && input.type === "key") return `${call.id} is ringing: answer, decline or let it ring out first`
  if (call.expecting.type === "key" && input.type !== "key") return `${call.id} is waiting for a keypad answer`
  if (input.type === "key" && !/^[0-9*#]$/.test(input.digit)) return `"${input.digit}" is not a keypad key`
  return null
}

/** The stored event for a callee's input. */
export function calleeEvent(call: Call, input: CalleeInput, base: Pick<StoredCallEvent, "callId" | "orderId" | "seq" | "at" | "wallAt">, seconds: number): StoredCallEvent {
  const name = capital(who(call.callee))
  switch (input.type) {
    case "answer": return { ...base, by: "callee", kind: "answered", text: `${name} answered.`, data: { seconds } }
    case "decline": return { ...base, by: "callee", kind: "declined", text: `${name} declined the call.`, data: { seconds } }
    case "no_answer": return { ...base, by: "callee", kind: "no_answer", text: "No answer.", data: { seconds } }
    case "hang_up": return { ...base, by: "callee", kind: "hung_up", text: `${name} hung up.`, data: { seconds } }
    case "key": {
      const ask = call.expecting?.type === "key" ? call.expecting.ask : ""
      const label = call.expecting?.type === "key" ? call.expecting.options.find((option) => option.digit === input.digit)?.label ?? "not an option" : ""
      return { ...base, by: "callee", kind: "pressed", text: `Pressed ${input.digit}: ${label}.`, data: { seconds, digit: input.digit, label, ask } }
    }
  }
}

// -- Lines: what each order needs from calls ----------------------------------

export type LineStatus =
  /** Topics to call about and nothing started yet. */
  | "to_call"
  /** A call is running. */
  | "calling"
  /** The last call asked for a callback that has not come due. */
  | "callback"
  /** The callback time has come; the agent calls on its next run. */
  | "callback_due"
  /** The last call was handed over (tier 3) and the operator has not recorded what they learned yet. */
  | "handover"
  /** The last call ended needing a person (no answer after every attempt). */
  | "needs_person"
  /**
   * Something worth asking, but only when the operator rings it live (ticket 12): a
   * driver whose ETA is close to the promise end ("can you still deliver on time?").
   * The pump never starts it; it holds nothing in grouping.
   */
  | "on_request"
  /** Nothing left to call about. */
  | "done"

export type CallLineView = {
  line: CallLine
  status: LineStatus
  callee: CallCallee | null
  /** Topics no finished call has covered yet. */
  open: Topic[]
  latest: Call | null
  /** One line for the order's reason. */
  text: string
}

/** A planned call the agent will not make: the callee is on the customer side (ADR 0001). */
export type BlockedCall = { line: CallLine; ruleIds: RuleId[]; text: string }

export type OrderCalls = {
  orderId: string
  calls: Call[]
  lines: CallLineView[]
  blocked: BlockedCall[]
  /** The rules' planned work without the site/driver calls the call lines now carry. */
  planned: PlannedAction[]
  /** Call proposals a running call or callback carries (their "Agent will call" reason is the line's). */
  carried: Set<string>
}

/**
 * A call topic's title per rule: what the call asks the callee about. R6 (the delivery
 * promise was not set by the customer) asks the pickup place only whether the car will be
 * ready in the booked slot (call-script.ts "ready"); the promise itself stays the
 * customer's and is never discussed on a call (ADR 0001).
 */
const RULE_TOPIC_TITLE: Partial<Record<RuleId, string>> = {
  R1: "Signed release", R4: "Contact confirmed only from the site profile", R5: "Contact not confirmed", R6: "Car ready in the booked pickup slot",
  NEXT: "Next check due", R10: "Tracking is stale", R12: "ETA after the promise",
}

/**
 * The rules whose site call is a pickup-readiness call (release, contact, car ready). R6 stays:
 * its question is the readiness one, which keeps the 18 planned site calls the user approved.
 */
const PICKUP_READINESS_RULES = new Set<RuleId>(["R1", "R4", "R5", "R6", "NEXT"])

/**
 * The contact type of a planned call's endpoint (ADR 0001, contacts.ts), and whether the
 * agent may call it. This is the call layer's own guard, whatever plans the call: a
 * third-party site, yes; the customer side only for a pickup-readiness call (policy row
 * pickup-readiness: a pickup endpoint, every topic a pickup-readiness rule); otherwise no.
 */
function plannedContact(bundle: Bundle, endpointId: string, ruleIds: RuleId[]): { type: ContactType; allowed: boolean } {
  const endpoint = rows(bundle, "order_endpoint_details").find((row) => row.id === endpointId)
  if (!endpoint) return { type: "third_party_site", allowed: true }
  const type = endpointContactType(bundle, endpoint)
  if (!isCustomerSide(type)) return { type, allowed: true }
  const readiness = endpoint.details.boundary === "PICKUP" && ruleIds.length > 0 && ruleIds.every((id) => PICKUP_READINESS_RULES.has(id))
  return { type, allowed: readiness && pickupCallAllowed(type) }
}

/** How close an ETA may come to the promise end before the operator may ask the driver (ticket 12). */
export const TIGHT_ETA_MINUTES = 10

/**
 * A car on the road whose latest ETA is inside the delivery promise but within
 * TIGHT_ETA_MINUTES of its end: the reason to ask "can you still deliver on time?"
 * (story 71, CD-420437). R12 covers an ETA after the end; this is the near miss.
 */
export function tightEta(bundle: Bundle): { text: string; recordId: string } | null {
  // The same reading as R12 (order-facts.ts): a finished order, no car on the road or no
  // selected promise on the final delivery point means nothing to ask.
  if (isFinished(bundle) || !movingAssignments(bundle).length) return null
  const promise = selectedPromise(bundle)
  // The latest ETA as it stands now: a driver's reported time replaces the tracking
  // estimate, and an estimate a call already answered is no reason to ask again.
  const latest = latestEta(bundle)
  const end = str(promise?.details.end_at)
  if (!latest || latest.superseded || !end) return null
  const margin = (new Date(end).getTime() - new Date(latest.at).getTime()) / MINUTE
  if (margin < 0 || margin > TIGHT_ETA_MINUTES) return null
  return { text: `Latest ETA ${utcTime(latest.at)} is ${Math.round(margin)} min before the promise ends at ${utcTime(end)}`, recordId: latest.recordId }
}

/**
 * The records a call on a rule asks about: the rule's sources a person on the phone can
 * restate (a position or ETA, a thread waiting on them, a document, an earlier call
 * result). The order's own structure (endpoint contacts, windows, sites, assignments,
 * expenses) changes only through a typed effect after a yes, never by a call result:
 * the delivery promise in particular is the customer's (ADR 0001).
 */
const RESTATABLE = new Set(["tracking_observations", "conversations", "messages", "documents", "alerts", "effect_events"])

export function askedRecords(sources: SourceRef[] | undefined): string[] {
  return [...new Set((sources ?? []).filter((source) => RESTATABLE.has(source.collection)).map((source) => source.id))]
}

/**
 * The records a call on a proposal asks about: its cited conflict evidence that the
 * callee stated, or that no person stated (system records such as tracking). Another
 * party's statement stays live: a driver does not overwrite what the customer said.
 */
export function proposalRecords(proposal: Proposal, callee: { name: string | null; handle: string }): string[] {
  const byCallee = statedByCallee(callee)
  return [...new Set(proposal.evidence.filter((cited) => cited.role === "conflict"
    && (!cited.statedBy || byCallee(cited.statedBy))).map((cited) => cited.recordId))]
}

/** Whether a record's `stated_by` names the callee (their handle or name appears in it). */
export function statedByCallee(callee: { name: string | null; handle: string }): (statedBy: string) => boolean {
  const marks = [callee.handle, callee.name].filter((mark): mark is string => !!mark).map((mark) => mark.toLowerCase())
  return (statedBy) => marks.some((mark) => statedBy.toLowerCase().includes(mark))
}

/**
 * The records a finished call's result supersedes: those of every topic the person
 * answered on the call (a keypad answer to a question on that topic, including the
 * answer that moved the call to tier 2).
 */
export function answeredRecords(call: Call): string[] {
  const answered = new Set<string>()
  for (const answer of call.answers) {
    if (!answer.ask.startsWith("q")) continue
    for (const topic of call.questions[Number(answer.ask.slice(1))]?.topics ?? []) answered.add(topic)
  }
  return [...new Set(call.topics.filter((topic) => answered.has(topic.id)).flatMap((topic) => topic.records ?? []))]
}

export function driverOf(bundle: Bundle): CallCallee | null {
  const assignment = movingAssignments(bundle)[0] ?? rows(bundle, "work_assignments").find((row) => row.details.order_id === bundle.order.id)
  const driverId = str(assignment?.details.driver_id)
  if (!assignment || !driverId) return null
  return { name: bundle.dir.driverName(driverId), handle: driverId, role: "driver", contactType: "driver", recordId: assignment.id }
}

export function carOf(bundle: Bundle): string | null {
  const vehicle = bundle.items[0]?.vehicle
  return vehicle ? `${vehicle.make} ${vehicle.model}` : null
}

const COVERING: CallOutcome[] = ["resolved", "handover", "unreachable"]

/**
 * Pure: an order's planned calls and call proposals, and its calls so far (oldest
 * first), as lines with a status at `now`.
 */
export function orderCalls(bundle: Bundle, planned: PlannedAction[], proposals: Proposal[], calls: Call[], now: string): OrderCalls {
  const blocked: BlockedCall[] = []
  const topics = new Map<CallLine, { callee: CallCallee | null; topics: Topic[] }>()
  const add = (line: CallLine, callee: CallCallee | null, topic: Topic) => {
    const entry = topics.get(line) ?? { callee, topics: [] }
    entry.callee ??= callee
    if (!entry.topics.some((row) => row.id === topic.id)) entry.topics.push(topic)
    topics.set(line, entry)
  }
  for (const action of planned) {
    if (action.kind === "reviewer_pass") continue
    const line: CallLine = action.kind === "site_call" ? "site" : "driver"
    let callee: CallCallee | null = null
    if (action.kind === "site_call" && action.callee) {
      const { type, allowed } = plannedContact(bundle, action.callee.endpointId, action.ruleIds)
      if (!allowed) {
        blocked.push({ line, ruleIds: action.ruleIds, text: `No call to ${action.callee.name ?? action.callee.handle}: a ${CONTACT_TYPE_LABEL[type].toLowerCase()} is customer side and this is not a pickup-readiness call, so the agent only proposes.` })
        continue
      }
      callee = { name: action.callee.name, handle: action.callee.handle, role: action.callee.role, contactType: type, recordId: action.callee.endpointId }
    } else if (action.kind === "driver_call") {
      callee = driverOf(bundle)
    }
    if (!callee) continue
    for (const id of action.ruleIds) add(line, callee, { id: `rule:${id}`, kind: "rule", title: RULE_TOPIC_TITLE[id] ?? id, records: askedRecords(action.sources?.[id]) })
  }
  const tight = tightEta(bundle)
  if (tight && !topics.get("driver")?.topics.some((topic) => topic.id === "rule:R12")) {
    const callee = driverOf(bundle)
    if (callee) add("driver", callee, { id: "check:on_time", kind: "check", title: tight.text, records: [tight.recordId] })
  }
  for (const proposal of proposals) {
    // A reviewer finding for a customer-side contact is a customer_contact proposal, never a call.
    if (proposal.kind !== "call" || proposal.waitingOn !== "agent" || !proposal.contact.handle || isCustomerSide(proposal.contact.type)) continue
    const line: CallLine = proposal.contact.type === "driver" || proposal.contact.role === "driver" ? "driver" : "site"
    const callee = { name: proposal.contact.name, handle: proposal.contact.handle, role: proposal.contact.role, contactType: proposal.contact.type, recordId: proposal.contact.recordId }
    add(line, callee, { id: `proposal:${proposal.id}`, kind: "proposal", title: proposal.title, script: proposal.script, records: proposalRecords(proposal, callee) })
  }

  const lines: CallLineView[] = []
  const carried = new Set<string>()
  const lineNames = new Set<CallLine>([...topics.keys(), ...calls.map((call) => call.line)])
  for (const line of (["site", "driver"] as CallLine[]).filter((name) => lineNames.has(name))) {
    const onLine = calls.filter((call) => call.line === line)
    const covered = new Set(onLine.filter((call) => call.outcome && COVERING.includes(call.outcome)).flatMap((call) => call.topics.map((topic) => topic.id)))
    const entry = topics.get(line)
    const open = (entry?.topics ?? []).filter((topic) => !covered.has(topic.id))
    const latest = onLine[onLine.length - 1] ?? null
    const callee = entry?.callee ?? latest?.callee ?? null
    const name = callee ? who(callee) : line
    let status: LineStatus
    let text: string
    if (latest && latest.state !== "ended") {
      status = "calling"
      text = `Calling ${name}: ${latest.reason}`
    } else if (latest?.outcome === "handover" && latest.handover && !latest.handover.closed) {
      // An open handover holds the line: no new call until the operator has acted.
      status = "handover"
      text = `Handover from the call with ${name}: ${latest.handover.question}`
    } else if (latest?.outcome === "callback" && latest.callbackAt && (open.length || latest.topics.length)) {
      status = latest.callbackAt > now ? "callback" : "callback_due"
      text = status === "callback" ? `Callback to ${name} at ${utcTime(latest.callbackAt)}.` : `Callback to ${name} is due; the agent calls now.`
    } else if (open.length && open.every((topic) => topic.kind === "check")) {
      status = "on_request"
      text = `Ask ${name} if they can still deliver on time: ${open.map((topic) => topic.title).join("; ")}.`
    } else if (open.length) {
      status = "to_call"
      text = `Agent will call ${name}: ${open.map((topic) => topic.title).join("; ")}.`
    } else if (latest?.handover?.closed) {
      status = "done"
      text = `Handover closed by the operator: ${latest.handover.closed.result}`
    } else if (latest && (latest.outcome === "handover" || latest.outcome === "unreachable")) {
      status = "needs_person"
      text = `Call needs a person: ${latest.summary ?? latest.reason}`
    } else {
      status = "done"
      text = latest?.summary ? `Call result: ${latest.summary}` : ""
    }
    if (status === "calling" || status === "callback" || status === "callback_due") {
      for (const topic of [...(latest?.topics ?? []), ...open]) if (topic.kind === "proposal") carried.add(topic.id.slice("proposal:".length))
    }
    lines.push({ line, status, callee, open, latest, text })
  }
  // Planned site/driver calls are now carried by the lines: keep them in `planned` only until a call starts.
  const keep = planned.filter((action) => {
    if (action.kind === "reviewer_pass") return true
    const line = lines.find((row) => row.line === (action.kind === "site_call" ? "site" : "driver"))
    return !!line && line.status === "to_call" && line.latest === null && line.open.some((topic) => action.ruleIds.some((id) => topic.id === `rule:${id}`))
  })
  return { orderId: bundle.order.id, calls, lines, blocked, planned: keep, carried }
}

/** Starting a call on a line: its header. */
export function newCallHeader(bundle: Bundle, line: CallLineView, previous: Call[], answerer: (header: Omit<CallHeader, "answerer">) => Answerer): CallHeader {
  const callee = line.callee
  if (!callee) throw new Error(`${bundle.order.reference}: no one to call on the ${line.line} line`)
  const onLine = previous.filter((call) => call.line === line.line)
  const latest = onLine[onLine.length - 1]
  const attempt = latest?.outcome === "callback" ? latest.attempt + 1 : 1
  // A callback carries the topics of the call it follows up, plus any new ones.
  const topics = [...(attempt > 1 ? latest!.topics.filter((topic) => !line.open.some((row) => row.id === topic.id)) : []), ...line.open]
  const base: Omit<CallHeader, "answerer"> = {
    callId: `call-${bundle.order.id}-${line.line}-${onLine.length + 1}`,
    orderId: bundle.order.id, reference: bundle.order.reference, line: line.line, attempt, callee, topics,
    questions: questionsFor(topics, callee),
    reason: `${attempt > 1 ? `Callback (attempt ${attempt}). ` : ""}${topics.map((topic) => topic.title).join("; ")}.`,
    car: carOf(bundle), zone: zoneOf(bundle, line.line),
  }
  return { ...base, answerer: answerer(base) }
}

/** Callbacks as due items (level-based like next checks: due once the clock reaches them). */
export function callbackItems(calls: Call[]): Omit<DueItem, "due">[] {
  return calls.filter((call) => call.outcome === "callback" && call.callbackAt).map((call) => ({
    id: `callback:${call.id}`, kind: "callback" as const, at: call.callbackAt!, orderId: call.orderId, reference: call.reference,
    title: "Callback", detail: `to ${who(call.callee)}`, label: `Callback to ${who(call.callee)} on ${call.reference}`,
  }))
}

/** A stable small number per string, for the simulated person's variety. */
export function bucket(text: string, size: number): number {
  return parseInt(createHash("sha256").update(text).digest("hex").slice(0, 8), 16) % size
}
