"use client"

// The Briefing inbox (ticket 13), styled like the support inbox: digests at 09:00,
// 12:00 and 16:00 on the demo clock and urgent pushes, newest first. Every count
// comes from the rule checks; the model only writes the opener and first move.
// Each order a digest or push names shows as the board's situation card, as it stands now.
// A new lesson links to the Lessons section of the Rules page, where the operator decides.

import Link from "next/link"
import { useCallback, useEffect, useMemo, useState } from "react"
import type { DigestItem, LessonItem, PushItem } from "@/lib/engine/engine"
import type { Group } from "@/lib/engine/checks"
import type { BoardCard, BriefingView } from "@/lib/present/types"
import { fmtDateTime } from "@/lib/present/time"
import { BRIEFING_EVENT, itemSummary, Prose, urgentBlocked } from "../components/briefing"
import { GROUP_LABEL } from "../components/checks"
import { useClockVersion } from "../components/demo-clock"
import { Icon } from "../components/icons"
import { Shell } from "../components/shell"
import { dueText, SituationCard } from "../components/situation"
import { More } from "../components/ui"
import { useOverview } from "../components/use-overview"

const time = (iso: string) => new Date(iso).toISOString().slice(11, 16)
const stamp = (iso: string) => `${fmtDateTime(iso, null, false)} UTC`

const PUSH_LABEL: Record<PushItem["reason"], string> = {
  action_due: "action due within 2 h", promise_at_risk: "promise at risk today", pickup_unready: "pickup not ready", handover: "handover",
}

export default function BriefingPage() {
  const [view, setView] = useState<BriefingView | null>(null)
  const [error, setError] = useState("")
  const [selected, setSelected] = useState<string | null>(null)
  const [showList, setShowList] = useState(true)
  const clockVersion = useClockVersion()
  // The orders as the board reads them, for the situation cards.
  const { overview } = useOverview("")
  const cards = useMemo(() => new Map((overview?.visible ?? []).map((card) => [card.id, card])), [overview])
  const now = overview?.now ?? null

  useEffect(() => {
    const controller = new AbortController()
    fetch("/api/briefing", { signal: controller.signal })
      .then((response) => { if (!response.ok) throw new Error("Could not load the Briefing"); return response.json() as Promise<BriefingView> })
      .then((data) => {
        setView(data)
        setError("")
        setSelected((current) => {
          const wanted = decodeURIComponent(window.location.hash.replace(/^#/, ""))
          if (current && data.items.some((item) => item.id === current)) return current
          return (data.items.find((item) => item.id === wanted) ?? data.items[0])?.id ?? null
        })
      })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load the Briefing") })
    return () => controller.abort()
  }, [clockVersion])

  const markRead = useCallback(async (ids?: string[]) => {
    const response = await fetch("/api/briefing", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "read", ids }) })
    if (!response.ok) return
    setView(await response.json() as BriefingView)
    window.dispatchEvent(new Event(BRIEFING_EVENT))
  }, [])

  const item = useMemo(() => view?.items.find((entry) => entry.id === selected) ?? null, [view, selected])

  // Opening an item reads it.
  useEffect(() => {
    if (item && !item.read) void markRead([item.id])
  }, [item, markRead])

  const choose = (id: string) => {
    setSelected(id)
    setShowList(false)
    window.history.replaceState(null, "", `#${encodeURIComponent(id)}`)
  }

  return <Shell section="briefing" fixed snapshotAt={view?.snapshotAt ?? null}><main className={`mailbox${showList ? "" : " reading"}`}>
    <section className="mail-list" aria-label="Briefing items">
      <header className="mail-list-head">
        <h1 className="display">Briefing</h1>
        {view && view.unread > 0 && <p>{view.unread} unread · <button type="button" className="btn-link" onClick={() => markRead()}>Mark all read</button></p>}
      </header>
      {error && <p className="queue-error" role="alert">{error}.</p>}
      {view && !view.items.length && <p className="empty">The first digest arrives at 09:00.</p>}
      <ul className="mail-rows">{view?.items.map((entry) => <li key={entry.id}>
        <button type="button" className={`mail-row${entry.read ? "" : " unread"}`} onClick={() => choose(entry.id)} aria-current={entry.id === selected ? "true" : undefined}>
          <span className="mail-row-top">
            <span className="mail-row-who">{!entry.read && <span className="unread-dot" aria-label="Unread" />}{entry.kind === "push" ? `${entry.reference} · ${PUSH_LABEL[entry.reason]}` : entry.title}</span>
            <span className="mail-row-when">{time(entry.at)}</span>
          </span>
          <span className="mail-row-preview">{entry.kind === "push" ? (cards.get(entry.orderId)?.situation?.headline ?? entry.text) : itemSummary(entry)}</span>
        </button>
      </li>)}</ul>
    </section>
    <section className="mail-read" aria-label="Briefing item">
      {!view && !error && <p className="empty">Loading…</p>}
      {view && view.items.length > 0 && !item && <p className="empty">Choose an item.</p>}
      {item && <article>
        <button type="button" className="mail-back btn btn-tertiary btn-s" onClick={() => setShowList(true)}><Icon name="chevron" size={13} style={{ transform: "rotate(180deg)" }} /> All items</button>
        {item.kind === "digest" ? <Digest item={item} cards={cards} now={now} />
          : item.kind === "lesson" ? <Lesson item={item} />
          : <Push item={item} card={cards.get(item.orderId) ?? null} now={now} />}
      </article>}
    </section>
  </main></Shell>
}

