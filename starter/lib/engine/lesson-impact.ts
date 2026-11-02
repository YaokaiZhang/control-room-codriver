// What happened after a lesson was approved (spec .scratch/traceability, issue 05),
// worked out from runs and mistakes; no table of its own. Shown on /dev/learning.
//
// - Reviews: finished reviewer runs at the top level (not the gate's reviews, which sit
//   under a distil run), and not failed (a failed review found nothing). A cached review
//   makes no run, so it is not counted.
// - A lesson's group: the group of the distil run that wrote it; a lesson with no distil
//   run (seeded by hand) takes every group its source mistakes fall in. Mistakes are put
//   in groups by `groupMistakes` (distil.ts), as the distiller does: usable reviewer
//   mistakes only.
// - When a mistake happened: when its review started (runId), else when it was recorded.
//   Untraced mistakes count toward the rates but can't be "despite".
// - Before: every review started before approval (all of them for a lesson never approved).
//   After: from approval to retirement, or to now; none for a lesson never approved.
// - Despite: mistakes in the group whose own review had the lesson in its prompt.

import type { AgentRunRow } from "@/lib/reviewer/trace"
import { groupKeys, groupMistakes, type DistilRun } from "./distil"
import type { Lesson } from "./lessons"
import type { Mistake } from "./mistakes"

export type ImpactLesson = Pick<Lesson, "id" | "sourceMistakeIds" | "history">

export type ImpactWindow = {
  /** Real time; null: from the first review. */
  from: string | null
  /** Real time; null: up to now. */
  to: string | null
  /** Reviews started in the window. */
  runs: number
  /** Mistakes in the lesson's group that happened in the window. */
  mistakes: number
  /** Mistakes per 100 reviews; null with no reviews. */
  per100: number | null
}

export type LessonImpact = {
  lessonId: string
  /** Mistake group keys ("reviewer/rule:R7/contact:paying_customer"); empty when none is known. */
  groups: string[]
  /** The reviews whose prompt had the lesson, newest first. */
  injected: { count: number; runIds: string[] }
  before: ImpactWindow
  /** null: never approved. */
  after: ImpactWindow | null
  /** Ids of the group's mistakes whose review already had the lesson, oldest first. */
  despite: string[]
}

export type ImpactInput = {
  lessons: ImpactLesson[]
  distilRuns: Pick<DistilRun, "group" | "lessonId">[]
  /** Reviewer runs (`readRuns({ job: "reviewer" })`); other runs are ignored. */
  reviewerRuns: AgentRunRow[]
  mistakes: Mistake[]
}

/** Mistakes per 100 reviews, null when there were no reviews. */
export function per100(mistakes: number, runs: number): number | null {
  return runs ? (mistakes / runs) * 100 : null
}

const isReview = (run: AgentRunRow) => run.job === "reviewer" && run.parentRunId === null && run.finishedAt !== null
  && run.outcome !== "running" && !run.outcome.startsWith("failed")

/** The group keys a lesson is about: its distil run's group, else its source mistakes' groups. */
function groupsOf(lesson: ImpactLesson, distilRuns: ImpactInput["distilRuns"], mistakes: Map<string, Mistake>): string[] {
  const fromRuns = distilRuns.filter((run) => run.lessonId === lesson.id).map((run) => run.group)
  if (fromRuns.length) return [...new Set(fromRuns)]
  return [...new Set(lesson.sourceMistakeIds.flatMap((id) => { const row = mistakes.get(id); return row ? groupKeys(row) : [] }))]
}

export function lessonImpacts(input: ImpactInput): LessonImpact[] {
  const reviews = input.reviewerRuns.filter(isReview).sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  const started = new Map(input.reviewerRuns.map((run) => [run.id, run.startedAt]))
  const byId = new Map(input.mistakes.map((row) => [row.id, row]))
  const groups = new Map(groupMistakes(input.mistakes).map((group) => [group.key, group.mistakes]))
  const happened = (mistake: Mistake) => (mistake.runId && started.get(mistake.runId)) || mistake.recordedAt
  const within = (at: string, from: string | null, to: string | null) => (from === null || at >= from) && (to === null || at < to)

  return input.lessons.map((lesson) => {
    const keys = groupsOf(lesson, input.distilRuns, byId)
    const inGroup = [...new Map(keys.flatMap((key) => groups.get(key) ?? []).map((row) => [row.id, row])).values()]
      .sort((a, b) => happened(a).localeCompare(happened(b)) || a.id.localeCompare(b.id))
    const window = (from: string | null, to: string | null): ImpactWindow => {
      const runs = reviews.filter((run) => within(run.startedAt, from, to)).length
      const mistakes = inGroup.filter((row) => within(happened(row), from, to)).length
      return { from, to, runs, mistakes, per100: per100(mistakes, runs) }
    }
    const approvedAt = lesson.history.find((event) => event.kind === "approved")?.at ?? null
    const retiredAt = lesson.history.find((event) => event.kind === "retired")?.at ?? null
    const injected = reviews.filter((run) => run.lessonIds.includes(lesson.id))
    const injectedIds = new Set(injected.map((run) => run.id))
    return {
      lessonId: lesson.id,
      groups: keys,
      injected: { count: injected.length, runIds: injected.map((run) => run.id).reverse() },
      before: window(null, approvedAt),
      after: approvedAt ? window(approvedAt, retiredAt) : null,
      despite: inGroup.filter((row) => row.runId !== null && injectedIds.has(row.runId)).map((row) => row.id),
    }
  })
}
