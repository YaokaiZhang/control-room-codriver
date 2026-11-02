# 05: What happened after a lesson was approved

**Status:** done
**Blocked by:** 02, 03

**What to build:** on /dev/learning, per lesson, worked out from runs and mistakes (no
new table): the runs it was injected into; mistakes in its group per 100 reviews before
and after approval; mistakes whose run already had the lesson. Gap 4.

- [x] Pure function computing the numbers, with tests
- [x] Shown on the lesson's row, linking to the runs

## Comments

- `lessonImpacts({ lessons, distilRuns, reviewerRuns, mistakes })` in lib/engine/lesson-impact.ts,
  tests in lesson-impact.test.ts. Per lesson: `groups`, `injected` (count, run ids newest
  first), `before` / `after` windows (`runs`, `mistakes`, `per100`, null with no reviews;
  `after` null when never approved, ending at retirement when retired), `despite` (mistake ids).
- Reviews counted: reviewer runs at the top level (the gate's reviews sit under a distil run),
  finished and not failed. Cached reviews make no run.
- A lesson's group is its distil run's group (`cr_distil_runs.lesson_id`); a lesson seeded by
  hand takes its source mistakes' groups (`groupKeys`). Mistakes are grouped with
  `groupMistakes` (usable reviewer mistakes only), as the distiller groups them.
- A mistake happened when its review started (`runId`), else when it was recorded (real time,
  like approvals and runs; `at` is the demo clock). Untraced mistakes count in the rates,
  never in `despite`.
- /dev/learning reads `readRuns({ job: "reviewer", parentRunId: null })` once (new
  `getTraceStore()` in lib/engine/server.ts); without the trace tables the column says
  "not traced". Lesson rows already had `id={lesson.id}`. Mistake rows link their run to
  `/dev/trace/run/<runId>` and their order to `/dev/trace/<orderId>` (issue 04's pages).
