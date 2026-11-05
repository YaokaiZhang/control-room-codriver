# 05: Judge-based gate and the engineers' trace page

**What to build:** replace the two learned-case types (not-raised, same-contact) with one
learned case scored by a judge model (spec step 4): the gate keeps a lesson only when it
does no harm on the spec's cases (at most one check lost over the runs) and fixes more of
its learned cases than the prompt without it. Store each gate's trace with its distil run.
Add `/dev/learning`, a plain page for engineers that shows mistakes, restatements, distil
runs with their gate traces, and lessons with their events.

**Why:** the first real run (ticket 03) dropped a sound lesson because a dismissal meant
"right conflict, wrong person to ask", which the not-raised case cannot express. The
operator's correction, read by a judge, says what was wrong for any kind of mistake.

**Blocked by:** 03

**Status:** done; one real gate run on the test DB (27 Oct)

- [x] Judge call, strict parsing (`unclear` on anything else), blind to the lesson
- [x] Gate rule: no harm with a one-check tolerance, and more fixed with than without
- [x] Gate trace stored with the distil run; no scores on the operator's Lessons card
- [x] Judge eval: hand-written cases, recorded once, replayed in tests
- [x] `/dev/learning`, off in production unless `DEV_PAGES=1`
- [x] One real gate run on the test DB

## Real runs (27 Oct, test DB)

- Judge eval: 8/8 on three runs, under $0.001 each. One case (the review drops a conflict
  the correction wanted asked of someone else) came back "fixed" at first; the prompt now
  says so explicitly, and "repeats" or "unclear" are both right there (only "fixed" counts).
- Gate on the ticket 03 group, $0.15: dropped. Spec checks 38/38 -> 35/38, fixed 0/6 ->
  0/6. The trace shows why: the Munich site has no contact on record, so the reviewer
  still asks the customer with the lesson, and the judge says "repeats" every time.
- Open: one run with the lesson lost a whole spec case (CD-420656, no finding): 3 checks
  at once. The tolerance counts checks, so a lost case is more than noise allows. Watch
  whether real noise loses whole cases; if so, count the tolerance in cases.

## Second real run (27 Oct, fresh test DB `controlroom_learn2_test`)

- Group `reviewer/rule:none/contact:paying_customer`: three edits on three orders over 21
  and 22 Oct; each kept the question and added "Please reply by <time> today so we can
  brief the driver" (or plan the route).
- First gate, $0.19: dropped, fixed 0/6 -> 0/6. The reviewer did add the deadlines, but the
  judge read each edit as a wrong-person mistake. Fixed: an edit's correction now says the
  contact and conflict were right and names only the words removed and added; the prompt
  says an edit is judged by the kind of change (a time may differ) and never by whom it
  asks. A review with no findings now gets a narrower question (did the conflict still
  need raising?) and code makes the verdict: the full prompt flipped on it between runs.
  Judge eval 10/10 on three runs, two cases taken from this run.
- Second gate, $0.19: candidate. Spec checks 37/38 -> 36/38 (CD-420437 "records" fails on
  both sides: noise), fixed 0/6 -> 2/6. One "repeats" reason contradicts itself (says the
  deadline is the change, then that it is missing): the judge still errs strict.
- Briefing showed "A new lesson needs your yes" with the lesson text, no scores; the Rules
  card had Approve/Reject. Approved in the UI: "In the prompt".
- Re-review of three orders with the lesson injected ($0.02): every new question ends
  with a reply-by time and why. It also reached questions to sites and customer-given
  contacts, though the lesson names the paying customer: `appliesTo` was every call.
- Fixed after: code now puts the group's contact in front of every lesson ("Only for
  questions to the paying customer: ..."); the distiller writes the rest in at most 240
  characters. One real distiller call ($0.02) gave a 251-character scoped lesson.
- Open: the 1-check tolerance from the first run still stands.

## Prepared demo DB (5 Nov, local `controlroom_lesson_demo`)

- `npm run demo:lesson` on a fresh seed: edits on CD-420154, CD-420322 (21 Oct) and
  CD-420437 (22 Oct), each adding "Please reply by 15:00 today so we can brief the driver".
- Gate, $0.19: candidate. Spec checks 38/38 -> 38/38, fixed 3/6 -> 5/6.
- Clock reset after: the Briefing shows "A new lesson needs your yes" and the Lessons page
  the candidate with its three source mistakes.
