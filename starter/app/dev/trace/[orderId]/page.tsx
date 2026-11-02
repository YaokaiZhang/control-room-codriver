// /dev/trace/[orderId]: one order's timeline for engineers (spec .scratch/traceability,
// issue 04). Agent runs, the current review's findings, proposal events, effects, calls
// and mistakes, oldest first, each linked to what it came from. Takes the order id or
// reference. Read-only, unstyled on purpose, not linked from the operator's pages. Off
// in production unless DEV_PAGES=1. The data is lib/engine/trace-view.ts.

import { notFound } from "next/navigation"
import { getEngine, getStore, getTraceStore } from "@/lib/engine/server"
import { findOrder, orderTrace, type TraceLine } from "@/lib/engine/trace-view"
import { CSS, guardDevPage, Json, Links, time, tone } from "../parts"

export const dynamic = "force-dynamic"
export const metadata = { title: "Order trace · dev" }

function Line({ line }: { line: TraceLine }) {
  return <tr id={line.id}>
    <td>{time(line.at)}<br /><span className="muted">{line.clock}</span></td>
    <td>{line.kind}{line.event ? <><br /><span className={tone(line.event)}>{line.event}</span></> : null}</td>
    <td>
      <div><b>{line.title}</b></div>
      {line.detail && <div>{line.detail}</div>}
      <div className="muted">{line.id}</div>
      {line.steps && <details><summary>{line.steps.length} steps</summary><table><tbody>{line.steps.map((step, index) => <tr key={index}>
        <td>{time(step.at)}</td><td>{step.by}</td><td>{step.kind}</td><td>{step.text}</td>
      </tr>)}</tbody></table></details>}
      <Json label="row" value={line.raw} />
    </td>
    <td><Links links={line.links} /></td>
  </tr>
}

export default async function OrderTracePage({ params }: { params: Promise<{ orderId: string }> }) {
  guardDevPage()
  const { orderId } = await params
  const engine = await getEngine()
  const state = await engine.state()
  const order = findOrder(state.orders, decodeURIComponent(orderId))
  if (!order) notFound()
  const trace = await orderTrace({ order, snapshotAt: state.snapshotAt, store: getStore(), traces: getTraceStore() })
  const count = (kind: TraceLine["kind"]) => trace.lines.filter((line) => line.kind === kind).length
  return <main className="dev">
    <style>{CSS}</style>
    <h1>Order trace: {order.reference}</h1>
    <p className="muted">For engineers. Order {order.id}, {order.group}. {count("run")} runs, {count("finding")} findings in the current review, {count("proposal")} proposal events, {count("effect")} effects, {count("call")} calls, {count("mistake")} mistakes.</p>
    <p className="muted">Oldest first. Order events carry the demo clock, agent runs real time (UTC); a run sits at the latest demo time known to have passed when it started, and a line without real time follows what it came from. &quot;not traced&quot;: the row came before tracing, or no run was recorded.</p>
    <nav><a href="/dev/learning">Learning trace</a></nav>
    <h2>Timeline</h2>
    {trace.lines.length ? <div className="wrap"><table>
      <thead><tr><th>time</th><th>kind</th><th>what</th><th>from / opens</th></tr></thead>
      <tbody>{trace.lines.map((line) => <Line key={line.id} line={line} />)}</tbody>
    </table></div> : <p className="muted">Nothing on this order yet.</p>}
  </main>
}
