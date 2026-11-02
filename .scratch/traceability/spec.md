# Traceability: every agent run, end to end

**Goal:** an engineer can follow any line on an order back to the exact prompt, model
reply and lessons behind it, and any lesson forward to every run that used it. All in
our Postgres; nothing new to run (Langfuse was considered and set aside: it covers only
the model-call log, and needs ClickHouse, Redis and S3 storage).

**Done when:** on any effect on an order, an engineer can click back through
proposal → finding → review run → the exact prompt (lessons included) and the model's
reply → those lessons → the mistakes and operator notes they came from; and from any
lesson forward to every run that used it and what those runs found.

## The gaps this closes

1. A review does not record which lessons were in its prompt (only a hash in its cache key).
2. No model-call log: `ChatRequest.job` / `subject` say "used for logs", nothing writes them.
3. The prompt version is not on the review; only inside the hashed key.
4. Nothing shows what happened after a lesson was approved.
5. No engineer page that follows review → finding → proposal → effect.

## Data

- `cr_agent_runs`: one row per agent run, every agent (reviewer, restate, distil, judge,
  inbox, plain-words, call checks, travel, digest prose). `id` ("run-" + uuid), `job`,
  `subject`, `parent_run_id` (judge runs under their distil run), `prompt_version`,
  `prompt_hash`, `model`, `lesson_ids` (jsonb, [] for none), `input_hash`, `started_at`,
  `finished_at`, `outcome` (ok / failed / free text), `usage` (jsonb Usage), `cost`.
- `cr_model_calls`: one row per model turn: `run_id`, `turn`, `at`, `latency_ms`,
  `request` (messages, tools, model, effort, maxTokens), `response` (message, finish
  reason, answering model), `usage`, `error`.
- `cr_prompt_texts`: `hash` → `text`. The exact system prompt as sent (lessons rendered
  in), stored once. `prompt_hash` on a run names it.
- Reset keeps all three (`TRACE_TABLES`, like `LEARNING_TABLES`). Rows from before this
  feature read "not traced"; no backfill.

## Rules

- Tracing never breaks an agent: a failed trace write is logged and swallowed.
- Reads never write runs. A cached review points at the run that produced it
  (`Reviewed.runId`); serving it from the cache writes nothing.
- Every model call is traced. Calls made inside an explicit run attach to it; a call
  with no run gets a one-turn run of its own from `job` and `subject`, so agents not yet
  updated are still covered.
- Prompts hold customer contact data: they stay in our DB and appear only on `/dev` pages.
- Never store keys. The gateway adds auth outside the request we log.

## The chain

- `Reviewed` gains `runId`, `promptVersion`, `promptHash`, `lessonIds`.
- Proposal events and mistakes record `runId` and `findingId` where they come from a run.
- Effects already point at their proposal or call (`source`).
- Lessons → runs: `cr_agent_runs.lesson_ids`.

## Pages

- `/dev/trace/[orderId]`: one timeline of runs, findings, proposal events, effects,
  calls and mistakes; each line links to its parent; each run opens its model calls and
  prompt text. Linked both ways with `/dev/learning`.
- `/dev/learning`, per lesson: reviews it was injected into; mistakes in its group per
  100 reviews before and after approval; mistakes from runs that already had it.

## Out of scope

Langfuse or any external tracing service; backfilling old rows; operator-facing UI
(the operator UI stays quiet; this is for engineers).
