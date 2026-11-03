"use client"

import Link from "next/link"
import { useEffect, useRef, useState, type PointerEvent } from "react"
import type { AgentStatus } from "@/app/api/agent-status/route"
import { GROUP_LABEL, groupTone } from "./checks"
import { useClockVersion } from "./demo-clock"
import { useHighlights } from "./highlights"

/** How often the avatar re-reads the agent's status (ms). */
const POLL_MS = 5000
const SIZE = 72
const MARGIN = 12
/** Room kept under the avatar for its "working..." or approval note. */
const LABEL_ROOM = 40
const STORAGE_KEY = "agent-avatar-position"

type Point = { x: number; y: number }

/** The agent's status over the highlighted orders; null until the first answer. */
function useAgentStatus(ids: string[]): AgentStatus | null {
  const [status, setStatus] = useState<AgentStatus | null>(null)
  const clockVersion = useClockVersion()
  const key = ids.join(",")
  useEffect(() => {
    let stopped = false
    const read = () => fetch(`/api/agent-status?ids=${encodeURIComponent(key)}`)
      .then((response) => response.ok ? response.json() as Promise<AgentStatus> : null)
      .then((data) => { if (!stopped && data) setStatus(data) })
      .catch(() => {})
    read()
    const timer = setInterval(read, POLL_MS)
    return () => { stopped = true; clearInterval(timer) }
  }, [key, clockVersion])
  return status
}

const clamp = (point: Point): Point => ({
  x: Math.min(Math.max(point.x, MARGIN), window.innerWidth - SIZE - MARGIN),
  y: Math.min(Math.max(point.y, MARGIN), window.innerHeight - SIZE - LABEL_ROOM),
})

/**
 * The agent as a floating avatar the operator can drag anywhere; the spot is remembered.
 * It follows only the orders the operator highlighted: animated with "working..." while any
 * of them is In progress; still otherwise, with a red dot counting the highlighted Solved
 * orders waiting for the operator's yes. A click (not a drag) opens the list of those orders.
 */
export function AgentAvatar() {
  const highlights = useHighlights()
  const status = useAgentStatus(highlights)
  const [position, setPosition] = useState<Point | null>(null)
  const [open, setOpen] = useState(false)
  const drag = useRef<{ dx: number; dy: number; startX: number; startY: number; moved: boolean } | null>(null)
  const [dragging, setDragging] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let saved: Point | null = null
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") } catch {}
    setPosition(clamp(saved ?? { x: 24, y: window.innerHeight - SIZE - LABEL_ROOM - 12 }))
    const onResize = () => setPosition((current) => current && clamp(current))
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener("pointerdown", close)
    document.addEventListener("keydown", close)
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", close) }
  }, [open])

  if (!position) return null

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { dx: event.clientX - position.x, dy: event.clientY - position.y, startX: event.clientX, startY: event.clientY, moved: false }
  }
  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const current = drag.current
    if (!current) return
    if (!current.moved && Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < 4) return
    if (!current.moved) setDragging(true)
    current.moved = true
    setPosition(clamp({ x: event.clientX - current.dx, y: event.clientY - current.dy }))
  }
  const onPointerUp = () => {
    const current = drag.current
    drag.current = null
    setDragging(false)
    if (!current) return
    if (current.moved) localStorage.setItem(STORAGE_KEY, JSON.stringify(position))
    else setOpen((value) => !value)
  }

  // A highlight taken off counts at once, before the next answer arrives.
  const tasks = (status?.orders ?? []).filter((task) => highlights.includes(task.id))
  const working = tasks.some((task) => task.group === "in_progress")
  const waiting = working ? 0 : tasks.filter((task) => task.group === "solved").length
  const doneText = `${waiting} done, waiting for you`
  const label = !highlights.length ? "Agent: no highlighted orders" : working ? "Agent: working" : waiting > 0 ? `Agent: ${doneText}` : "Agent: idle"

  // The list opens on the side of the avatar with more room.
  const below = position.y < window.innerHeight / 2
  const right = position.x < window.innerWidth / 2
  const panelStyle = {
    ...(below ? { top: SIZE + LABEL_ROOM } : { bottom: SIZE + 12 }),
    ...(right ? { left: 0 } : { right: 0 }),
  }

  return <div ref={root} className="agent-avatar-root" style={{ left: position.x, top: position.y }}>
    <button
      type="button"
      className={`agent-avatar${working ? " is-working" : ""}${dragging ? " is-dragging" : ""}`}
      aria-label={`${label}. Drag to move, click for the highlighted orders`}
      aria-expanded={open}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => { drag.current = null; setDragging(false) }}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setOpen((value) => !value) } }}
    >
      {/* Two files: CSS animations inside an SVG <img> can't be paused from the page. */}
      <img src={working ? "/agent-avatar.svg" : "/agent-avatar-static.svg"} alt="" width={SIZE} height={SIZE} draggable={false} />
      {working && <span className="agent-avatar-working" aria-hidden>working<span>.</span><span>.</span><span>.</span></span>}
      {waiting > 0 && <>
        <span className="agent-avatar-dot" aria-hidden>{waiting}</span>
        {!open && <span className="agent-avatar-note" aria-hidden>{doneText}</span>}
      </>}
    </button>
    {open && <section className="agent-tasks" style={panelStyle} aria-label="Highlighted orders">
      <header><b>Highlighted orders</b><span>{tasks.length}</span></header>
      {!highlights.length && <p className="agent-tasks-empty">Highlight an order on its page or in the board preview, and the agent's work on it shows here.</p>}
      {highlights.length > 0 && !status && <p className="agent-tasks-empty">Loading…</p>}
      {tasks.length > 0 && <ul>{tasks.map((task) => <li key={task.id}>
        <Link href={`/orders/${task.id}`} onClick={() => setOpen(false)}>
          <span className="agent-task-top">
            <b>{task.vehicle}</b>
            <span className={`state-tag tone-${groupTone(task.group)}`}>{task.group === "in_progress" ? "Working" : GROUP_LABEL[task.group]}</span>
          </span>
          <span className="agent-task-meta">{task.reference}{task.route ? ` · ${task.route}` : ""}</span>
          <span className="agent-task-text">{task.text}</span>
        </Link>
      </li>)}</ul>}
    </section>}
  </div>
}
