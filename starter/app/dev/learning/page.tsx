// /dev/learning: the lessons loop for engineers (spec .scratch/self-improving-agents).
// Every mistake with its note, restatement and tags; each group and whether it qualifies;
// every distil run with the gate's trace (spec checks, the judge's verdicts and reasons);
// every lesson with its events and what happened after it was approved (lesson-impact.ts,
// spec .scratch/traceability issue 05), linking to /dev/trace. Read-only, unstyled on purpose, not linked from the
// operator's pages. Off in production unless DEV_PAGES=1.

import { notFound } from "next/navigation"
import { groupHistory, groupMistakes, qualifies, type DistilRun, type GateTraceRun } from "@/lib/engine/distil"
import { lessonImpacts, type ImpactWindow, type LessonImpact } from "@/lib/engine/lesson-impact"
import { readLessons, type Lesson } from "@/lib/engine/lessons"
import type { Mistake } from "@/lib/engine/mistakes"
import { getStore, getTraceStore } from "@/lib/engine/server"
import type { AgentRunRow } from "@/lib/reviewer/trace"

export const dynamic = "force-dynamic"
export const metadata = { title: "Learning trace · dev" }

const CSS = `
.dev{font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;color:#1a1a1a;background:#fff;padding:16px;max-width:1400px;margin:0 auto}
.dev h1{font-size:18px;margin:0 0 4px}.dev h2{font-size:15px;margin:28px 0 8px;border-bottom:1px solid #ccc;padding-bottom:4px}
.dev nav a{margin-right:12px}.dev .muted{color:#666}.dev table{border-collapse:collapse;width:100%}
.dev th,.dev td{border:1px solid #ddd;padding:4px 6px;vertical-align:top;text-align:left}.dev th{background:#f4f4f4}
.dev .wrap{overflow-x:auto;max-width:100%}.dev p,.dev td{overflow-wrap:anywhere}.dev pre{white-space:pre-wrap;word-break:break-word;margin:4px 0;background:#f8f8f8;padding:6px}
.dev .ok{color:#0a6b2d}.dev .bad{color:#a4161a}.dev .warn{color:#8a5a00}.dev details summary{cursor:pointer}
.dev .tag{display:inline-block;background:#eef;border-radius:3px;padding:0 4px;margin:0 2px 2px 0}
`

const time = (iso: string | null) => iso ? iso.replace("T", " ").replace(/:\d\d(\.\d+)?Z$/, "Z") : "-"
const usd = (value: number) => `$${value.toFixed(4)}`
const runLink = (id: string) => `/dev/trace/run/${encodeURIComponent(id)}`
const orderLink = (id: string) => `/dev/trace/${encodeURIComponent(id)}`
/** Run links shown on a lesson before "and N more". */
const MAX_RUN_LINKS = 10
const tone = (value: string) => ["usable", "candidate", "approved", "fixed", "restated"].includes(value) ? "ok"
  : ["unusable", "dropped", "failed", "invalid", "rejected", "repeats"].includes(value) ? "bad" : "warn"

function Json({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined) return null
  return <details><summary>{label}</summary><pre>{JSON.stringify(value, null, 2)}</pre></details>
}

function Mistakes({ mistakes }: { mistakes: Mistake[] }) {
  return <div className="wrap"><table>
    <thead><tr><th>id / recorded</th><th>demo day</th><th>agent / kind</th><th>order</th><th>status</th><th>tags</th><th>what was wrong</th><th>raw</th></tr></thead>
    <tbody>{mistakes.map((mistake) => <tr key={mistake.id} id={mistake.id}>
      <td>{mistake.id}<br /><span className="muted">{time(mistake.recordedAt)}</span>
        {mistake.runId && <div>run <a href={runLink(mistake.runId)}>{mistake.runId.slice(0, 12)}</a></div>}</td>
      <td>{time(mistake.at)}</td>
      <td>{mistake.agent}<br />{mistake.kind}</td>
      <td>{mistake.orderId ? <a href={orderLink(mistake.orderId)}>{mistake.orderId}</a> : "-"}</td>
      <td className={tone(mistake.status)}>{mistake.status}{mistake.unusableReason ? <><br /><span className="muted">{mistake.unusableReason}</span></> : null}</td>
      <td>{mistake.tags.map((tag) => <span key={tag} className="tag">{tag}</span>)}</td>
      <td>
        {mistake.operatorNote && <div><b>note:</b> {mistake.operatorNote}</div>}
        {mistake.restatement && <div><b>restated:</b> {mistake.restatement}</div>}
        {mistake.editDiff && <div><b>edit:</b> &quot;{mistake.editDiff.before}&quot; → &quot;{mistake.editDiff.after}&quot;</div>}
        {mistake.validatorReason && <div><b>validator:</b> {mistake.validatorReason}</div>}
      </td>
      <td><Json label="agent output" value={mistake.agentOutput} /><Json label="input" value={mistake.input} />
        {mistake.caseFile && <span className="muted">case file: {mistake.caseFile.reference} @ {time(mistake.caseFile.now)}, {mistake.caseFile.records.length} records</span>}
        <div className="muted">{mistake.model ?? "-"} · {mistake.promptVersion}</div></td>
    </tr>)}</tbody>
  </table></div>
}

