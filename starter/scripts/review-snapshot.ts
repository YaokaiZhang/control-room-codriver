// Writes data/review-snapshot.json from a database's cr_review_results, for `npm run
// db:seed` to load (lib/engine/review-snapshot.ts). Sweep the database first:
//
//   npm run review:sweep && npm run review:snapshot
//
// Use a freshly seeded database with no approved lessons, so the keys match a fresh seed.

import "dotenv/config"
import { writeFile } from "node:fs/promises"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { exportReviewSnapshot, REVIEW_SNAPSHOT_PATH } from "../lib/engine/review-snapshot"

const url = process.env.DATABASE_URL
if (!url) throw new Error("Set DATABASE_URL before exporting. See .env.example.")
const client = postgres(url, { max: 1 })
exportReviewSnapshot(drizzle(client)).then(async (snapshot) => {
  await writeFile(REVIEW_SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 1)}\n`)
  console.log(`Wrote ${snapshot.rows.length} reviews to ${REVIEW_SNAPSHOT_PATH}.`)
}).finally(() => client.end())