function OrderRef({ orderId, reference }: { orderId: string; reference: string }) {
  return <Link className="ref-link" href={`/orders/${encodeURIComponent(orderId)}`}>{reference}</Link>
}

/** The order's situation card as it stands now; a line when it is no longer Blocked. */
function OrderSituation({ orderId, reference, card, now }: { orderId: string; reference: string; card: BoardCard | null; now: string | null }) {
  if (card?.situation && card.verdict?.group === "needs_action") {
    return <SituationCard orderId={orderId} situation={card.situation} car={card.vehicle} reference={card.reference}
      due={dueText(card.verdict.dueAt, now)} urgent={card.verdict.urgent} />
  }
  const group = card?.verdict?.group
  return <p className="digest-gone"><OrderRef orderId={orderId} reference={reference} />{group ? ` is ${GROUP_LABEL[group].toLowerCase()} now.` : ""}</p>
}

const COUNT_TILES: { key: Group | "urgent"; label: string }[] = [
  { key: "needs_action", label: GROUP_LABEL.needs_action },
  { key: "urgent", label: `Urgent (of ${GROUP_LABEL.needs_action.toLowerCase()})` },
  { key: "in_progress", label: GROUP_LABEL.in_progress },
  { key: "solved", label: GROUP_LABEL.solved },
]

function Digest({ item, cards, now }: { item: DigestItem; cards: Map<string, BoardCard>; now: string | null }) {
  const { facts, prose } = item
  const changes = facts.changes
  const since = facts.since ? time(facts.since) : "the last digest"
  // The Urgent tile counts urgent Blocked orders only, so it reads as a part of Blocked.
  const count = (key: Group | "urgent") => key === "urgent" ? urgentBlocked(facts) : facts.counts[key]
  return <>
    <header className="mail-head">
      <h2>{item.title}</h2>
    </header>

    <dl className="digest-counts">{COUNT_TILES.filter((tile) => count(tile.key) > 0).map((tile) => <div key={tile.key} className={tile.key === "needs_action" || tile.key === "urgent" ? "tone-danger" : ""}>
      <dt>{tile.label}</dt><dd>{count(tile.key)}</dd>
    </div>)}</dl>

    <p className="digest-prose"><Prose segments={prose.opener} /></p>
    <p className="digest-move"><Icon name="arrow" size={15} /><span><Prose segments={prose.firstMove} /></span></p>

    {changes && (changes.newNeedsAction.length > 0 || changes.leftNeedsAction.length > 0 || changes.cameDue.length > 0) && <dl className="digest-changes">
      {changes.newNeedsAction.length > 0 && <div><dt>Newly blocked since {since}</dt><dd>{changes.newNeedsAction.map((row, index) => <span key={row.orderId}>{index ? ", " : ""}<OrderRef {...row} /></span>)}</dd></div>}
      {changes.leftNeedsAction.length > 0 && <div><dt>No longer blocked</dt><dd>{changes.leftNeedsAction.map((row, index) => <span key={row.orderId}>{index ? ", " : ""}<OrderRef {...row} /></span>)}</dd></div>}
      {changes.cameDue.length > 0 && <div><dt>Came due</dt><dd>{changes.cameDue.map((row, index) => <span key={`${row.title}-${row.reference}-${index}`}>{index ? ", " : ""}{row.title}{row.orderId && row.reference ? <> on <OrderRef orderId={row.orderId} reference={row.reference} /></> : null} at {time(row.at)}</span>)}</dd></div>}
    </dl>}

    <section className="digest-block" aria-label={GROUP_LABEL.needs_action}>
      <h3>{GROUP_LABEL.needs_action}</h3>
      {facts.needsAction.length ? <ol className="digest-sits">{facts.needsAction.map((line) => <li key={line.orderId}>
        <OrderSituation orderId={line.orderId} reference={line.reference} card={cards.get(line.orderId) ?? null} now={now} />
      </li>)}</ol> : <p className="empty-line">Nothing needs you.</p>}
    </section>

    {facts.needsActionBy.length > 0 && <More label="Blocked, by cause">
      <ul className="digest-causes">{facts.needsActionBy.map((cause) => <li key={cause.label}><span>{cause.label}</span><b>{cause.count}</b></li>)}</ul>
    </More>}
  </>
}

function Push({ item, card, now }: { item: PushItem; card: BoardCard | null; now: string | null }) {
  return <>
    <header className="mail-head">
      <h2>{item.title}</h2>
      <p className="mail-meta">{stamp(item.at)} · {PUSH_LABEL[item.reason]}{item.dueAt ? ` · deadline ${fmtDateTime(item.dueAt)}` : ""}</p>
    </header>
    <p className="digest-prose">{item.text}</p>
    <div className="push-card"><OrderSituation orderId={item.orderId} reference={item.reference} card={card} now={now} /></div>
  </>
}

const AGENT_LABEL: Record<string, string> = { reviewer: "Reviewer", "plain-words": "Card wording" }

function Lesson({ item }: { item: LessonItem }) {
  return <>
    <header className="mail-head">
      <h2>{item.title}</h2>
      <p className="mail-meta">{stamp(item.at)} · {AGENT_LABEL[item.agent] ?? item.agent}</p>
    </header>
    <blockquote className="lesson-text">{item.text}</blockquote>
    <p className="digest-move"><Icon name="arrow" size={15} /><Link className="ref-link" href={item.href}>Read it and decide on the Rules page</Link></p>
  </>
}
