"use client"

// The two order boards share one layout: a queue on the left, the selected order opened
// beside it. The preview carries the situation card with its steps and, under it, the
// evidence those steps act on (the proposal's script, the call, the rewrites, the checks),
// so a step can be taken without opening the whole record.
//   /       Needs action: Blocked, Fixed, review it, In progress;
//   /board  Overview: every order, one filter per stage.

import Link from "next/link"
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { applyPlain, situationFor } from "@/lib/present/situation"
import type { BoardCard, OrderChecks, RecordView } from "@/lib/present/types"
import { callsAreLive } from "./calls"
import { QueueCard } from "./card"
import { HighlightButton } from "./highlights"
import { ChecksPanel } from "./checks"
import { BoardSwitch, SearchField } from "./columns"
import { useClockVersion } from "./demo-clock"
import { Icon } from "./icons"
import { RouteSummary } from "./route-line"
import { Shell } from "./shell"
import { dueText, SituationCard } from "./situation"
import { CarPhoto, OpenItems, Pill, StagePill } from "./ui"
import { useOverview } from "./use-overview"
import { withPublication } from "@/lib/present/market"

export type QueueFilter = { key: string; label: string; empty: string; loud?: boolean }

type Props = {
  board: "attention" | "overview"
  filters: QueueFilter[]
  /** The filter an order falls under, or null when this board does not show it. */
  place: (card: BoardCard) => string | null
  sort: (a: BoardCard, b: BoardCard) => number
  /** Overview: each card carries its state tag. */
  tagged?: boolean
  /** Under the filters, above the queue (batch approval's toggle). */
  tools?: ReactNode
  /** Takes the preview's place while set (batch approval). */
  aside?: ReactNode
}

type Preview = { id: string; view: RecordView; checks: OrderChecks | null } | { id: string; error: string }

