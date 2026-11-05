# Self-improving agents: learning from operator corrections

Status: ready-for-agent

## Problem

The agents (reviewer, plain-words, later the inbox agent) repeat the same mistakes. The
operator corrects them one order at a time (dismiss, edit, instruct) and that correction
is lost for every other order. Validator rejections are thrown away too.

## Solution

A feedback loop. Nothing changes model weights; the agents learn through approved
**lessons** injected into their prompts.

1. **Capture.** Every operator override (dismiss with a reason, edit of a script) and
   every validator rejection becomes a **mistake**: agent, order, day, prompt version,
   tags, what the agent said, and what was wrong.
2. **Restate.** A free-text operator reason never reaches the lesson writer. A small
   isolated model call (Haiku, no reasoning, no tools) restates it as a neutral
   correction; code validates the restatement (no instruction-shaped words, no URLs or
   record ids, every number and name must appear in the note or the order's records).
   A failed restatement keeps the mistake but marks it unusable for lessons.
3. **Distil.** Triggered by mistake count (not a schedule): when a group (agent + tags)
   has >= 3 usable mistakes on >= 2 orders across >= 2 days, and >= 2 new ones since its
   last candidate (>= 3 after a rejection), a distil runs in the background. One run at
   a time, each group at most once per hour, a daily spend cap (env, default $2).
   The distiller is **Opus 5.5 with medium thinking** (own setting, env override). It sees
   only restatements, agent output and edit diffs, as quoted JSON marked as data. It
   returns a lesson (one or two plain sentences, <= ~300 chars: the only part injected
   into prompts), an explanation for the operator, the tags it applies to, and the
   mistake ids it is based on. Code verifies the ids exist, belong to the group and meet
   the thresholds, and runs the readability and instruction-word checks. Code then puts
   the group's contact in front, like "Only for questions to the paying customer:".
4. **Gate.** Two questions, each answered twice without and twice with the candidate
   (Haiku, the agents' own model):
   - *No harm*: the spec's reviewer eval cases. A candidate that loses more than one
     check over the runs is dropped (one is noise: a real run lost one of 38 by chance).
   - *Fixes its mistakes*: one **learned case** per source mistake with a case file: the
     reviewer reviews that kept case file again, and a **judge** (Haiku, no reasoning, no
     tools) reads the correction (the restatement, the edit, or the validator's reason),
     what the agent said then, and the new review's findings, and answers whether the
     new review repeats the mistake: `repeats`, `fixed` or `unclear`, with one sentence.
     It does not know whether the lesson was in the prompt. Only `fixed` counts.
   A candidate is kept only when it does no harm and more of its learned cases are fixed
   with it than without. Without any learned case it is dropped (nothing shows it helps).
   Every run's trace (scores, each verdict and its reason, cost) is stored with the
   distil run, for engineers; none of it reaches the operator.
5. **Operator approves.** A Briefing item ("A new lesson needs your yes") links to a
   Lessons page (/lessons; it replaced the Rules page, whose fixed rules are no longer listed): the lesson, the explanation, each source mistake
   with the operator's original note and order link. No eval scores or verdicts: the
   gate decided those. Approve, reject, retire; each an event with time and actor.
6. **Inject what applies.** Approved lessons are tagged (e.g. failing rule ids for the
   reviewer, card kind for plain-words); a call gets only matching lessons. Hard cap of
   10 approved lessons per agent. The cache keys include a hash of the injected lessons.

## Decisions

- Mistakes and lessons survive a demo reset (learning is not wiped); they are neither
  engine state nor content caches.
- Lessons never edit or delete existing eval cases; they may only add learned cases.
- Every model output in the loop is checked by code before it is used. The judge's
  reply is parsed strictly; anything else counts as `unclear`.
- The judge is itself tested: hand-written corrections with known verdicts, replayed
  offline from recorded replies (`npm run lessons:judge-eval`).
- Engineers see the whole loop on `/dev/learning` (mistakes, restatements, distil runs,
  gate traces, lessons and their events). It is not linked from the operator's UI and is
  off in production unless `DEV_PAGES=1`.
- A lesson names its group's contact first, written by code. The reviewer picks whom to
  ask inside one call, so the prompt cannot hold a lesson back for one contact type; only
  the lesson's words can. Without them, a lesson about the paying customer reached
  questions to sites too. The scope counts toward the 300 characters.
- No per-operator identity exists yet (one "operator" persona): thresholds count
  distinct orders and days; an `operator` column is kept for when logins exist.

## Out of scope

Fine-tuning, automatic promotion without the operator, lessons for the call agent.
Distilling lessons for plain-words and the inbox agent: plain-words rejections are
recorded as mistakes and approved plain-words lessons are injected, but only reviewer
groups are distilled and gated.
