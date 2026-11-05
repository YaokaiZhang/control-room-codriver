// The control room's own tables. ADR 0002: none of them has a foreign key into the
// starter's tables, so reseeding keeps working, and the snapshot is never edited.
// Every table is prefixed `cr_` and listed in ENGINE_TABLES (state, which reset truncates),
// CACHE_TABLES (content-keyed caches, which reset keeps), LEARNING_TABLES (what the
// agents learn from, which reset keeps) or TRACE_TABLES (agent runs and model calls,
// which reset keeps).

import type { GateTrace } from "./distil"
import type { Usage } from "../reviewer/gateway"
import type { LoggedRequest, LoggedResponse } from "../reviewer/trace"
import { bigserial, boolean, doublePrecision, index, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core"

/** One row (id "current") once the demo clock has moved; no row means the clock is at its start. */
export const demoClock = pgTable("cr_demo_clock", {
  id: text("id").primaryKey(),
  now: timestamp("now", { withTimezone: true }).notNull(),
})

/**
 * Reviewer results (ticket 05), keyed by a hash of the case file plus prompt version and model.
 * `result` is the `Reviewed` value from lib/reviewer/reviewer.ts.
 */
export const reviewResults = pgTable("cr_review_results", {
  key: text("key").primaryKey(),
  orderId: text("order_id").notNull(),
  caseHash: text("case_hash").notNull(),
  result: jsonb("result").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (table) => [index("cr_review_results_order_idx").on(table.orderId)])

/**
 * The Briefing inbox (ticket 13): delivered digests and pushes. `id` makes delivery
 * at-most-once ("digest:12:00", "push:<order id>:<reason>"); `item` is the BriefingItem.
 */
export const briefingItems = pgTable("cr_briefing_items", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  at: timestamp("at", { withTimezone: true }).notNull(),
  item: jsonb("item").$type<Record<string, unknown>>().notNull(),
  read: boolean("read").notNull().default(false),
})

/** Digest prose the model wrote, keyed by a hash of the digest facts (plus prompt version and model). */
export const digestProse = pgTable("cr_digest_prose", {
  key: text("key").primaryKey(),
  prose: jsonb("prose").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
})

/**
 * Proposal history (ticket 07): append-only operator decisions on proposals
 * (approved, edited, dismissed, instructed, answered) and engine-made proposals
 * ("proposed", with the draft in `data`). Proposals are folded from these rows plus
 * the current review's findings (lib/engine/proposals.ts).
 */
export const proposalEvents = pgTable("cr_proposal_events", {
  seq: bigserial("seq", { mode: "number" }).primaryKey(),
  proposalId: text("proposal_id").notNull(),
  orderId: text("order_id").notNull(),
  at: timestamp("at", { withTimezone: true }).notNull(),
  by: text("by").notNull(),
  kind: text("kind").notNull(),
  text: text("text").notNull(),
  data: jsonb("data").$type<Record<string, unknown>>(),
}, (table) => [index("cr_proposal_events_order_idx").on(table.orderId)])

/**
 * Effect events (ticket 09, ADR 0002): append-only committed changes to an order.
 * The order view, rules and reviewer read the snapshot with these applied
 * (lib/engine/effects.ts). `effect` is the type-specific part (endpoint, window,
 * claim, answer, cost).
 */
export const effectEvents = pgTable("cr_effect_events", {
  seq: bigserial("seq", { mode: "number" }).primaryKey(),
  id: text("id").notNull().unique(),
  orderId: text("order_id").notNull(),
  type: text("type").notNull(),
  at: timestamp("at", { withTimezone: true }).notNull(),
  by: text("by").notNull(),
  source: text("source").notNull(),
  text: text("text").notNull(),
  effect: jsonb("effect").$type<Record<string, unknown>>().notNull(),
}, (table) => [index("cr_effect_events_order_idx").on(table.orderId)])

/**
 * Calls (ticket 10): append-only events per call; the first ("started") carries the
 * call's header. (call_id, seq) is the key, so two writers cannot take the same step.
 * Calls, call turns, call costs and callbacks are all folded from these rows (lib/engine/calls.ts).
 */
export const callEvents = pgTable("cr_call_events", {
  callId: text("call_id").notNull(),
  seq: integer("seq").notNull(),
  orderId: text("order_id").notNull(),
  at: timestamp("at", { withTimezone: true }).notNull(),
  wallAt: timestamp("wall_at", { withTimezone: true }).notNull(),
  by: text("by").notNull(),
  kind: text("kind").notNull(),
  text: text("text").notNull(),
  data: jsonb("data").$type<Record<string, unknown>>(),
}, (table) => [primaryKey({ columns: [table.callId, table.seq] }), index("cr_call_events_order_idx").on(table.orderId)])

/**
 * Publication events (spec .scratch/publishing, ADR 0003): append-only, per order.
 * `published`, `confirmed` (call results the operator confirmed), `filtered` (the
 * demand filter's result) and `planned` / `plan_failed` (the travel plan) in `data`.
 * Not effect events: publishing changes no record of the order, only its stage.
 */
export const publicationEvents = pgTable("cr_publication_events", {
  seq: bigserial("seq", { mode: "number" }).primaryKey(),
  orderId: text("order_id").notNull(),
  at: timestamp("at", { withTimezone: true }).notNull(),
  by: text("by").notNull(),
  kind: text("kind").notNull(),
  text: text("text").notNull(),
  data: jsonb("data").$type<Record<string, unknown>>(),
}, (table) => [index("cr_publication_events_order_idx").on(table.orderId)])

/** Travel plans the model drafted, keyed by a hash of the plan input (plus prompt version and model). */
export const travelPlans = pgTable("cr_travel_plans", {
  key: text("key").primaryKey(),
  plan: jsonb("plan").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
})

/**
 * Support inbox events (lib/engine/inbox.ts): append-only, per thread. `linked` and
 * `unlinked` (an order the operator linked, `order_id`), `replied` (the reply the operator
 * sent, in `text`; `data.suggested` when it started as the agent's draft). The inbox
 * records themselves are never edited (ADR 0002): the events are laid over them.
 */
export const inboxEvents = pgTable("cr_inbox_events", {
  seq: bigserial("seq", { mode: "number" }).primaryKey(),
  threadId: text("thread_id").notNull(),
  orderId: text("order_id"),
  at: timestamp("at", { withTimezone: true }).notNull(),
  by: text("by").notNull(),
  kind: text("kind").notNull(),
  text: text("text").notNull(),
  data: jsonb("data").$type<Record<string, unknown>>(),
}, (table) => [index("cr_inbox_events_thread_idx").on(table.threadId)])

/** The inbox agent's suggestions (lib/engine/inbox-agent.ts), keyed by a hash of the thread, its orders' state, prompt version and model. */
export const inboxSuggestions = pgTable("cr_inbox_suggestions", {
  key: text("key").primaryKey(),
  suggestion: jsonb("suggestion").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
})

/** Every engine state table. Add new tables here so reset clears them. */
export const ENGINE_TABLES = [demoClock, briefingItems, proposalEvents, effectEvents, callEvents, publicationEvents, inboxEvents]

/**
 * Caches that reset keeps on purpose (ticket 04). A cached review is keyed by the
 * prompt version, the model and the whole case file (records, `now`, rules, prior
 * state), so after reset a hit is exactly the review a fresh run would produce, and
 * a repeated demo take costs no model calls. Put agent *state* (which review is
 * current, proposals, calls) in ENGINE_TABLES, not here.
 */
export const CACHE_TABLES = [reviewResults, digestProse, travelPlans, inboxSuggestions]

/**
 * Mistakes (spec .scratch/self-improving-agents, lib/engine/mistakes.ts): an operator's
 * override of an agent (a dismissal with a reason, an edited script) or a validator's
 * rejection. Appended once per id; only the restatement fields are written later, once.
 */
export const mistakes = pgTable("cr_mistakes", {
  seq: bigserial("seq", { mode: "number" }).primaryKey(),
  id: text("id").notNull().unique(),
  agent: text("agent").notNull(),
  orderId: text("order_id"),
  at: timestamp("at", { withTimezone: true }).notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
  operator: text("operator"),
  promptVersion: text("prompt_version").notNull(),
  model: text("model"),
  kind: text("kind").notNull(),
  tags: jsonb("tags").$type<string[]>().notNull(),
  input: jsonb("input").$type<unknown>(),
  agentOutput: jsonb("agent_output").$type<unknown>(),
  operatorNote: text("operator_note"),
  editDiff: jsonb("edit_diff").$type<{ before: string; after: string }>(),
  validatorReason: text("validator_reason"),
  restatement: text("restatement"),
  status: text("status").notNull(),
  unusableReason: text("unusable_reason"),
  caseFile: jsonb("case_file").$type<Record<string, unknown>>(),
  /** The agent run behind what was overridden and the reviewer finding (spec .scratch/traceability); null for rows from before. */
  runId: text("run_id"),
  findingId: text("finding_id"),
}, (table) => [index("cr_mistakes_agent_idx").on(table.agent)])

/**
 * Lessons (spec .scratch/self-improving-agents, lib/engine/lessons.ts): one row per
 * candidate the distiller wrote, never updated. `text` is the only part a prompt gets;
 * `applies_to` holds rule ids (reviewer) or card kinds (plain-words), empty for every call.
 */
export const lessons = pgTable("cr_lessons", {
  id: text("id").primaryKey(),
  agent: text("agent").notNull(),
  text: text("text").notNull(),
  explanation: text("explanation").notNull(),
  appliesTo: jsonb("applies_to").$type<string[]>().notNull(),
  sourceMistakeIds: jsonb("source_mistake_ids").$type<string[]>().notNull(),
  evalBefore: doublePrecision("eval_before"),
  evalAfter: doublePrecision("eval_after"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  by: text("by").notNull(),
})

/** The operator's decisions on lessons, append-only: approved, rejected, retired. A lesson's status is folded from these. */
export const lessonEvents = pgTable("cr_lesson_events", {
  seq: bigserial("seq", { mode: "number" }).primaryKey(),
  lessonId: text("lesson_id").notNull(),
  at: timestamp("at", { withTimezone: true }).notNull(),
  by: text("by").notNull(),
  kind: text("kind").notNull(),
  text: text("text").notNull(),
}, (table) => [index("cr_lesson_events_lesson_idx").on(table.lessonId)])

/**
 * Lessons runs (lib/engine/learning.ts): one row per distil, written when it starts and
 * finished once. Its cost is what the daily spend cap sums; its start what the cooldown
 * and "new since the last candidate" count from.
 */
export const distilRuns = pgTable("cr_distil_runs", {
  seq: bigserial("seq", { mode: "number" }).primaryKey(),
  id: text("id").notNull().unique(),
  groupKey: text("group_key").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  outcome: text("outcome").notNull(),
  lessonId: text("lesson_id"),
  mistakeIds: jsonb("mistake_ids").$type<string[]>().notNull(),
  cost: doublePrecision("cost").notNull(),
  detail: text("detail").notNull(),
  /** The gate's trace, kept for inspection in the database; null when the gate did not run. */
  gate: jsonb("gate").$type<GateTrace>(),
  /** The distiller's agent run (cr_agent_runs); the gate's reviews and judges are its children. Null for restate rows and before tracing. */
  agentRunId: text("agent_run_id"),
}, (table) => [index("cr_distil_runs_started_idx").on(table.startedAt)])

/**
 * What the agents learn from (mistakes) and what they learned (lessons). Reset keeps these on purpose: learning is
 * neither demo state nor a content cache, and a new demo take should not wipe it.
 */
export const LEARNING_TABLES = [mistakes, lessons, lessonEvents, distilRuns]

/**
 * Agent runs (spec .scratch/traceability, lib/reviewer/trace.ts): one row per run of any
 * agent, written when it starts and finished once. A call made outside a run gets a
 * one-turn run of its own. `prompt_hash` names the exact system prompt in cr_prompt_texts;
 * `lesson_ids` the lessons in it. Real time. Prompts hold customer contact data: engineers only.
 */
export const agentRuns = pgTable("cr_agent_runs", {
  seq: bigserial("seq", { mode: "number" }).primaryKey(),
  id: text("id").notNull().unique(),
  job: text("job").notNull(),
  subject: text("subject").notNull(),
  parentRunId: text("parent_run_id"),
  promptVersion: text("prompt_version"),
  promptHash: text("prompt_hash"),
  model: text("model").notNull(),
  lessonIds: jsonb("lesson_ids").$type<string[]>().notNull(),
  inputHash: text("input_hash"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  outcome: text("outcome").notNull(),
  usage: jsonb("usage").$type<Usage>(),
  cost: doublePrecision("cost"),
}, (table) => [
  index("cr_agent_runs_subject_idx").on(table.subject),
  index("cr_agent_runs_parent_idx").on(table.parentRunId),
  index("cr_agent_runs_started_idx").on(table.startedAt),
])

/** One row per model turn, under its run: the request as the agent sent it (system prompt by hash), the reply or the error. */
export const modelCalls = pgTable("cr_model_calls", {
  runId: text("run_id").notNull(),
  turn: integer("turn").notNull(),
  at: timestamp("at", { withTimezone: true }).notNull(),
  latencyMs: integer("latency_ms").notNull(),
  request: jsonb("request").$type<LoggedRequest>().notNull(),
  response: jsonb("response").$type<LoggedResponse>(),
  usage: jsonb("usage").$type<Usage>(),
  error: text("error"),
}, (table) => [primaryKey({ columns: [table.runId, table.turn] })])

/** Exact system prompts as sent (lessons rendered in), stored once by sha256. */
export const promptTexts = pgTable("cr_prompt_texts", {
  hash: text("hash").primaryKey(),
  text: text("text").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
})

/** What every agent run read and said. Reset keeps these: a trace outlives the demo take it came from. */
export const TRACE_TABLES = [agentRuns, modelCalls, promptTexts]