function GateRun({ run }: { run: GateTraceRun }) {
  return <tr>
    <td>{run.withLesson ? "with" : "without"}</td>
    <td>{run.existing.points}/{run.existing.max}{run.existing.failed.map((fail, index) => <div key={index} className="bad">{fail.reference} {fail.check}: {fail.detail}</div>)}</td>
    <td>{run.learned.map((row, index) => <div key={index}><span className={tone(row.verdict)}>{row.verdict}</span> {row.reference} <a href={`#${row.mistakeId}`}>{row.mistakeId.slice(0, 11)}</a>: {row.reason}</div>)}</td>
    <td>{usd(run.cost)}</td>
  </tr>
}

function Runs({ runs }: { runs: DistilRun[] }) {
  return <div className="wrap"><table>
    <thead><tr><th>started / finished</th><th>group</th><th>outcome</th><th>cost</th><th>detail</th></tr></thead>
    <tbody>{runs.map((run) => <tr key={run.id} id={run.id}>
      <td>{time(run.startedAt)}<br /><span className="muted">{time(run.finishedAt)}</span></td>
      <td>{run.group}</td>
      <td className={tone(run.outcome)}>{run.outcome}{run.lessonId && <><br /><a href={`#${run.lessonId}`}>{run.lessonId}</a></>}</td>
      <td>{usd(run.cost)}</td>
      <td>
        <div>{run.detail}</div>
        {run.mistakeIds.length > 0 && <div className="muted">mistakes: {run.mistakeIds.map((id) => <a key={id} href={`#${id}`} style={{ marginRight: 6 }}>{id.slice(0, 11)}</a>)}</div>}
        {run.gate && <details><summary>gate trace: {run.gate.keep ? "kept" : "dropped"}</summary>
          <p><b>lesson:</b> {run.gate.lesson}</p>
          <table><thead><tr><th>lesson</th><th>spec checks</th><th>learned cases (judge)</th><th>cost</th></tr></thead>
            <tbody>{run.gate.runs.map((row, index) => <GateRun key={index} run={row} />)}</tbody></table>
        </details>}
      </td>
    </tr>)}</tbody>
  </table></div>
}

function Rate({ label, window }: { label: string; window: ImpactWindow }) {
  return <div>{label}: {window.per100 === null ? "-" : window.per100.toFixed(1)} per 100 reviews <span className="muted">({window.mistakes} mistake(s) in {window.runs} review(s))</span></div>
}

/** What happened after approval: reviews it was in, the group's rate before and after, mistakes despite it. */
function Impact({ impact, status }: { impact: LessonImpact | undefined; status: Lesson["status"] }) {
  if (!impact) return <span className="muted">not traced</span>
  const shown = impact.injected.runIds.slice(0, MAX_RUN_LINKS)
  const more = impact.injected.count - shown.length
  return <div>
    <div>in {impact.injected.count} review(s){shown.length > 0 && ": "}{shown.map((id) => <a key={id} href={runLink(id)} style={{ marginRight: 6 }}>{id.slice(0, 12)}</a>)}{more > 0 && <span> and {more} more</span>}</div>
    <div className="muted">group: {impact.groups.length ? impact.groups.join(", ") : "none known"}</div>
    <Rate label="before approval" window={impact.before} />
    {impact.after ? <Rate label={status === "retired" ? "after, to retirement" : "after approval"} window={impact.after} /> : <div className="muted">after: - (never approved)</div>}
    <div>despite the lesson: {impact.despite.length ? impact.despite.map((id) => <a key={id} href={`#${id}`} style={{ marginRight: 6 }}>{id.slice(0, 11)}</a>) : "none"}</div>
  </div>
}

