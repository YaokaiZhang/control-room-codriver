# 04: The order trace page

**Status:** done
**Blocked by:** 02, 03

**What to build:** `/dev/trace/[orderId]` and `/dev/trace/run/[runId]`, plain pages like
`/dev/learning`. Gap 5.

- [x] One timeline per order: runs, findings, proposal events, effects, calls, mistakes, each linked to its parent
- [x] Run page: metadata, lessons (linked to /dev/learning), prompt text, every model call
- [x] Links both ways with /dev/learning; "not traced" for old rows

## Comments

- Data in `starter/lib/engine/trace-view.ts` (`orderTrace`, `runTrace`, `findOrder`), tested in
  `trace-view.test.ts` (memory and Postgres). The pages (`app/dev/trace/[orderId]/page.tsx`,
  `app/dev/trace/run/[runId]/page.tsx`, shared bits in `app/dev/trace/parts.tsx`) only render it.
  Same guard as /dev/learning: off in production unless `DEV_PAGES=1`. `getTraceStore()` added
  to lib/engine/server.ts (the gateway uses the same one).
- The order page takes the order id or reference. Runs on it: the runs whose subject is the
  order's reference (reviewer, call-opener, call-check, call-callee, travel-plan), restate runs
  of its mistakes (subject = mistake id), and any run a proposal event or mistake names.
  Inbox suggestions (subject = thread id) and plain-words cards are not shown.
- Two clocks: order events carry the demo clock, runs real time. A run is placed at the
  latest demo time known to have passed by its start (from call steps and operator
  mistakes, which carry both; else the snapshot time). At the same demo time rows go by
  real time; a row with none takes its parent's (a proposal event its run's, an effect its
  proposal's or call's). Each line shows its own time and clock.
- Findings: only the current review's. A proposal event or mistake naming a finding from an
  earlier review says so instead of linking. A finding's `proposed` line comes from the draft
  on its first stored event (else the proposal shown now), so it names the run it was drafted from.
- Links to /dev/learning use its row anchors (`#<lesson id>`, `#<mistake id>`). The learning
  page links back via `/dev/trace/run/<runId>` and `/dev/trace/<orderId>` (issue 05).
- Call-check runs link to the call whose real-time window holds their start.
