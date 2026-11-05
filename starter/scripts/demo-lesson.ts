// Prepares a local demo DB with a lesson waiting for the operator's yes (spec
// .scratch/self-improving-agents). It does what an operator would do in the app: on three
// orders over two demo days it edits the reviewer's question to the paying customer to
// add a reply-by time. Then it runs the distil and gate once, as `npm run lessons` does.
// When the gate keeps the lesson, the clock is reset, so the demo starts at the snapshot
// with the candidate in the Briefing and on the Lessons page. The edits are cleared by the
// reset and the mistakes and lesson stay. About $0.20 of model calls.
//
//   createdb, then on that DB: npm run db:push && npm run db:seed
//   DATABASE_URL=postgres://…@localhost:5432/<fresh db> npm run demo:lesson
//
// Local databases only: it refuses any other host. Run it on a fresh seed: it stops when
// the DB already holds mistakes or lessons. Needs ANTHROPIC_API_KEY; behind an HTTPS proxy,
// set NODE_USE_ENV_PROXY=1 (the npm script does).

import "dotenv/config"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { createEngine } from "../lib/engine/engine"
import { groupMistakes } from "../lib/engine/distil"
import { createLearning, rulesAtSnapshot } from "../lib/engine/learning"
import { createPostgresStore } from "../lib/engine/postgres"
import type { Proposal } from "../lib/engine/proposals"
import { DESK_ZONE } from "../lib/present/time"
import { anthropicFromEnv } from "../lib/reviewer/anthropic"
import { createPostgresReviewCache } from "../lib/reviewer/postgres-cache"
import { createPostgresTraceStore } from "../lib/reviewer/postgres-trace"
import { money } from "../lib/reviewer/report"
import { reviewSourceFromDatabase } from "../lib/reviewer/source"
import { createTracedGateway, type TracingGateway } from "../lib/reviewer/trace"

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"])
const ORDERS = 3

/** "14:00": a whole hour a few hours after `at`, on the desk's clock. */
function replyBy(at: string): string {
  const hour = new Date(new Date(at).getTime() + 3 * 3_600_000)
  return new Intl.DateTimeFormat("en-GB", { timeZone: DESK_ZONE, hour: "2-digit", hourCycle: "h23" }).format(hour) + ":00"
}

const withDeadline = (script: string, at: string) => `${script.trim()} Please reply by ${replyBy(at)} today so we can brief the driver.`

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL is required: a fresh local database, pushed and seeded.")
  const host = new URL(url).hostname
  if (!LOCAL_HOSTS.has(host)) throw new Error(`Refusing ${host}: this script writes demo state and runs only against a local database.`)
  const model = anthropicFromEnv()
  if (!model) {
    console.error("ANTHROPIC_API_KEY is not set: the gate needs the model. Nothing was run.")
    process.exit(2)
  }

  const client = postgres(url, { max: 2, onnotice: () => {} })
  let traced: TracingGateway | null = null
  try {
    const db = drizzle(client)
    const store = createPostgresStore(db)
    if ((await store.readMistakes()).length || (await store.readLessons()).length) {
      throw new Error("This database already holds mistakes or lessons. Start from a fresh one: createdb, db:push, db:seed.")
    }
    const gateway = traced = createTracedGateway(model, createPostgresTraceStore(db))
    const source = await reviewSourceFromDatabase(db)
    // The committed reviews from the seed: no review runs here. No lessons are injected yet.
    const engine = createEngine({ snapshot: source.snapshot, store, reviews: { gateway, cache: createPostgresReviewCache(db), inboxMessages: source.inboxMessages } })
    await engine.apply({ type: "reset" })

    // The reviewer's open questions to the paying customer, grouped as their mistakes will
    // be (by the rules failing on the order), so all three edits land in one lesson group.
    const rules = rulesAtSnapshot(source)
    const open = (await engine.state()).orders.flatMap((order) => order.proposals
      .filter((proposal) => proposal.status === "proposed" && proposal.source === "reviewer" && proposal.contact.type === "paying_customer" && proposal.script.trim())
      .slice(0, 1)
      .map((proposal) => ({ proposal, failing: rules(order.reference).filter((rule) => rule.status === "failed").map((rule) => rule.rule).sort().join(",") || "none" })))
    const byGroup = new Map<string, Proposal[]>()
    for (const { proposal, failing } of open) byGroup.set(failing, [...byGroup.get(failing) ?? [], proposal])
    const ranked = [...byGroup.entries()].filter(([, rows]) => rows.length >= ORDERS).sort(([a, x], [b, y]) => Number(b === "none") - Number(a === "none") || y.length - x.length)
    if (!ranked.length) throw new Error(`No ${ORDERS} orders share a lesson group for questions to the paying customer. Is the DB seeded?`)
    const [group, rows] = ranked[0]
    const picked = rows.slice(0, ORDERS)
    console.log(`Group rule:${group}/contact:paying_customer: ${picked.map((proposal) => proposal.reference).join(", ")}`)

    // Two edits on the first demo day, one the next: a lesson needs at least two days.
    for (const [i, proposal] of picked.entries()) {
      if (i === ORDERS - 1) await engine.apply({ type: "advanceClock", minutes: 24 * 60 })
      const at = await engine.clock()
      const script = withDeadline(proposal.script, at)
      await engine.apply({ type: "editScript", proposalId: proposal.id, script })
      console.log(`  ${proposal.reference} (${at.slice(0, 16)}): ${script}`)
    }
    await engine.settleMistakes()

    const groups = groupMistakes(await store.readMistakes())
    console.log(`Mistakes recorded: ${groups.map((row) => `${row.key} ${row.mistakes.length}`).join("; ")}`)

    const learning = createLearning({ store, gateway, source, now: () => engine.clock(), log: (line) => console.log(`  ${line}`) })
    const reports = await learning.runNow()
    for (const report of reports) {
      console.log(`${report.group}: ${report.outcome}. ${report.detail}${report.cost ? ` (${money(report.cost)})` : ""}`)
      if (report.distilled) console.log(`  Lesson: ${report.distilled.lesson}`)
    }
    console.log(`Total model cost ${money(reports.reduce((sum, report) => sum + report.cost, 0))}`)

    const candidate = (await store.readLessons()).find((lesson) => reports.some((report) => report.lessonId === lesson.id))
    if (!candidate) {
      console.error("The gate kept no lesson. Drop this database and run again on a fresh seed (the model's runs vary).")
      process.exit(3)
    }
    // Start the demo clean: the edited questions are back to the reviewer's own words.
    await engine.apply({ type: "reset" })
    console.log(`Ready: ${candidate.id} waits for the operator's yes in the Briefing and on the Lessons page. The clock is back at the snapshot.`)
  } finally {
    await traced?.flush()
    await client.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
