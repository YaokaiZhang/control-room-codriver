# 02: Every model call is logged

**Status:** ready-for-agent
**Blocked by:** 01

**What to build:** a wrapper around `ModelGateway` that writes each turn to
`cr_model_calls` under its run, and opens a one-turn run for calls with no run. Wire it
where the gateway is made (lib/engine/server.ts, `anthropicFromEnv`). Distil and judge
open explicit runs; judge runs set `parent_run_id` to their distil run. Gap 2.

- [ ] Wrapper: request, reply, usage, latency, error per turn; no keys
- [ ] Calls without a run get their own run from `job` / `subject`
- [ ] Distil and judge runs, judge under distil; distil run row (`cr_distil_runs`) names its agent run
- [ ] Test: a reviewer with tool calls logs every turn in order under one run