export function QueueBoard({ board, filters, place, sort, tagged = false, tools, aside }: Props) {
  const path = board === "attention" ? "/" : "/board"
  const [search, setSearch] = useState("")
  const [filter, setFilter] = useState(filters[0].key)
  const { overview, error } = useOverview(search)
  const [selected, setSelected] = useState<string | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const listRef = useRef<HTMLOListElement>(null)
  const clockVersion = useClockVersion()

  const by = useMemo(() => {
    const out = new Map<string, BoardCard[]>(filters.map((f) => [f.key, []]))
    for (const card of overview?.visible ?? []) out.get(place(card) ?? "")?.push(card)
    for (const cards of out.values()) cards.sort(sort)
    return out
  }, [overview, filters, place, sort])
  const queue = by.get(filter) ?? []
  // When the selected order leaves the queue (its records closed, say), the next one takes its place.
  const lastIndex = useRef(0)
  const current = queue.find((card) => card.id === selected) ?? queue[Math.min(lastIndex.current, queue.length - 1)] ?? null
  const currentId = current?.id ?? null
  const index = current ? queue.indexOf(current) : -1
  useEffect(() => { if (index >= 0) lastIndex.current = index }, [index])
  const now = overview?.now ?? null

  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get("order")
    if (wanted) setSelected(wanted)
  }, [])

  // An order asked for in the URL opens under its own filter.
  useEffect(() => {
    if (!selected || !overview) return
    const card = overview.visible.find((row) => row.id === selected)
    const key = card ? place(card) : null
    if (key && key !== filter && !queue.some((row) => row.id === selected)) setFilter(key)
    // Only when the order or the data changes, not when the operator picks a filter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, overview])

  // An order opened from a link is brought into view in the queue once.
  const revealed = useRef(false)
  useEffect(() => {
    if (revealed.current || !selected || !queue.some((row) => row.id === selected)) return
    revealed.current = true
    listRef.current?.querySelector(`[data-id="${CSS.escape(selected)}"]`)?.scrollIntoView({ block: "center" })
  }, [selected, queue])

  // The preview re-reads on clock moves and steps (CLOCK_EVENT), and every second and a half while a call runs.
  const [tick, setTick] = useState(0)
  const shown = preview && preview.id === currentId ? preview : null
  const live = !!shown && "view" in shown && callsAreLive(shown.checks?.calls, shown.checks?.callLines)
  useEffect(() => {
    if (!live) return
    const timer = setInterval(() => setTick((value) => value + 1), 1500)
    return () => clearInterval(timer)
  }, [live])

  useEffect(() => {
    if (!currentId) return
    const controller = new AbortController()
    fetch(`/api/orders/${encodeURIComponent(currentId)}`, { signal: controller.signal })
      .then((response) => { if (!response.ok) throw new Error("Could not load this order"); return response.json() as Promise<{ view: RecordView; checks: OrderChecks | null }> })
      .then((data) => setPreview({ id: currentId, view: data.view, checks: data.checks }))
      .catch((cause: unknown) => { if (!controller.signal.aborted) setPreview({ id: currentId, error: cause instanceof Error ? cause.message : "Could not load this order" }) })
    return () => controller.abort()
  }, [currentId, clockVersion, tick])

  const choose = useCallback((id: string) => {
    setSelected(id)
    window.history.replaceState(null, "", `${path}?order=${encodeURIComponent(id)}`)
  }, [path])

  const step = useCallback((delta: number) => {
    const next = queue[index + delta]
    if (!next) return
    choose(next.id)
    listRef.current?.querySelector(`[data-id="${CSS.escape(next.id)}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }, [queue, index, choose])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (target.closest("input, textarea, select, [role=menu]") || event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key === "j" || event.key === "ArrowDown") { event.preventDefault(); step(1) }
      if (event.key === "k" || event.key === "ArrowUp") { event.preventDefault(); step(-1) }
      if (event.key === "Enter" && currentId && !target.closest("a, button")) window.location.href = `/orders/${currentId}`
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [step, currentId])

  const active = filters.find((f) => f.key === filter) ?? filters[0]
  const elsewhere = search ? filters.filter((f) => f.key !== filter && (by.get(f.key)?.length ?? 0) > 0) : []

  return <Shell section="orders" fixed snapshotAt={overview?.snapshotAt ?? null}><main className={`home${aside ? " batching" : ""}`}>
    <section className="queue" aria-label="Order queue">
      <header className="queue-head">
        <h1 className="display">{active.label}</h1>
        <BoardSwitch current={board} />
      </header>
      <div className="queue-tools">
        <SearchField value={search} onChange={setSearch} />
        <div className="filters" role="group" aria-label="Show">
          {filters.map((f) => <button key={f.key} type="button" className={`filter${f.loud ? " need" : ""}`} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
            {f.label}{overview && <em>{by.get(f.key)?.length ?? 0}</em>}
          </button>)}
        </div>
        {tools}
      </div>
      {error && <p className="queue-error" role="alert">{error}. Check that the local database is running and seeded.</p>}
      <div className="queue-list">
        {!overview && !error && <ol aria-busy="true">{[0, 1, 2, 3].map((key) => <li className="qcard-skeleton" key={key} />)}</ol>}
        {overview && queue.length === 0 && <p className="queue-note">{search
          ? <>Nothing in {active.label} matches “{search}”.{elsewhere.map((f) => <span key={f.key}> <button type="button" className="btn-link" onClick={() => setFilter(f.key)}>{by.get(f.key)?.length} in {f.label}</button></span>)}</>
          : active.empty}</p>}
        {queue.length > 0 && <ol ref={listRef}>{queue.map((card) => <li key={card.id} data-id={card.id}>
          <QueueCard card={card} current={card.id === currentId} tagged={tagged} onSelect={choose}
            due={card.verdict?.group === "needs_action" ? dueText(card.verdict.dueAt, now) : null} />
        </li>)}</ol>}
      </div>
    </section>

    <section className="preview" aria-label={aside ? "Batch approval" : "Selected order"}>
      {aside}
      {!aside && !current && <div className="preview-empty">{!overview && !error && <b>Loading</b>}</div>}
      {!aside && current && !shown && <div className="preview-inner"><div className="photo" /><p className="queue-note">Loading {current.reference}…</p></div>}
      {!aside && shown && "error" in shown && <div className="preview-empty"><b>{shown.error}</b><Link className="btn btn-tertiary btn-s" href={`/orders/${shown.id}`}>Try the order page</Link></div>}
      {!aside && shown && "view" in shown && <OrderPreview key={shown.id} view={shown.view} checks={shown.checks}
        position={index + 1} total={queue.length} onNext={() => step(1)} />}
    </section>
  </main></Shell>
}

/** The selected order: who and where, what is wrong with its steps, then the evidence the steps act on. */
function OrderPreview({ view: record, checks, position, total, onNext }: { view: RecordView; checks: OrderChecks | null; position: number; total: number; onNext: () => void }) {
  const view = withPublication(record, checks?.publication)
  const { header, story } = view
  const code = checks ? situationFor(checks) : null
  const situation = code && applyPlain(code, checks?.plain)
  const problem = checks?.group === "needs_action"
  return <div className="preview-inner">
    <div className="preview-top">
      <CarPhoto view={view} sizes="(max-width: 1400px) 30vw, 420px" priority />
      <div className="preview-who">
        <div className="preview-pills">
          <StagePill lane={header.lane} label={header.laneLabel} />
          <Pill>{header.reference}</Pill>
          <Pill>{header.customer.name}</Pill>
          {header.vehicle?.plate && <Pill>{header.vehicle.plate}</Pill>}
          <HighlightButton orderId={header.id} />
        </div>
        <h2 className="display preview-title">{header.vehicle?.title ?? "Vehicle not linked"}</h2>
        <RouteSummary view={view} />
      </div>
    </div>
    {situation
      ? <SituationCard orderId={header.id} situation={situation} samePage lead
        due={problem ? dueText(checks.urgency.dueAt, checks.now) : null} urgent={problem && checks.urgency.urgent} />
      : <div className="preview-quiet">
        <p className={`preview-story tone-${story.tone}`}>{story.headline}</p>
        {story.detail && <p className="preview-detail">{story.detail}</p>}
      </div>}
    <div className="preview-body">
      {checks && <ChecksPanel orderId={header.id} checks={checks} compact led={!!situation} />}
      {view.attention.length > 0 && <div id="attention"><OpenItems view={view} /></div>}
    </div>
    <div className="preview-actions">
      <Link className="btn btn-tertiary btn-s" href={`/orders/${header.id}`}>Whole record <Icon name="arrow" /></Link>
      <button type="button" className="btn btn-quiet btn-s" onClick={onNext} disabled={position >= total}>Next</button>
      <span className="hint">{position} of {total} · <span className="kbd">J</span> <span className="kbd">K</span></span>
    </div>
  </div>
}
