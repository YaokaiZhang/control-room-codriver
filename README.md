# Car Delivery Control Room

A control room where people and agents work together to get cars delivered, built for Bahn's challenge at the Prompt Operations Hackathon (24–25 Oct 2026). The product plan is in [`docs/PRD.md`](docs/PRD.md).

All data is fictional. Nothing real is connected.

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
