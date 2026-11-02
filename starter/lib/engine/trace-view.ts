// What the engineers' trace pages show (spec .scratch/traceability, issue 04): one
// order's timeline (/dev/trace/[orderId]) and one agent run (/dev/trace/run/[runId]).
// Plain data from the engine's store and the trace store; the pages only render it.
//
// The timeline puts two clocks on one line. Order events (proposal events, effects,
// calls, operator mistakes) carry the demo clock; agent runs carry real time. A run is
// placed at the latest demo-clock moment known to have passed by its real start (from
// rows that carry both clocks: call steps and operator mistakes; else the snapshot
// time). Rows at the same demo time go by real time; a row with no real time takes its
// parent's (a proposal event its run's, an effect its proposal's or call's), so it
// follows what it came from. Each line shows its own time and which clock it is.

import { readLessons } from "./lessons"
import type { OrderState } from "./engine"
import type { EngineStore } from "./store"
import type { StoredCallEvent } from "./calls"
import { rebuildRequest, type AgentRunRow, type LoggedRequest, type LoggedResponse, type TraceStore } from "@/lib/reviewer/trace"
import type { Usage } from "@/lib/reviewer/gateway"

export type TraceLink = {
  label: string
  /** null: nothing to open; `note` says why ("not traced"). */
  href: string | null
  note?: string
}

export type TraceLineKind = "run" | "finding" | "proposal" | "effect" | "call" | "mistake"

export type TraceLine = {
  /** The line's anchor on the page: a run, finding, effect, call or mistake id; a proposal's first event carries the proposal id. */
  id: string
  kind: TraceLineKind
  /** The line's own time; null when it has none. */
  at: string | null
  clock: "demo" | "real"
  title: string
  detail: string | null
  /** Its parents first, then where else it opens. */
  links: TraceLink[]
  /** A run's job. */
  job?: string
  /** A proposal event's proposal and event kind. */
  proposalId?: string
  event?: string
  /** A call's steps, oldest first. */
  steps?: { at: string; by: string; kind: string; text: string }[]
  /** The row as stored, for a collapsible block. */
  raw?: unknown
}

export type OrderTrace = { orderId: string; reference: string; lines: TraceLine[] }

export type TraceSources = { store: EngineStore; traces: TraceStore }

export const runHref = (runId: string) => `/dev/trace/run/${encodeURIComponent(runId)}`
export const orderTraceHref = (orderIdOrReference: string) => `/dev/trace/${encodeURIComponent(orderIdOrReference)}`
export const learningHref = (anchor?: string) => anchor ? `/dev/learning#${encodeURIComponent(anchor)}` : "/dev/learning"

const NOT_TRACED = "not traced"

/** The order with this id or reference. */
export function findOrder(orders: OrderState[], idOrReference: string): OrderState | null {
  return orders.find((order) => order.id === idOrReference) ?? orders.find((order) => order.reference === idOrReference) ?? null
}

/** Agents whose runs name an order by its reference (their `subject`). */
const ORDER_JOBS = new Set(["reviewer", "call-callee", "call-opener", "call-check", "travel-plan"])

const ms = (iso: string | null | undefined) => iso ? Date.parse(iso) : NaN
const money = (value: number | null) => value === null ? "-" : `$${value.toFixed(4)}`

/** Real time -> the latest demo time known to have passed by then. */
function demoClock(pairs: { real: number; demo: number }[], floor: number): (real: number) => number {
  const sorted = pairs.filter((pair) => !Number.isNaN(pair.real) && !Number.isNaN(pair.demo)).sort((a, b) => a.real - b.real)
  return (real) => {
    let demo = floor
    for (const pair of sorted) {
      if (pair.real > real) break
      demo = Math.max(demo, pair.demo)
    }
    return demo
  }
}

type Placed = TraceLine & { sortDemo: number; sortReal: number; rank: number; seq: number }

const RANK: Record<TraceLineKind, number> = { run: 0, finding: 1, call: 2, proposal: 3, effect: 4, mistake: 5 }

export type OrderTraceInput = TraceSources & { order: OrderState; snapshotAt: string }

