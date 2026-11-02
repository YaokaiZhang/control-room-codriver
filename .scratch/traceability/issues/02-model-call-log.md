# 02: Every model call is logged

**Status:** done
**Blocked by:** 01

**What to build:** a wrapper around `ModelGateway` that writes each turn to
`cr_model_calls` under its run, and opens a one-turn run for calls with no run. Wire it
where the gateway is made (lib/engine/server.ts, `anthropicFromEnv`). Distil and judge
open explicit runs; judge runs set `parent_run_id` to their distil run. Gap 2.

- [x] Wrapper: request, reply, usage, latency, error per turn; no keys
- [x] Calls without a run get their own run from `job` / `subject`
- [x] Distil and judge runs, judge under distil; distil run row (`cr_distil_runs`) names its agent run
- [x] Test: a reviewer with tool calls logs every turn in order under one run

## Comments

- Built as `createTracedGateway(inner, store)` in `lib/reviewer/trace.ts` (memory store there,
  Postgres in `lib/reviewer/postgres-trace.ts`). Agents open runs with `startRun(gateway, ...)`;
  on an untraced gateway the run has id null and records nothing. A run opened through a run's
  gateway is its child, which is how the gate's judges and reviews land under the distil run.
- Writes run off the call's path, in order per run; `finish` waits for the run's writes and
  scripts call `flush()` before closing the database.
- Wired in `lib/engine/server.ts` (one traced gateway for every agent) and in the scripts that
  write to the app's database: `review-sweep`, `lessons`, `review`. The eval scripts stay untraced.
- Explicit runs: reviewer, distil, judge. Everything else (restate, inbox, plain words, call
  checks and callee, travel, digest prose) gets one-turn runs from `job` / `subject`.
- Needs `npx drizzle-kit push`: three new tables and `cr_distil_runs.agent_run_id`.
- Storage: a turn that carries on from the run's previous turn (its messages are that turn's
  messages, then its reply, then more) stores only the new messages, with
  `request.messagesFrom` = the index they start at; tools equal to an earlier turn's are left
  out, with `request.toolsAsTurn` = the turn whose row has them. `rebuildRequest(calls, turn)`
  in trace.ts gives a turn's full request. Rows from before hold the whole request and read
  as they are. No schema change.
