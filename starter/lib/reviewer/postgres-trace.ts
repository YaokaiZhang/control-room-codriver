// Agent runs, model calls and prompt texts (trace.ts) in our own tables. Engine reset
// keeps them (TRACE_TABLES in lib/engine/schema.ts).

import { and, asc, eq, isNull, type SQL } from "drizzle-orm"
import type { Database } from "@/lib/engine/postgres"
import { agentRuns, modelCalls, promptTexts } from "@/lib/engine/schema"
import type { AgentRunRow, TraceStore } from "./trace"

type RunRecord = typeof agentRuns.$inferSelect

function toRun({ seq: _seq, startedAt, finishedAt, ...row }: RunRecord): AgentRunRow {
  return { ...row, startedAt: startedAt.toISOString(), finishedAt: finishedAt?.toISOString() ?? null, usage: row.usage ?? null, cost: row.cost ?? null }
}

/** Needs cr_agent_runs, cr_model_calls and cr_prompt_texts: run `npx drizzle-kit push` after pulling this. */
export function createPostgresTraceStore(db: Database): TraceStore {
  return {
    async startRun({ startedAt, finishedAt, ...row }) {
      await db.insert(agentRuns).values({ ...row, startedAt: new Date(startedAt), finishedAt: finishedAt ? new Date(finishedAt) : null })
        .onConflictDoNothing({ target: agentRuns.id })
    },
    async finishRun(id, { finishedAt, ...end }) {
      await db.update(agentRuns).set({ ...end, finishedAt: finishedAt ? new Date(finishedAt) : null }).where(eq(agentRuns.id, id))
    },
    async addCall({ at, ...row }) {
      await db.insert(modelCalls).values({ ...row, at: new Date(at) }).onConflictDoNothing()
    },
    async putPrompt(hash, text) {
      await db.insert(promptTexts).values({ hash, text, createdAt: new Date() }).onConflictDoNothing({ target: promptTexts.hash })
    },
    async readRun(id) {
      const [row] = await db.select().from(agentRuns).where(eq(agentRuns.id, id)).limit(1)
      return row ? toRun(row) : null
    },
    async readRuns(where) {
      const conditions: SQL[] = []
      if (where.job !== undefined) conditions.push(eq(agentRuns.job, where.job))
      if (where.subject !== undefined) conditions.push(eq(agentRuns.subject, where.subject))
      if (where.parentRunId !== undefined) conditions.push(where.parentRunId === null ? isNull(agentRuns.parentRunId) : eq(agentRuns.parentRunId, where.parentRunId))
      const rows = await db.select().from(agentRuns).where(conditions.length ? and(...conditions) : undefined).orderBy(asc(agentRuns.startedAt), asc(agentRuns.seq))
      return rows.map(toRun)
    },
    async readCalls(runId) {
      const rows = await db.select().from(modelCalls).where(eq(modelCalls.runId, runId)).orderBy(asc(modelCalls.turn))
      return rows.map(({ at, ...row }) => ({ ...row, at: at.toISOString(), response: row.response ?? null, usage: row.usage ?? null, error: row.error ?? null }))
    },
    async readPrompt(hash) {
      const [row] = await db.select().from(promptTexts).where(eq(promptTexts.hash, hash)).limit(1)
      return row?.text ?? null
    },
  }
}
