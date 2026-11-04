"use client"

// The demo clock in the shell (ticket 04). The Operator sees demo time and a
// demo-only menu: +15 min, next due item, reset. Every move announces what came
// due and fires CLOCK_EVENT so pages re-read the engine (`useClockVersion`).

import Link from "next/link"
import { useCallback, useEffect, useRef, useState } from "react"
import type { DueItem } from "@/lib/engine/due"
import type { ClockAction, ClockView } from "@/lib/present/types"
import { fmtClock, fmtDateTime, fmtDeskClock } from "@/lib/present/time"
import { Icon } from "./icons"

export const CLOCK_EVENT = "control-room:clock"

/** A number that changes whenever the demo clock moves; add it to a fetch effect's deps. */
export function useClockVersion(): number {
  const [version, setVersion] = useState(0)
  useEffect(() => {
    const bump = () => setVersion((value) => value + 1)
    window.addEventListener(CLOCK_EVENT, bump)
    return () => window.removeEventListener(CLOCK_EVENT, bump)
  }, [])
  return version
}

const time = (iso: string) => fmtClock(iso)
const stamp = (iso: string) => fmtDateTime(iso)

function DueList({ items }: { items: DueItem[] }) {
  return <ul className="demo-due">
    {items.map((item) => <li key={item.id}>
      <Icon name="waiting" size={14} />
      <span>{item.kind === "digest" ? <Link className="ref-link" href="/briefing">{item.title}</Link> : item.title}{item.orderId && item.reference ? <> on <Link className="ref-link" href={`/orders/${item.orderId}`}>{item.reference}</Link></> : null}{item.detail ? <em>{item.detail}</em> : null}</span>
    </li>)}
  </ul>
}

type Result = { text: string; items: DueItem[] } | null

/** The bar's clock. Non-operators (who cannot reach /api/clock) see the snapshot line only. */
export function DemoClock({ operator, snapshotAt }: { operator: boolean; snapshotAt?: string | null }) {
  const [clock, setClock] = useState<ClockView | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<Result>(null)
  const [error, setError] = useState("")
  const [confirmReset, setConfirmReset] = useState(false)
  const menu = useRef<HTMLDetailsElement>(null)

  useEffect(() => {
    if (!operator) return
    const controller = new AbortController()
    fetch("/api/clock", { signal: controller.signal })
      .then((response) => response.ok ? response.json() as Promise<ClockView> : null)
      .then((data) => { if (data) setClock(data) })
      .catch(() => {})
    const sync = () => fetch("/api/clock").then((response) => response.ok ? response.json() as Promise<ClockView> : null).then((data) => { if (data) setClock(data) }).catch(() => {})
    window.addEventListener(CLOCK_EVENT, sync)
    return () => { controller.abort(); window.removeEventListener(CLOCK_EVENT, sync) }
  }, [operator])

  useEffect(() => {
    const close = (event: MouseEvent | KeyboardEvent) => {
      const el = menu.current
      if (!el?.open) return
      // The path, not `contains`: a click that re-renders the menu detaches its own target.
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !event.composedPath().includes(el)) { el.open = false; setConfirmReset(false) }
    }
    document.addEventListener("click", close)
    document.addEventListener("keydown", close)
    return () => { document.removeEventListener("click", close); document.removeEventListener("keydown", close) }
  }, [])

  const move = useCallback(async (action: ClockAction) => {
    setBusy(true)
    setError("")
    setConfirmReset(false)
    try {
      const response = await fetch("/api/clock", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) })
      const data = await response.json() as ClockView & { error?: string }
      if (!response.ok) throw new Error(data.error ?? "The clock did not move")
      setClock(data)
      const became = data.became ?? []
      setResult(action === "reset"
        ? { text: `Reset to ${fmtDeskClock(data.now)}. Our state is cleared; the snapshot is unchanged.`, items: [] }
        : { text: `Moved to ${fmtDeskClock(data.now)}. ${became.length ? `${became.length === 1 ? "One item" : `${became.length} items`} came due:` : "Nothing came due."}`, items: became })
      window.dispatchEvent(new Event(CLOCK_EVENT))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The clock did not move")
    } finally {
      setBusy(false)
    }
  }, [])

  if (!operator) {
    return <div className="clock">{snapshotAt
      ? <b>{stamp(snapshotAt)}</b>
      : <span>Fictional snapshot</span>}</div>
  }

  const now = clock?.now ?? snapshotAt ?? null
  const moved = !!clock && clock.now !== clock.snapshotAt
  return <details className="clock demo-clock" ref={menu}>
    <summary aria-label={now ? `Demo time ${stamp(now)}. Open demo controls` : "Open demo controls"}>
      <span className="demo-clock-text">
        <b><span className="demo-clock-long">{now ? stamp(now) : "Demo time"}</span><span className="demo-clock-short">{now ? `Demo ${time(now)}` : "Demo"}</span></b>
        {moved && <span>Moved from {time(clock.snapshotAt)}</span>}
      </span>
      <Icon name="chevron" size={12} className="persona-chevron" />
    </summary>
    <div className="demo-menu" role="group" aria-label="Demo controls">
      <div className="demo-head">
        <b>Demo controls</b>
        <span className="pill tone-neutral">Demo only</span>
      </div>
      <p className="demo-sub">Moves the demo clock. Next checks fire and Briefing digests arrive when it reaches them, and the rule checks re-run on every move. All data is fictional.</p>
      <div className="demo-actions">
        <button type="button" className="btn btn-tertiary btn-s" disabled={busy} onClick={() => move("advance")}>+15 min</button>
        <button type="button" className="btn btn-primary btn-s" disabled={busy || !clock?.nextDueAt} onClick={() => move("next")}>
          Next due item{clock?.nextDueAt ? ` · ${time(clock.nextDueAt)}` : ""}
        </button>
      </div>
      <div className="demo-status" aria-live="polite">
        {error && <p className="demo-error" role="alert">{error}</p>}
        {result && <><p>{result.text}</p>{result.items.length > 0 && <DueList items={result.items} />}</>}
      </div>
      <div className="demo-next">
        {clock?.nextDueAt
          ? <><p>Up next at {fmtDeskClock(clock.nextDueAt)}</p><DueList items={clock.upcoming} /></>
          : <p>Nothing else is due on the demo clock.</p>}
      </div>
      <div className="demo-reset">
        {confirmReset
          ? <><span>Clears all agent and approval state.</span>
            <button type="button" className="btn btn-primary btn-s" disabled={busy} onClick={() => move("reset")}>Reset to {clock ? time(clock.snapshotAt) : "start"}</button>
            <button type="button" className="btn-link" onClick={() => setConfirmReset(false)}>Cancel</button></>
          : <button type="button" className="btn-link" disabled={busy} onClick={() => setConfirmReset(true)}>Reset the demo…</button>}
      </div>
    </div>
  </details>
}