/** One timeline for the order, oldest first (see the top of this file for the two clocks). */
export async function orderTrace({ order, snapshotAt, store, traces }: OrderTraceInput): Promise<OrderTrace> {
  const [allEvents, allCallEvents, allMistakes] = await Promise.all([store.readProposalEvents(), store.readCallEvents(), store.readMistakes()])
  const proposalEvents = allEvents.filter((event) => event.orderId === order.id)
  const mistakes = allMistakes.filter((mistake) => mistake.orderId === order.id)
  const callEvents = new Map<string, StoredCallEvent[]>()
  for (const event of allCallEvents.filter((row) => row.orderId === order.id).sort((a, b) => a.seq - b.seq)) {
    callEvents.set(event.callId, [...(callEvents.get(event.callId) ?? []), event])
  }

  // Runs: the order's (by reference), its mistakes' restatements, and any run a row names.
  const named = new Set<string>([order.review.runId, ...proposalEvents.map((event) => event.data?.runId), ...mistakes.map((mistake) => mistake.runId)].filter((id): id is string => !!id))
  const found = new Map<string, AgentRunRow>()
  for (const run of (await traces.readRuns({ subject: order.reference })).filter((row) => ORDER_JOBS.has(row.job))) found.set(run.id, run)
  for (const mistake of mistakes) for (const run of await traces.readRuns({ subject: mistake.id })) found.set(run.id, run)
  for (const id of named) {
    if (found.has(id)) continue
    const run = await traces.readRun(id)
    if (run) found.set(id, run)
  }

  const toDemo = demoClock([
    ...allCallEvents.map((event) => ({ real: ms(event.wallAt), demo: ms(event.at) })),
    ...allMistakes.filter((mistake) => mistake.operator !== null).map((mistake) => ({ real: ms(mistake.recordedAt), demo: ms(mistake.at) })),
  ], ms(snapshotAt))
  const realOfRun = (id: string | null | undefined) => id ? ms(found.get(id)?.startedAt) : NaN
  const runLink = (id: string | null | undefined): TraceLink => id && found.has(id) ? { label: "run", href: runHref(id) }
    : { label: "run", href: null, note: id ? `${NOT_TRACED} (${id} has no row)` : NOT_TRACED }
  const findingIds = new Set(order.review.findings.map((finding) => finding.id))
  const findingLink = (id: string): TraceLink => findingIds.has(id) ? { label: "finding", href: `#${id}` } : { label: "finding", href: null, note: `${id}, not in the current review` }
  const callIds = new Set(order.calls.map((call) => call.id))
  const callWindow = new Map(order.calls.map((call) => {
    const steps = callEvents.get(call.id) ?? []
    return [call.id, { from: ms(steps[0]?.wallAt), to: ms(steps.at(-1)?.wallAt) }]
  }))

  const out: Placed[] = []
  const place = (line: TraceLine, sortDemo: number, sortReal: number) => out.push({ ...line, sortDemo, sortReal, rank: RANK[line.kind], seq: out.length })

  // Runs.
  for (const run of found.values()) {
    const real = ms(run.startedAt)
    const links: TraceLink[] = []
    if (run.parentRunId) links.push({ label: "parent run", href: runHref(run.parentRunId) })
    const during = [...callWindow].find(([, window]) => run.job.startsWith("call-") && real >= window.from && real <= window.to)
    if (during) links.push({ label: "call", href: `#${during[0]}` })
    const mistake = mistakes.find((row) => row.id === run.subject)
    if (mistake) links.push({ label: "mistake", href: `#${mistake.id}` })
    links.push({ label: "open run", href: runHref(run.id) })
    place({
      id: run.id, kind: "run", at: run.startedAt, clock: "real", job: run.job,
      title: `${run.job} run: ${run.outcome}`,
      detail: [run.model, run.promptVersion, `${run.lessonIds.length} lesson${run.lessonIds.length === 1 ? "" : "s"}`, money(run.cost)].filter(Boolean).join(" · "),
      links,
    }, toDemo(real), real)
  }

  // The current review's findings.
  for (const finding of order.review.findings) {
    const real = Number.isNaN(realOfRun(order.review.runId)) ? ms(order.review.reviewedAt) : realOfRun(order.review.runId)
    place({
      id: finding.id, kind: "finding", at: order.review.reviewedAt, clock: "real",
      title: `finding: ${finding.title}`,
      detail: `ask ${finding.ask.name} (${finding.ask.contactType}): ${finding.question} Cites ${finding.cited.map((row) => row.recordId).join(", ") || "-"}.`,
      links: [runLink(order.review.runId)],
      raw: finding,
    }, toDemo(real), real)
  }

  // Calls, folded with their steps.
  for (const call of order.calls) {
    const steps = callEvents.get(call.id) ?? []
    place({
      id: call.id, kind: "call", at: call.startedAt, clock: "demo",
      title: `call to ${call.callee.name ?? call.callee.handle} (${call.line}, attempt ${call.attempt}): ${call.state}`,
      detail: [call.reason, call.outcome && `outcome ${call.outcome}`, call.summary].filter(Boolean).join(" · "),
      links: [],
      steps: steps.map((step) => ({ at: step.at, by: step.by, kind: step.kind, text: step.text })),
    }, ms(call.startedAt), callWindow.get(call.id)!.from)
  }

  // Proposal events: the stored ones, and the `proposed` line of a finding's proposal (never stored).
  type Row = { proposalId: string; at: string; by: string; kind: string; text: string; runId: string | null | undefined; findingId: string | null; source: string | null }
  const rows: Row[] = proposalEvents.map((event) => {
    const proposal = order.proposals.find((row) => row.id === event.proposalId)
    return {
      proposalId: event.proposalId, at: event.at, by: event.by, kind: event.kind, text: event.text,
      runId: event.data?.runId ?? event.data?.draft?.runId, findingId: event.data?.findingId ?? event.data?.draft?.findingId ?? proposal?.findingId ?? null,
      source: event.data?.draft?.source ?? proposal?.source ?? null,
    }
  })
  // The draft as first proposed: kept on the proposal's first stored event, else the proposal shown now.
  for (const event of proposalEvents) {
    const draft = event.data?.draft
    if (!draft || rows.some((row) => row.proposalId === event.proposalId && row.kind === "proposed")) continue
    rows.unshift({ proposalId: event.proposalId, at: draft.proposedAt, by: "agent", kind: "proposed", text: draft.action, runId: draft.runId, findingId: draft.findingId, source: draft.source })
  }
  for (const proposal of order.proposals) {
    if (rows.some((row) => row.proposalId === proposal.id && row.kind === "proposed")) continue
    const proposed = proposal.history.find((event) => event.kind === "proposed")
    if (proposed) rows.unshift({ proposalId: proposal.id, at: proposed.at, by: proposed.by, kind: "proposed", text: proposed.text, runId: proposal.runId, findingId: proposal.findingId, source: proposal.source })
  }
  const proposalReal = new Map<string, { demo: number; real: number }[]>()
  for (const [n, row] of [...rows].sort((a, b) => ms(a.at) - ms(b.at)).entries()) {
    const links: TraceLink[] = []
    if (row.findingId) links.push(findingLink(row.findingId))
    if (row.findingId || row.runId) links.push(runLink(row.runId))
    if (row.source && callIds.has(row.source)) links.push({ label: "call", href: `#${row.source}` })
    const real = !Number.isNaN(realOfRun(row.runId)) ? realOfRun(row.runId) : row.source && callIds.has(row.source) ? callWindow.get(row.source)!.to : NaN
    proposalReal.set(row.proposalId, [...(proposalReal.get(row.proposalId) ?? []), { demo: ms(row.at), real }])
    place({
      id: `${row.proposalId}.${n}`, kind: "proposal", at: row.at, clock: "demo",
      proposalId: row.proposalId, event: row.kind,
      title: `${row.kind} by ${row.by}: ${row.proposalId}`, detail: row.text || null, links,
    }, ms(row.at), real)
  }

  // Effects, from their proposal or call.
  for (const effect of order.effects) {
    const links: TraceLink[] = []
    let real = NaN
    if (proposalReal.has(effect.source)) {
      links.push({ label: "proposal", href: `#${effect.source}` })
      const before = (proposalReal.get(effect.source) ?? []).filter((row) => row.demo <= ms(effect.at))
      real = (before.at(-1) ?? proposalReal.get(effect.source)?.[0])?.real ?? NaN
    } else if (callIds.has(effect.source)) {
      links.push({ label: "call", href: `#${effect.source}` })
      real = callWindow.get(effect.source)!.to
    } else {
      links.push({ label: "source", href: null, note: effect.source })
    }
    place({
      id: effect.id, kind: "effect", at: effect.at, clock: "demo",
      title: `effect ${effect.type} v${effect.version} by ${effect.by}`, detail: effect.text, links, raw: effect,
    }, ms(effect.at), real)
  }

  // Mistakes.
  for (const mistake of mistakes) {
    const demoClocked = mistake.operator !== null
    const links: TraceLink[] = [runLink(mistake.runId)]
    if (mistake.findingId) links.push(findingLink(mistake.findingId))
    links.push({ label: "learning", href: learningHref(mistake.id) })
    place({
      id: mistake.id, kind: "mistake", at: mistake.at, clock: demoClocked ? "demo" : "real",
      title: `mistake (${mistake.agent}, ${mistake.kind}): ${mistake.status}`,
      detail: [mistake.operatorNote && `note: ${mistake.operatorNote}`, mistake.restatement && `restated: ${mistake.restatement}`, mistake.validatorReason && `validator: ${mistake.validatorReason}`].filter(Boolean).join(" · ") || null,
      links,
    }, demoClocked ? ms(mistake.at) : toDemo(ms(mistake.at)), ms(mistake.recordedAt))
  }

  const key = (value: number) => Number.isNaN(value) ? Number.POSITIVE_INFINITY : value
  out.sort((a, b) => key(a.sortDemo) - key(b.sortDemo) || key(a.sortReal) - key(b.sortReal) || a.rank - b.rank || a.seq - b.seq)
  // A proposal's first line carries the proposal id (what effects link to).
  const anchored = new Set<string>()
  for (const line of out) {
    if (line.kind !== "proposal" || anchored.has(line.proposalId!)) continue
    anchored.add(line.proposalId!)
    line.id = line.proposalId!
  }
  return { orderId: order.id, reference: order.reference, lines: out.map(({ sortDemo: _d, sortReal: _r, rank: _k, seq: _s, ...line }) => line) }
}

