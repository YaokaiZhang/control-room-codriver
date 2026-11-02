# 03: Proposals and mistakes name their run and finding

**Status:** done
**Blocked by:** 01

**What to build:** proposal events (the `proposed` event and operator decisions) and
mistakes record `runId` and `findingId` when they come from a review. Gap 5's data.

- [x] Proposal events carry `runId` / `findingId` in `data`
- [x] `cr_mistakes` gains `run_id`, `finding_id` (nullable)
- [x] Test: from an effect, walk effect → proposal → finding → run → lessons → source mistakes

## Comments

- `OrderReview.runId` (lib/engine/reviews.ts): the run of the review it shows; null when not
  reviewed, untraced, or cached before tracing.
- A finding's proposal draft carries `runId` (`draftFromFinding(..., runId)`, from the review).
  Every stored event on a finding's proposal (approved, edited, dismissed, instructed, answered,
  including the agent's call-result answers) has `data.runId` / `data.findingId`. A finding's
  proposal has no stored `proposed` event: its first stored event keeps the draft, which now
  carries `runId` and `findingId` too. When a later review raises the same finding, the proposal
  shown (and acted on) is that review's draft, so its events name that review's run.
- Change proposals and rule-made (`nx-`) proposals have no finding: no ids; a change made from
  an answer is followed through its `source` (the finding's proposal).
- `Mistake.runId` / `findingId` (`cr_mistakes.run_id`, `finding_id`, nullable): filled for
  reviewer proposals; plain-words rejections keep null (their one-turn runs' ids are not handed
  back by the gateway).
- Test: lib/engine/trace-chain.test.ts (memory and Postgres).
- Needs `npx drizzle-kit push` for the two new `cr_mistakes` columns.
