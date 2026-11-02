import assert from "node:assert/strict"
import { test } from "node:test"
import { createPostgresReviewCache } from "@/lib/reviewer/postgres-cache"
import type { OrderState } from "./engine"
import { createPostgresStore } from "./postgres"
import { exportReviewSnapshot, loadReviewSnapshot, toSnapshot } from "./review-snapshot"
import { reviewResults } from "./schema"
import { testDatabase, testEngine, testGateway } from "./testing"

const find = (orders: OrderState[], reference: string) => orders.find((row) => row.reference === reference)!

test("a snapshot is sorted and drops run ids", () => {
  const snapshot = toSnapshot([
    { key: "k2", orderId: "ord-2", caseHash: "h2", result: { status: "reviewed", runId: "run-2" } },
    { key: "k1", orderId: "ord-1", caseHash: "h1", result: { status: "reviewed", runId: "run-1" } },
  ], new Date("2026-11-02T10:00:00Z"))
  assert.deepEqual(snapshot, {
    exportedAt: "2026-11-02T10:00:00.000Z",
    rows: [
      { key: "k1", orderId: "ord-1", caseHash: "h1", result: { status: "reviewed" } },
      { key: "k2", orderId: "ord-2", caseHash: "h2", result: { status: "reviewed" } },
    ],
  })
})

test("a review exported from one database reads as reviewed in a fresh one, without a model [postgres]", { skip: process.env.TEST_DATABASE_URL ? false : "set TEST_DATABASE_URL" }, async () => {
  const db = testDatabase()!
  await db.delete(reviewResults)
  const sweeper = await testEngine({ store: createPostgresStore(db), gateway: await testGateway(), reviewCache: createPostgresReviewCache(db) })
  await sweeper.apply({ type: "review", orderIds: ["ord-00516"] })
  const snapshot = await exportReviewSnapshot(db)
  assert.equal(snapshot.rows.length, 1)
  assert.equal(snapshot.rows[0].result.runId, undefined)

  await db.delete(reviewResults)
  assert.equal(await loadReviewSnapshot(db, snapshot), 1)
  assert.equal(await loadReviewSnapshot(db, snapshot), 0, "loading again adds nothing")
  const app = await testEngine({ store: createPostgresStore(db), reviewCache: createPostgresReviewCache(db) })
  const order = find((await app.apply({ type: "reset" })).orders, "CD-420516")
  assert.equal(order.review.status, "reviewed")
  assert.equal(order.review.runId, null)
  await db.delete(reviewResults)
})
