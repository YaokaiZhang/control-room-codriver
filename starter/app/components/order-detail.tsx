"use client"

import { useEffect } from "react"
import { applyPlain, situationFor } from "@/lib/present/situation"
import type { OrderChecks, RecordView } from "@/lib/present/types"
import { dueText, SituationCard } from "./situation"
import { ChecksPanel } from "./checks"
import { CitedProvider } from "./review"
import { KeyDates, RecordHero } from "./record/header"
import { RecordsPanel } from "./record/records"
import { TravelPlanSection } from "./travel-plan"
import { ActivitySection, ConversationsSection, DecisionsSection, EvidenceSection, RouteSection } from "./record/sections"
import { OpenItems } from "./ui"
import { withPublication } from "@/lib/present/market"

export type Detail = { order: { id: string; reference: string }; view: RecordView; checks: OrderChecks | null }

/** A check's source link points at a folded record section: open it and bring it into view. */
function useOpenLinkedSection() {
  useEffect(() => {
    const open = () => {
      const id = decodeURIComponent(window.location.hash.slice(1))
      const target = id ? document.getElementById(id) : null
      if (!target) return
      if (target instanceof HTMLDetailsElement) target.open = true
      // A cited record inside a folded section: open every fold around it.
      for (let parent = target.parentElement; parent; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true
      target.scrollIntoView({ block: target.id.startsWith("rec-") ? "center" : "start" })
    }
    open()
    window.addEventListener("hashchange", open)
    return () => window.removeEventListener("hashchange", open)
  }, [])
}

export function OrderPane({ detail }: { detail: Detail }) {
  const { checks } = detail
  const view = withPublication(detail.view, checks?.publication)
  useOpenLinkedSection()
  const code = checks ? situationFor(checks) : null
  const situation = code && applyPlain(code, checks?.plain)
  return <CitedProvider ids={checks?.review?.highlights ?? []}>
    <RecordHero view={view} lead={situation && <SituationCard orderId={detail.order.id} situation={situation} samePage lead
      due={checks?.group === "needs_action" ? dueText(checks.urgency.dueAt, checks.now) : null} urgent={checks?.group === "needs_action" && checks.urgency.urgent} />} />
    {checks && <ChecksPanel orderId={detail.order.id} checks={checks} led={!!situation} />}
    <div className={view.attention.length ? "panel" : "panel-quiet"} id="attention"><OpenItems view={view} /></div>
    <KeyDates tiles={view.tiles} />
    <RouteSection view={view} />
    <ConversationsSection view={view} />
    <EvidenceSection view={view} />
    <DecisionsSection view={view} />
    <ActivitySection view={view} />
    <RecordsPanel view={view} orderId={detail.order.id} />
    {checks?.publication && <TravelPlanSection publication={checks.publication} />}
  </CitedProvider>
}
