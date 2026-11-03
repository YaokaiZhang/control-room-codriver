"use client"

import Link from "next/link"
import { use, useEffect, useState } from "react"
import type { EntityKind, EntityList, EntityView } from "@/lib/present/types"
import { OrderTile } from "./card"
import { Icon } from "./icons"
import { Shell, type Section } from "./shell"
import { Empty, FactList, SectionHead } from "./ui"

const SECTION: Record<EntityKind, Section> = { driver: "drivers", customer: "customers", site: "sites" }
const INDEX: Record<EntityKind, { href: string; label: string; noun: string }> = {
  driver: { href: "/drivers", label: "Drivers", noun: "driver" },
  customer: { href: "/customers", label: "Customers", noun: "customer" },
  site: { href: "/sites", label: "Places", noun: "place" },
}

export function EntityPage({ kind, params }: { kind: EntityKind; params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const [view, setView] = useState<EntityView | null>(null)
  const [error, setError] = useState("")
  useEffect(() => {
    const controller = new AbortController()
    fetch(`/api/entities/${kind}/${encodeURIComponent(id)}`, { signal: controller.signal })
      .then((response) => { if (!response.ok) throw new Error(response.status === 404 ? `${INDEX[kind].label.slice(0, -1)} not found` : "Could not load record"); return response.json() as Promise<EntityView> })
      .then((data) => { setView(data); setError("") })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load record") })
    return () => controller.abort()
  }, [kind, id])
  useEffect(() => { if (view) document.title = `${view.title} · Control Room` }, [view])
  const index = INDEX[kind]
  return <Shell section={SECTION[kind]} snapshotAt={view?.snapshotAt ?? null}><main className="page">
    <nav className="crumbs" aria-label="Breadcrumb"><Link href={index.href}>{index.label}</Link><span>/</span><span>{view?.title ?? id}</span></nav>
    {error && <div className="state" role="alert"><h1 className="display">{error}</h1><p>The record could not be opened. <Link className="name-link" href={index.href}>Back to {index.label.toLowerCase()}</Link></p></div>}
    {!error && !view && <p className="queue-note" aria-busy="true">Loading…</p>}
    {view && <>
      <header className="entity-head">
        <h1 className="display">{view.title}</h1>
        {view.subtitle && <p className="entity-intro">{view.subtitle}</p>}
      </header>
      <div className="entity-facts"><FactList facts={view.facts} /></div>
      {view.links.length > 0 && <div className="links">{view.links.map((link) => <Link className="link-pill" href={link.href} key={link.href} title={link.hint ?? undefined}><Icon name={kind === "customer" ? "building" : "people"} size={14} />{link.label}</Link>)}</div>}
      {view.notes.map((note) => <p className="note-text" key={note}>{note}</p>)}
      <section className="sec">
        <SectionHead title="Orders" count={view.cards.length} />
        {view.cards.length === 0 && <Empty>No orders for this {index.noun}.</Empty>}
        <ul className="cards">{view.cards.map((card) => <li key={card.id}>
          {view.roles[card.id] && <p className="card-role">{view.roles[card.id]}</p>}
          <OrderTile card={card} />
        </li>)}</ul>
      </section>
    </>}
  </main></Shell>
}

export function EntityIndex({ kind }: { kind: EntityKind }) {
  const [list, setList] = useState<EntityList | null>(null)
  const [error, setError] = useState("")
  const [query, setQuery] = useState("")
  useEffect(() => {
    const controller = new AbortController()
    fetch(`/api/entities/${kind}`, { signal: controller.signal })
      .then((response) => { if (!response.ok) throw new Error("Could not load the list"); return response.json() as Promise<EntityList> })
      .then((data) => { setList(data); setError("") })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load the list") })
    return () => controller.abort()
  }, [kind])
  const index = INDEX[kind]
  const needle = query.trim().toLowerCase()
  const items = (list?.items ?? []).filter((item) => !needle || item.title.toLowerCase().includes(needle) || (item.subtitle ?? "").toLowerCase().includes(needle))
  return <Shell section={SECTION[kind]}><main className="page">
    <header className="entity-head">
      <h1 className="display">{index.label}</h1>
    </header>
    <div className="index-tools"><label className="field"><span className="sr-only">Filter {index.label.toLowerCase()}</span><Icon name="search" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Filter ${list ? list.items.length : ""} ${index.label.toLowerCase()} by name or place`} /></label></div>
    {error && <p className="queue-error" role="alert">{error}.</p>}
    {list && items.length === 0 && <p className="empty">Nothing matches “{query}”.</p>}
    <div className="index">{items.map((item) => <div className="index-row" key={item.id}>
      <div><Link href={item.href}>{item.title}</Link>{item.subtitle && <small>{item.subtitle}</small>}</div>
      <span className="index-count">{item.count ? <><b>{item.count}</b> {item.count === 1 ? "order" : "orders"}</> : ""}</span>
    </div>)}</div>
  </main></Shell>
}