function Lessons({ lessons, impacts }: { lessons: Lesson[]; impacts: Map<string, LessonImpact> }) {
  return <div className="wrap"><table>
    <thead><tr><th>id / created</th><th>agent / by</th><th>status</th><th>lesson</th><th>applies to</th><th>sources</th><th>spec eval</th><th>events</th><th>after approval</th></tr></thead>
    <tbody>{lessons.map((lesson) => <tr key={lesson.id} id={lesson.id}>
      <td>{lesson.id}<br /><span className="muted">{time(lesson.createdAt)}</span></td>
      <td>{lesson.agent}<br />{lesson.by}</td>
      <td className={tone(lesson.status)}>{lesson.status}</td>
      <td>{lesson.text}<details><summary>explanation</summary><pre>{lesson.explanation}</pre></details></td>
      <td>{lesson.appliesTo.length ? lesson.appliesTo.join(", ") : "every call"}</td>
      <td>{lesson.sourceMistakeIds.map((id) => <div key={id}><a href={`#${id}`}>{id.slice(0, 11)}</a></div>)}</td>
      <td>{lesson.evalBefore ?? "-"} → {lesson.evalAfter ?? "-"}</td>
      <td>{lesson.history.map((event, index) => <div key={index}>{time(event.at)} {event.kind} by {event.by}{event.text ? `: ${event.text}` : ""}</div>)}</td>
      <td>{lesson.agent === "reviewer" ? <Impact impact={impacts.get(lesson.id)} status={lesson.status} /> : <span className="muted">-</span>}</td>
    </tr>)}</tbody>
  </table></div>
}

export default async function LearningTracePage() {
  if (process.env.NODE_ENV === "production" && process.env.DEV_PAGES !== "1") notFound()
  const store = getStore()
  // One read of every top-level review run, for every lesson; null when the trace tables aren't there (not pushed yet).
  const [mistakes, runs, lessons, reviews] = await Promise.all([
    store.readMistakes(), store.readDistilRuns(), readLessons(store),
    getTraceStore().readRuns({ job: "reviewer", parentRunId: null }).catch((): AgentRunRow[] | null => null),
  ])
  const impacts = new Map(reviews ? lessonImpacts({ lessons, distilRuns: runs, reviewerRuns: reviews, mistakes }).map((row) => [row.lessonId, row]) : [])
  const groups = groupMistakes(mistakes).map((group) => ({ group, check: qualifies(group, groupHistory(group.key, runs, lessons)) }))
  const newest = <T,>(rows: T[], key: (row: T) => string) => [...rows].sort((a, b) => key(b).localeCompare(key(a)))
  const spent = runs.reduce((sum, run) => sum + run.cost, 0)
  return <main className="dev">
    <style>{CSS}</style>
    <h1>Learning trace</h1>
    <p className="muted">For engineers. {mistakes.length} mistakes ({mistakes.filter((row) => row.status === "usable").length} usable), {groups.length} groups, {runs.length} runs ({usd(spent)}), {lessons.length} lessons. Real times in UTC; demo day is the demo clock.</p>
    <nav><a href="#groups">Groups</a><a href="#runs">Runs</a><a href="#lessons">Lessons</a><a href="#mistakes">Mistakes</a></nav>

    <h2 id="groups">Groups</h2>
    {groups.length ? <div className="wrap"><table>
      <thead><tr><th>group</th><th>usable mistakes</th><th>orders</th><th>days</th><th>qualifies</th></tr></thead>
      <tbody>{groups.map(({ group, check }) => <tr key={group.key}>
        <td>{group.key}</td><td>{group.mistakes.length}</td>
        <td>{new Set(group.mistakes.map((row) => row.orderId)).size}</td>
        <td>{new Set(group.mistakes.map((row) => row.at.slice(0, 10))).size}</td>
        <td className={check.ok ? "ok" : "warn"}>{check.ok ? "yes" : "no"}: {check.reason}</td>
      </tr>)}</tbody>
    </table></div> : <p className="muted">No usable mistakes yet.</p>}

    <h2 id="runs">Distil runs, newest first</h2>
    {runs.length ? <Runs runs={newest(runs, (run) => run.startedAt)} /> : <p className="muted">No runs yet.</p>}

    <h2 id="lessons">Lessons, newest first</h2>
    {lessons.length ? <Lessons lessons={newest(lessons, (lesson) => lesson.createdAt)} impacts={impacts} /> : <p className="muted">No lessons yet.</p>}

    <h2 id="mistakes">Mistakes, newest first</h2>
    {mistakes.length ? <Mistakes mistakes={newest(mistakes, (row) => row.recordedAt)} /> : <p className="muted">No mistakes yet.</p>}
  </main>
}
