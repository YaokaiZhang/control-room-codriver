// The reviewer sweep: reviews every order not reviewed yet and stores the results in
// cr_review_results, where the app reads them. `npm run db:seed -- --review` runs it once
// after seeding (opt-in: the seed alone never calls the model); run it any time on a few
// named orders. Orders already reviewed are served from the cache and cost nothing.
//
//   npm run review:sweep                       every order not reviewed yet
//   npm run review:sweep -- --limit 5          at most 5 (records-triggered orders first)
//   npm run review:sweep -- CD-420516 CD-420437
//
// Without ANTHROPIC_API_KEY nothing is called and orders stay "not reviewed yet".
// Failing model calls fail fast: 4 in flight, and the sweep stops after 3 failures in
// a row. Restart a running app server only if it should drop its 5 s "not reviewed" memo.

import "dotenv/config"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { createEngine, type EngineState } from "../lib/engine/engine"
import { createLessonFeeds } from "../lib/engine/lessons"
import { createPostgresStore } from "../lib/engine/postgres"
import { createAnthropicGateway } from "../lib/reviewer/anthropic"
import { createPostgresReviewCache } from "../lib/reviewer/postgres-cache"
import { createPostgresTraceStore } from "../lib/reviewer/postgres-trace"
import { createTracedGateway, type TracingGateway } from "../lib/reviewer/trace"
import { reviewSourceFromDatabase } from "../lib/reviewer/source"

export type SweepOptions = {
  url: string
  /** Order references or ids; default every order. */
  orders?: string[]
  limit?: number
  log?: (line: string) => void
}

function money(value: number): string {
  return `$${value.toFixed(4)}`
}

export async function sweep(options: SweepOptions): Promise<EngineState | null> {
  const log = options.log ?? console.log
  const client = postgres(options.url, { max: 4, onnotice: () => {} })
  let traced: TracingGateway | null = null
  try {
    const db = drizzle(client)
    const cache = createPostgresReviewCache(db)
    try {
      await cache.get("probe")
    } catch (error) {
      log(`Review sweep skipped: the review cache is missing (${(error as Error).message}). Run \`npx drizzle-kit push\`.`)
      return null
    }
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim()
    // Traced like the app's (lib/reviewer/trace.ts): each review names the run that wrote it.
    const gateway = traced = apiKey ? createTracedGateway(createAnthropicGateway({ apiKey, timeoutMs: 90_000 }), createPostgresTraceStore(db)) : null
    const source = await reviewSourceFromDatabase(db)
    const store = createPostgresStore(db)
    const engine = createEngine({
      snapshot: source.snapshot,
      store,
      // The approved lessons, as the app injects them: the same keys, so the app reads what the sweep wrote.
      reviews: { gateway, cache, inboxMessages: source.inboxMessages, lessons: createLessonFeeds(store).reviewer },
    })
    const before = await engine.state()
    const wanted = options.orders?.length
      ? before.orders.filter((row) => options.orders!.some((key) => key.toUpperCase() === row.reference.toUpperCase() || key === row.id))
      : before.orders
    let pending = wanted.filter((row) => row.review.status !== "reviewed")
      .sort((a, b) => Number(b.review.trigger === "records") - Number(a.review.trigger === "records") || a.reference.localeCompare(b.reference))
    if (options.limit !== undefined) pending = pending.slice(0, Math.max(0, options.limit))
    if (!gateway) {
      log(`Review sweep: no ANTHROPIC_API_KEY, so ${before.reviews.notReviewed} orders stay "not reviewed yet" (${before.reviews.reviewed} already reviewed).`)
      return before
    }
    if (pending.length === 0) {
      log(`Review sweep: nothing to do; ${before.reviews.reviewed} orders reviewed, ${before.reviews.findings} findings, ${money(before.reviews.cost)} recorded.`)
      return before
    }
    log(`Review sweep: reviewing ${pending.length} order(s)…`)
    const started = Date.now()
    const after = await engine.apply({ type: "review", orderIds: pending.map((row) => row.id) })
    const byId = new Map(after.orders.map((row) => [row.id, row]))
    for (const row of pending) {
      const now = byId.get(row.id)!
      log(now.review.status === "reviewed"
        ? `  ${row.reference}  ${now.review.findings.length} finding(s)  ${now.review.recordsRead} records  ${money(now.review.cost)}`
        : `  ${row.reference}  ${now.review.reason}`)
    }
    const done = pending.filter((row) => byId.get(row.id)!.review.status === "reviewed").length
    log(`Review sweep: ${done}/${pending.length} reviewed in ${Math.round((Date.now() - started) / 1000)} s. `
      + `Totals: ${after.reviews.reviewed} reviewed, ${after.reviews.notReviewed} not reviewed yet, ${after.reviews.findings} findings, ${money(after.reviews.cost)} model cost.`)
    return after
  } finally {
    await traced?.flush()
    await client.end()
  }
}

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] ?? null : null
}

if (process.argv[1]?.endsWith("review-sweep.ts")) {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error("Set DATABASE_URL before sweeping. See .env.example.")
  const limit = argValue("--limit")
  const orders = process.argv.slice(2).filter((arg, i, all) => !arg.startsWith("--") && all[i - 1] !== "--limit")
  sweep({ url, orders, limit: limit ? Number(limit) : undefined }).catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
