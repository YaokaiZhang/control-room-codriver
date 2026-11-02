import "dotenv/config"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import * as schema from "../lib/schema"
import { readDataset } from "../lib/snapshot/files"
import { tablesFromSource } from "../lib/snapshot/tables"
import { loadReviewSnapshot, readReviewSnapshot } from "../lib/engine/review-snapshot"
import { sweep } from "./review-sweep"

// The packet ships its records in ../dataset/data. Set DATASET_DIR to seed another folder with the same files.
const url = process.env.DATABASE_URL
if (!url) throw new Error("Set DATABASE_URL before seeding. See .env.example.")

const client = postgres(url, { max: 1 })
const db = drizzle(client, { schema })

async function insertBatches<T extends Record<string, unknown>>(
  rows: T[],
  insert: (batch: T[]) => Promise<unknown>,
): Promise<void> {
  for (let start = 0; start < rows.length; start += 300) await insert(rows.slice(start, start + 300))
}

async function seed(): Promise<void> {
  const { manifest, source } = await readDataset()
  const tables = tablesFromSource(manifest, source)

  // A failed insert rolls back the whole replacement, so the app never serves a partial seed.
  // The control room's own tables (cr_*) are left alone: they hold no foreign keys into these (ADR 0002).
  await db.transaction(async (tx) => {
    await tx.execute(sql`TRUNCATE dataset_metadata, customers, sites, addresses, vehicles, drivers, orders, order_items, conversations, messages, alerts, operational_events, related_records`)
    await tx.insert(schema.datasetMetadata).values(tables.metadata)
    await insertBatches(tables.customers, async (batch) => { await tx.insert(schema.customers).values(batch) })
    await insertBatches(tables.sites, async (batch) => { await tx.insert(schema.sites).values(batch) })
    await insertBatches(tables.addresses, async (batch) => { await tx.insert(schema.addresses).values(batch) })
    await insertBatches(tables.vehicles, async (batch) => { await tx.insert(schema.vehicles).values(batch) })
    await insertBatches(tables.drivers, async (batch) => { await tx.insert(schema.drivers).values(batch) })
    await insertBatches(tables.orders, async (batch) => { await tx.insert(schema.orders).values(batch) })
    await insertBatches(tables.orderItems, async (batch) => { await tx.insert(schema.orderItems).values(batch) })
    await insertBatches(tables.conversations, async (batch) => { await tx.insert(schema.conversations).values(batch) })
    await insertBatches(tables.messages, async (batch) => { await tx.insert(schema.messages).values(batch) })
    await insertBatches(tables.alerts, async (batch) => { await tx.insert(schema.alerts).values(batch) })
    await insertBatches(tables.operationalEvents, async (batch) => { await tx.insert(schema.operationalEvents).values(batch) })
    await insertBatches(tables.relatedRecords, async (batch) => { await tx.insert(schema.relatedRecords).values(batch) })
  })
  // The committed reviews (data/review-snapshot.json): a fresh seed starts reviewed, free.
  const snapshot = readReviewSnapshot()
  if (snapshot) {
    try {
      console.log(`Loaded ${await loadReviewSnapshot(db, snapshot)} of ${snapshot.rows.length} committed reviews.`)
    } catch (error) {
      console.error(`Committed reviews not loaded (${(error as Error).message}). Run \`npm run db:push\` first.`)
    }
  }
  console.log(`Seeded ${tables.orders.length} fictional orders and ${[...source.values()].reduce((sum, part) => sum + part.length, 0)} source records.`)
}

// The one-time reviewer sweep (ticket 06): every order not reviewed yet, so "Normal" means
// checked. It calls the real model on up to 100 orders, so it is opt-in: `npm run db:seed --
// --review` (or SEED_REVIEW=1); cap with REVIEW_SWEEP_LIMIT=N. Without ANTHROPIC_API_KEY it
// only reports "not reviewed yet". A few named orders: `npm run review:sweep -- CD-420516`.
async function reviewAfterSeed(): Promise<void> {
  if (!process.argv.includes("--review") && process.env.SEED_REVIEW !== "1") {
    console.log("Reviewer sweep not run (it calls the model on every order). Opt in with `npm run db:seed -- --review`, or review a few orders with `npm run review:sweep -- CD-420516`.")
    return
  }
  const limit = process.env.REVIEW_SWEEP_LIMIT ? Number(process.env.REVIEW_SWEEP_LIMIT) : undefined
  try {
    await sweep({ url: url!, limit })
  } catch (error) {
    console.error(`Review sweep failed (${(error as Error).message}); the seed is in place. Re-run \`npm run review:sweep\`.`)
  }
}

seed().finally(async () => { await client.end() }).then(reviewAfterSeed)
