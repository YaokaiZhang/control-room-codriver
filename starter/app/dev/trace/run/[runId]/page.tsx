// /dev/trace/run/[runId]: one agent run for engineers (spec .scratch/traceability,
// issue 04). Its metadata, parent and child runs, the lessons in its prompt, the prompt
// as sent, and every model call with its full request, reply, usage, latency and error.
// Read-only, unstyled on purpose, not linked from the operator's pages. Off in
// production unless DEV_PAGES=1. The data is lib/engine/trace-view.ts.

import { notFound } from "next/navigation"
import type { AgentRunRow } from "@/lib/reviewer/trace"
import { getStore, getTraceStore } from "@/lib/engine/server"
import { runHref, runTrace, type RunCall } from "@/lib/engine/trace-view"
import { CSS, guardDevPage, Json, time, tone, usd } from "../../parts"

export const dynamic = "force-dynamic"
export const metadata = { title: "Run trace · dev" }

function RunRef({ run }: { run: AgentRunRow }) {
  return <div><a href={runHref(run.id)}>{run.id}</a> <span className="muted">{run.job} · {run.subject} · <span className={tone(run.outcome)}>{run.outcome}</span> · {time(run.startedAt)}</span></div>
}

function Call({ call }: { call: RunCall }) {
  const reply = call.response?.message
  const text = reply && typeof reply.content === "string" ? reply.content : null
  return <tr id={`turn-${call.turn}`}>
    <td>{call.turn}</td>
    <td>{time(call.at)}<br /><span className="muted">{call.latencyMs} ms</span></td>
    <td>
      <div className="muted">{call.request.model} · effort {call.request.effort ?? "-"} · max {call.request.maxTokens ?? "-"} tokens · {call.request.messages.length} messages{call.request.tools ? ` · ${call.request.tools.length} tools` : ""}</div>
      {call.rebuildError && <div className="bad">could not rebuild the full request: {call.rebuildError} (showing the row as stored)</div>}
      <Json label="request (full)" value={call.request.messages} />
      {call.request.tools && <Json label="tools" value={call.request.tools} />}
      {call.stored.messagesFrom !== undefined && <Json label={`as stored (messages from ${call.stored.messagesFrom})`} value={call.stored} />}
    </td>
    <td>
      {call.error && <div className="bad">error: {call.error}</div>}
      {call.response && <div className="muted">{call.response.model} · {call.response.finishReason}</div>}
      {text && <pre>{text}</pre>}
      <Json label="reply" value={reply} />
    </td>
    <td>{call.usage ? <>{call.usage.promptTokens} in{call.usage.cachedTokens ? ` (${call.usage.cachedTokens} cached)` : ""}<br />{call.usage.completionTokens} out<br />{usd(call.usage.cost)}</> : "-"}</td>
  </tr>
}

export default async function RunTracePage({ params }: { params: Promise<{ runId: string }> }) {
  guardDevPage()
  const { runId } = await params
  const view = await runTrace(decodeURIComponent(runId), { store: getStore(), traces: getTraceStore() })
  if (!view) notFound()
  const { run } = view
  return <main className="dev">
    <style>{CSS}</style>
    <h1>Run trace: {run.job} on {run.subject}</h1>
    <p className="muted">For engineers. Real times in UTC.</p>
    <nav><a href="#prompt">Prompt</a><a href="#calls">Model calls</a>{view.subjectHref && <a href={view.subjectHref}>{view.subjectHref.startsWith("/dev/trace/") ? "Order trace" : "Learning trace"}</a>}</nav>

    <h2>Run</h2>
    <div className="wrap"><table><tbody>
      <tr><th>id</th><td>{run.id}</td></tr>
      <tr><th>job / subject</th><td>{run.job} · {view.subjectHref ? <a href={view.subjectHref}>{run.subject}</a> : run.subject}</td></tr>
      <tr><th>model</th><td>{run.model}</td></tr>
      <tr><th>prompt version / hash</th><td>{run.promptVersion ?? "-"} · {run.promptHash ?? "-"}</td></tr>
      <tr><th>input hash</th><td>{run.inputHash ?? "-"}</td></tr>
      <tr><th>outcome</th><td className={tone(run.outcome)}>{run.outcome}</td></tr>
      <tr><th>started / finished</th><td>{time(run.startedAt)} → {time(run.finishedAt)}</td></tr>
      <tr><th>usage / cost</th><td>{run.usage ? `${run.usage.promptTokens} in (${run.usage.cachedTokens} cached, ${run.usage.cacheWriteTokens} written), ${run.usage.completionTokens} out, ${run.usage.reasoningTokens} reasoning` : "-"} · {usd(run.cost)}</td></tr>
      <tr><th>parent run</th><td>{view.parent ? <RunRef run={view.parent} /> : run.parentRunId ? <span className="warn">{run.parentRunId}: not traced</span> : "-"}</td></tr>
      <tr><th>child runs</th><td>{view.children.length ? view.children.map((child) => <RunRef key={child.id} run={child} />) : "-"}</td></tr>
    </tbody></table></div>

    <h2>Lessons in its prompt</h2>
    {view.lessons.length ? <ul>{view.lessons.map((lesson) => <li key={lesson.id}>
      <a href={lesson.href}>{lesson.id}</a> {lesson.status && <span className={tone(lesson.status)}>{lesson.status}</span>} {lesson.text ?? <span className="warn">not stored</span>}
    </li>)}</ul> : <p className="muted">None.</p>}

    <h2 id="prompt">Prompt as sent</h2>
    {view.prompt !== null ? <details><summary>{view.prompt.length} characters</summary><pre>{view.prompt}</pre></details>
      : <p className="muted">{run.promptHash ? `not traced (no text for ${run.promptHash})` : "No system prompt recorded."}</p>}

    <h2 id="calls">Model calls, in order</h2>
    {view.calls.length ? <div className="wrap"><table>
      <thead><tr><th>turn</th><th>sent / latency</th><th>request</th><th>reply</th><th>usage</th></tr></thead>
      <tbody>{view.calls.map((call) => <Call key={call.turn} call={call} />)}</tbody>
    </table></div> : <p className="muted">No model calls recorded under this run (its turns may sit under child runs).</p>}
  </main>
}
