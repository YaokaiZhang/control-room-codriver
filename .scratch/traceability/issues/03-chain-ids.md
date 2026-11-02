# 03: Proposals and mistakes name their run and finding

**Status:** ready-for-agent
**Blocked by:** 01

**What to build:** proposal events (the `proposed` event and operator decisions) and
mistakes record `runId` and `findingId` when they come from a review. Gap 5's data.

- [ ] Proposal events carry `runId` / `findingId` in `data`
- [ ] `cr_mistakes` gains `run_id`, `finding_id` (nullable)
- [ ] Test: from an effect, walk effect → proposal → finding → run → lessons → source mistakes
