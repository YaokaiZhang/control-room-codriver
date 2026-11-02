// The committed review snapshot: the reviewer's results for the packet's orders, kept in
// git so a fresh or reseeded database starts reviewed without calling the model.
//
// - `npm run review:snapshot` writes data/review-snapshot.json from a database's
//   cr_review_results (sweep it first); `npm run db:seed` loads the file.
// - A row is the cache row as stored: its key covers the case file, prompt version, model
//   and approved lessons, so a row only hits while all of those are unchanged. After a
//   prompt or model change, or for an order an approved lesson applies to, the order
//   reads "not reviewed yet" again: re-sweep and re-export.
// - Loading never overwrites a row the database already has.
// - The run id is dropped: the run lives in the exporting database's trace tables, not here.

import { asc } from "drizzle-orm"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import type { Database } from "./postgres"
import { reviewResults } from "./schema"

/** Relative to the starter folder, where the npm scripts run. */
export const REVIEW_SNAPSHOT_PATH = path.join("data", "review-snapshot.json")

export type SnapshotRow = { key: string; orderId: string; caseHash: string; result: Record<string, unknown> }

export type ReviewSnapshot = { exportedAt: string; rows: SnapshotRow[] }

/** Stable order and no run ids, so re-exporting unchanged reviews gives the same file. */
export function toSnapshot(rows: SnapshotRow[], exportedAt: Date): ReviewSnapshot {
  return {
    exportedAt: exportedAt.toISOString(),
    rows: [...rows].sort((a, b) => a.orderId.localeCompare(b.orderId) || a.key.localeCompare(b.key)).map((row) => {
      const { runId: _runId, ...result } = row.result
      return { key: row.key, orderId: row.orderId, caseHash: row.caseHash, result }
    }),
  }
}

export async function exportReviewSnapshot(db: Database, exportedAt = new Date()): Promise<ReviewSnapshot> {
  const rows = await db.select({ key: reviewResults.key, orderId: reviewResults.orderId, caseHash: reviewResults.caseHash, result: reviewResults.result })
    .from(reviewResults).orderBy(asc(reviewResults.key))
  return toSnapshot(rows, exportedAt)
}

/** Inserts the snapshot's rows the database doesn't have yet; returns how many were added. */
export async function loadReviewSnapshot(db: Database, snapshot: ReviewSnapshot): Promise<number> {
  if (!snapshot.rows.length) return 0
  const createdAt = new Date(snapshot.exportedAt)
  const added = await db.insert(reviewResults)
    .values(snapshot.rows.map((row) => ({ ...row, createdAt })))
    .onConflictDoNothing({ target: reviewResults.key })
    .returning({ key: reviewResults.key })
  return added.length
}

/** The committed snapshot, or null when the file is missing. */
export function readReviewSnapshot(file = REVIEW_SNAPSHOT_PATH): ReviewSnapshot | null {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as ReviewSnapshot : null
}
