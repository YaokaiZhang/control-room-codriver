# Car Delivery Control Room

A control room where people and agents work together to get cars delivered, built for Bahn's challenge at the Prompt Operations Hackathon (24–25 Oct 2026). The product plan is in [`docs/PRD.md`](docs/PRD.md).

All data is fictional. Nothing real is connected.

## Product

Operators see which car-delivery orders need a person, and why, from the evidence. Agents
do the cheap work and bring only the decisions that need a person, each with a next step
ready to approve. The words used on screen are fixed in [`GLOSSARY.md`](GLOSSARY.md).

- **Orders board**: every order sits in one of four groups (Needs action, In progress,
  Normal, Finished), with urgent Blocked orders counted on top. "Normal" means checked,
  not ignored.
- **Order page**: rule results, the reviewer's findings and situation cards. Every claim
  links to the record it came from. Proposals (questions to ask, changes to make) wait
  for the operator to approve, edit or dismiss them.
- **Approval policy**: contact type × action type decides whether the agent acts alone,
  needs a yes, or may only propose. The customer side is always propose-only
  ([ADR 0001](docs/adr/0001-customer-side-is-propose-only.md)).
- **Calls**: the agent rings sites and drivers on a mock phone. Tier 1 is keypad answers;
  tier 2 is a voice conversation, with a checker that compares every reply to the records
  and the policy. Teammates play the **Site** and **Driver** on `/phone`; any other call
  is answered by a simulated person.
- **Briefing**: digests at 09:00, 12:00 and 16:00 on the demo clock, plus an urgent push
  when an order turns urgent. The model writes the prose; every number comes from the
  engine.
- **Inbox**: support threads with a suggested reply and suggested steps on linked orders.
  The operator sends; the agent changes nothing itself.
- **Publishing and travel plans**: the agent publishes checked Normal orders
  ([ADR 0003](docs/adr/0003-agent-publishes-checked-normal-orders.md)). Fixed orders wait
  for the operator's yes. A demanding job gets a travel plan within its budget; it is a
  recommendation, and nothing is booked.
- **Lessons (self-improving agents)**: when the operator corrects the same kind of mistake
  at least 3 times, on at least 2 orders and over at least 2 days, the agents propose a lesson. It is
  tested against past orders first, and only lessons the operator approves on `/lessons`
  reach the agents' instructions.
- **Demo clock and personas**: time starts at the snapshot (21 Oct 2026 09:00 UTC) and is
  shown in the desk's zone. The operator can advance the clock, jump to the next due item,
  or reset. You log in as Operator, Site or Driver at `/login`.

## How it works

- **Stack**: Next.js 16, TypeScript, Postgres through Drizzle, and a local S3-style store
  for attachments.
- **Engine** (`starter/lib/engine`): the one seam the UI and API use (`state(now)` and
  `apply(command)`). The snapshot is never edited
  ([ADR 0002](docs/adr/0002-snapshot-is-never-edited.md)). Every change is an append-only
  effect event in our own `cr_` tables, laid over the order's records. Reading state at
  any time gives the same answer as moving the clock there.
- **Three layers of checking**: deterministic rules (`rules.ts`), then the reviewer agent
  (`lib/reviewer`), then the operator. The reviewer gets a fresh context per order and
  read-only tools. Its evidence is validated (one repair, then the finding is dropped), and
  results are cached by a hash of the case file. The seed loads 100 committed reviews, so
  a fresh install calls no model.
- **Model gateway**: every model call goes through one port that reports its cost. It has an
  Anthropic adapter and a scripted adapter that replays recorded replies in tests. Voice
  uses Azure AI Speech, and optionally an OpenRouter audio model for tier 2.
- **Guarded model text**: digest prose and plain-words rewrites may only use numbers that
  are in their input, and placeholders are filled by the server. Rejected text falls back
  to the template.
- **Lesson loop**: operator edits and dismissals with a reason are recorded as mistakes.
  They are grouped by agent, failing rule and contact type, and a group that qualifies is
  distilled into a lesson. A gate then scores the reviewer with and without the lesson, on
  the spec's eval cases and on learned cases marked by a judge model. A candidate needs no
  harm on the eval and a gain on the learned cases. Approved lessons are capped per agent,
  and only the cache entries they could change are invalidated.
- **Traceability**: agent runs, model calls, prompts and each lesson gate's trace are
  stored in Postgres (`cr_agent_runs`, `cr_distil_runs`) for inspection.

## Layout

- `dataset/data/`: the fictional snapshot (100 orders), as JSONL. `dataset/SCHEMA.md` explains every field.
- `attachments/`: fictional documents, receipts and photos, with `manifest.json`.
- `starter/`: the Next.js, TypeScript and Postgres app.

## Run

You need Node.js 24+ and Docker.

```sh
cd starter
cp .env.example .env
npm ci
docker compose up -d --wait
npm run db:push
npm run db:seed
npm run attachments:seed
npm run dev
```

Open http://localhost:3000.

The seed loads the committed reviews in `starter/data/review-snapshot.json`, so all 100 orders
start reviewed without calling the model. A stored review only matches while the order's records,
the reviewer's prompt and model, and the approved lessons for that order are unchanged; orders that
no longer match read "Not reviewed yet". With `ANTHROPIC_API_KEY` set, review those with
`npm run review:sweep` (or a few: `npm run review:sweep -- CD-420516 CD-420437`).

After changing the reviewer's prompt or model, refresh the snapshot from a freshly seeded database
with no approved lessons: `npm run review:sweep && npm run review:snapshot`, then commit the file.

For a live demo, run `starter/scripts/start.sh --demo`. It does everything above, then reviews
the demo orders (only the ones not reviewed yet call the model) and resets the demo clock to 09:00.
Run it again just before the demo starts. The Site and Driver teammates should open the phone page
only when the demo reaches their call: a call rings out 30 s after the page opens.
