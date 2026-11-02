# 01: Reviewer runs record their prompt and lessons

**Status:** ready-for-agent
**Blocked by:** none

**What to build:** the three trace tables, a run recorder (memory + Postgres), and the
reviewer opening one run per review. `Reviewed` gains `runId`, `promptVersion`,
`promptHash`, `lessonIds`. Gaps 1 and 3.

- [ ] `cr_agent_runs`, `cr_model_calls`, `cr_prompt_texts` in lib/engine/schema.ts; `TRACE_TABLES` kept by reset
- [ ] Run recorder with a memory and a Postgres implementation; write failures swallowed
- [ ] Reviewer opens a run (job, subject, prompt version, hash of the exact system prompt, model, lesson ids, input hash) and finishes it with outcome, usage, cost
- [ ] A cached review keeps the producing run's id; serving it writes nothing
- [ ] Test: from a review result, read back its run, its prompt text and its lessons
