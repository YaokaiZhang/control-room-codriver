// Lessons by hand (spec .scratch/self-improving-agents, ticket 03): restates mistakes
// left pending, then distils and gates every group that qualifies, as a recorded mistake
// does in the app (thresholds, cooldown, daily spend cap). A passing candidate goes to
// the operator on the Rules page.
//
//   npm run lessons            needs ANTHROPIC_API_KEY and DATABASE_URL
//   npm run lessons -- --dry   distil and check only: no restatements, no eval, nothing stored
//
// LESSONS_MODEL overrides the distiller, REVIEWER_MODEL the agents' model (gate),
// LESSONS_DAILY_USD the cap (default 2). Behind an HTTPS proxy, set NODE_USE_ENV_PROXY=1.

import "dotenv/config"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { createLearning } from "../lib/engine/learning"
import { createPostgresStore } from "../lib/engine/postgres"
import { anthropicFromEnv } from "../lib/reviewer/anthropic"
import { createPostgresTraceStore } from "../lib/reviewer/postgres-trace"
import { createTracedGateway, type TracingGateway } from "../lib/reviewer/trace"
import { money } from "../lib/reviewer/report"
import { reviewSourceFromDatabase } from "../lib/reviewer/source"

async function main(): Promise<void> {
  const dry = process.argv.includes("--dry")
  const url = process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL is required. See starter/README.md.")
  const model = anthropicFromEnv()
  if (!model) {
    console.error("ANTHROPIC_API_KEY is not set: lessons need the model. Nothing was run.")
    process.exit(2)
  }
  const client = postgres(url, { max: 2, onnotice: () => {} })
  let traced: TracingGateway | null = null
  try {
    const db = drizzle(client)
    const store = createPostgresStore(db)
    // Traced like the app's (lib/reviewer/trace.ts): the distil, its gate and judges are agent runs.
    const gateway = traced = createTracedGateway(model, createPostgresTraceStore(db))
    const source = await reviewSourceFromDatabase(db)
    const learning = createLearning({ store, gateway, source, now: async () => (await store.readClock()) ?? source.snapshot.snapshotAt, log: () => {} })
    const reports = await learning.runNow({ dry })
    if (!reports.length) console.log("No reviewer mistakes are usable yet.")
    for (const report of reports) {
      console.log(`${report.group}: ${report.outcome}. ${report.detail}${report.cost ? ` (${money(report.cost)})` : ""}`)
      if (report.distilled) {
        console.log(`  Lesson: ${report.distilled.lesson}`)
        console.log(`  Why: ${report.distilled.explanation}`)
        console.log(`  Applies to: ${report.distilled.appliesTo.join(", ") || "every call"}; from ${report.distilled.mistakeIds.join(", ")}`)
      }
      if (report.lessonId) console.log(`  Stored as ${report.lessonId}: waiting for the operator's yes.`)
    }
    console.log(`Total model cost ${money(reports.reduce((sum, report) => sum + report.cost, 0))}${dry ? " (dry run: nothing stored)" : ""}`)
  } finally {
    await traced?.flush()
    await client.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
