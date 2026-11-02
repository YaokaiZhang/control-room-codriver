# 04: The order trace page

**Status:** ready-for-agent
**Blocked by:** 02, 03

**What to build:** `/dev/trace/[orderId]` and `/dev/trace/run/[runId]`, plain pages like
`/dev/learning`. Gap 5.

- [ ] One timeline per order: runs, findings, proposal events, effects, calls, mistakes, each linked to its parent
- [ ] Run page: metadata, lessons (linked to /dev/learning), prompt text, every model call
- [ ] Links both ways with /dev/learning; "not traced" for old rows
