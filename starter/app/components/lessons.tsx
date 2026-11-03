"use client"

// The Lessons section of the Rules page (spec .scratch/self-improving-agents): what the
// agents learned from the operator's corrections. A candidate shows the lesson (the only
// part a prompt gets), why it should hold and the mistakes it came from (the gate's eval
// scores stay in the store and `npm run lessons`, not on the page); the operator approves or rejects it, and retires an approved one. Approved
// lessons are listed too, since they are in the prompts now; the rest fold away.

import Link from "next/link"
import { useEffect, useState } from "react"
import type { LessonAction, LessonsView, LessonView, MistakeSource } from "@/lib/engine/lessons"
import { fmtDateTime } from "@/lib/present/time"
import type { Tone } from "@/lib/present/types"
import { More, Pill } from "./ui"

const AGENTS: { agent: LessonView["agent"]; label: string }[] = [{ agent: "reviewer", label: "Reviewer" }, { agent: "plain-words", label: "Card wording" }]
const AGENT_LABEL = Object.fromEntries(AGENTS.map((row) => [row.agent, row.label])) as Record<LessonView["agent"], string>
const STATUS: Record<LessonView["status"], { label: string; tone: Tone }> = {
  candidate: { label: "Waiting for your yes", tone: "warn" },
  approved: { label: "In use", tone: "ok" },
  rejected: { label: "Rejected", tone: "neutral" },
  retired: { label: "Retired", tone: "neutral" },
}
const CARD_KIND: Record<string, string> = { decide: "Decide cards", review: "Review cards", agent: "Agent cards" }

async function send(body: LessonAction): Promise<LessonsView> {
  const response = await fetch("/api/lessons", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  const data = await response.json().catch(() => null) as (LessonsView & { error?: string }) | null
  if (!response.ok || !data) throw new Error(data?.error ?? "The lesson did not change")
  return data
}

function Tags({ lesson }: { lesson: LessonView }) {
  if (!lesson.appliesTo.length) return <span className="lesson-tags">Every {lesson.agent === "reviewer" ? "order" : "card"}</span>
  return <span className="lesson-tags">{lesson.appliesTo.map((tag) => lesson.agent === "reviewer"
    ? <Link key={tag} className="policy-link" href={`#rule-${tag}`}><Pill>{tag}</Pill></Link>
    : <Pill key={tag}>{CARD_KIND[tag] ?? tag}</Pill>)}</span>
}

/** One source mistake: the operator's note and the order when known (ticket 01). */
function Source({ source }: { source: MistakeSource }) {
  return <li>
    {source.orderId && source.reference ? <Link className="ref-link" href={`/orders/${encodeURIComponent(source.orderId)}`}>{source.reference}</Link> : "Correction"}
    {source.note && <span> · {source.note}</span>}
  </li>
}

function LessonCard({ lesson, onChange }: { lesson: LessonView; onChange: (view: LessonsView) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const state = STATUS[lesson.status]
  const decided = lesson.history.at(-1)

  async function run(action: LessonAction["action"]) {
    setBusy(true)
    setError("")
    try {
      onChange(await send({ action, lessonId: lesson.id }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The lesson did not change")
    } finally {
      setBusy(false)
    }
  }

  return <article className={`lesson lesson-${lesson.status}`} id={`lesson-${lesson.id}`} aria-label={lesson.text}>
    <div className="lesson-head">
      <Pill>{AGENT_LABEL[lesson.agent]}</Pill>
      <Tags lesson={lesson} />
      <Pill tone={state.tone}>{state.label}</Pill>
    </div>
    <blockquote className="lesson-text">{lesson.text}</blockquote>
    <p className="lesson-why">{lesson.explanation}</p>
    {decided && <p className="lesson-meta">{decided.kind[0].toUpperCase()}{decided.kind.slice(1)} {fmtDateTime(decided.at, null, false)}</p>}
    {lesson.sources.length > 0 && <More label={`Source mistakes (${lesson.sources.length})`}>
      <ul className="lesson-sources">{lesson.sources.map((source) => <Source key={source.id} source={source} />)}</ul>
    </More>}
    {lesson.status === "candidate" && <div className="proposal-actions">
      <button className="btn btn-primary btn-s" type="button" disabled={busy} onClick={() => run("approve")}>Approve</button>
      <button className="btn btn-tertiary btn-s" type="button" disabled={busy} onClick={() => run("reject")}>Reject</button>
    </div>}
    {lesson.status === "approved" && <div className="proposal-actions">
      <button className="btn btn-quiet btn-s" type="button" disabled={busy} onClick={() => run("retire")}>Retire</button>
    </div>}
    {error && <p className="lesson-error" role="alert">{error}</p>}
  </article>
}

export function Lessons() {
  const [view, setView] = useState<LessonsView | null>(null)
  const [error, setError] = useState("")

  useEffect(() => {
    const controller = new AbortController()
    fetch("/api/lessons", { signal: controller.signal })
      .then((response) => { if (!response.ok) throw new Error("Could not load the lessons"); return response.json() as Promise<LessonsView> })
      .then((data) => {
        setView(data)
        // The Briefing links to one lesson: bring it into view once it is rendered.
        const wanted = window.location.hash.slice(1)
        if (wanted.startsWith("lesson-")) requestAnimationFrame(() => document.getElementById(wanted)?.scrollIntoView())
      })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load the lessons") })
    return () => controller.abort()
  }, [])

  const lessons = view?.lessons ?? []
  const waiting = lessons.filter((lesson) => lesson.status === "candidate")
  const approved = lessons.filter((lesson) => lesson.status === "approved")
  const past = lessons.filter((lesson) => lesson.status === "rejected" || lesson.status === "retired")
  const card = (lesson: LessonView) => <LessonCard key={lesson.id} lesson={lesson} onChange={setView} />

  return <section className="rules-section" id="lessons" aria-labelledby="lessons-head">
    <h2 id="lessons-head">Lessons</h2>
    <p>What the agents learned from your corrections. Only lessons you approve are used{view ? `, at most ${view.max} per agent` : ""}.</p>
    {error && <p className="queue-error" role="alert">{error}.</p>}
    {view && approved.length > 0 && <p className="lesson-counts">{AGENTS.map(({ agent, label }) => `${label}: ${approved.filter((lesson) => lesson.agent === agent).length} of ${view.max}`).join(" · ")}</p>}
    {view && !lessons.length && <p className="empty">No lessons yet. One is proposed after you correct the same kind of mistake a few times.</p>}
    {waiting.length > 0 && <div className="lesson-list">{waiting.map(card)}</div>}
    {approved.length > 0 && <>
      <h3 className="rules-sub">In use</h3>
      <div className="lesson-list">{approved.map(card)}</div>
    </>}
    {past.length > 0 && <More label={`Rejected and retired (${past.length})`}><div className="lesson-list">{past.map(card)}</div></More>}
  </section>
}