export type RunCall = {
  turn: number
  at: string
  latencyMs: number
  /** The turn's request in full (`rebuildRequest`); the stored row when it cannot be rebuilt. */
  request: LoggedRequest
  /** The request as stored (only what the turn added). */
  stored: LoggedRequest
  rebuildError: string | null
  response: LoggedResponse | null
  usage: Usage | null
  error: string | null
}

export type RunTrace = {
  run: AgentRunRow
  parent: AgentRunRow | null
  /** Oldest first. */
  children: AgentRunRow[]
  /** The lessons in its prompt; `text` null when the lesson is not stored. */
  lessons: { id: string; text: string | null; status: string | null; href: string }[]
  /** The system prompt as sent (cr_prompt_texts); null when none was stored. */
  prompt: string | null
  calls: RunCall[]
  /** Where the run's subject is shown: the order's trace, or /dev/learning. */
  subjectHref: string | null
}

/** One run with its prompt, lessons and turns; null when there is no such run. */
export async function runTrace(runId: string, { store, traces }: TraceSources): Promise<RunTrace | null> {
  const run = await traces.readRun(runId)
  if (!run) return null
  const [parent, children, rows, prompt, lessons] = await Promise.all([
    run.parentRunId ? traces.readRun(run.parentRunId) : Promise.resolve(null),
    traces.readRuns({ parentRunId: run.id }),
    traces.readCalls(run.id),
    run.promptHash ? traces.readPrompt(run.promptHash) : Promise.resolve(null),
    run.lessonIds.length ? readLessons(store) : Promise.resolve([]),
  ])
  const calls = rows.map((row): RunCall => {
    let request = row.request
    let rebuildError: string | null = null
    try {
      request = rebuildRequest(rows, row.turn)
    } catch (error) {
      rebuildError = error instanceof Error ? error.message : String(error)
    }
    return { turn: row.turn, at: row.at, latencyMs: row.latencyMs, request, stored: row.request, rebuildError, response: row.response, usage: row.usage, error: row.error }
  })
  const subjectHref = ORDER_JOBS.has(run.job) ? orderTraceHref(run.subject)
    : run.job === "restate" ? learningHref(run.subject)
    : run.job === "distil" || run.job === "judge" ? learningHref() : null
  return {
    run, parent, children, prompt, calls, subjectHref,
    lessons: run.lessonIds.map((id) => {
      const lesson = lessons.find((row) => row.id === id)
      return { id, text: lesson?.text ?? null, status: lesson?.status ?? null, href: learningHref(id) }
    }),
  }
}
