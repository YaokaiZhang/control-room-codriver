"use client"

// Effect events on the order page (ticket 09): the committed changes laid over the
// snapshot, each with the version of the fact it wrote, what it supersedes and who
// committed it; then the order's whole history in sequence (finding, approval, call,
// answer, update approval, effect event).

import type { EffectEvent, EffectType, HistoryEntry } from "@/lib/engine/engine"
import { fmtDateTime } from "@/lib/present/time"
import { proposalEventText } from "./proposals"
import { recordAnchor } from "./review"
import { More, Pill } from "./ui"

const BY_LABEL: Record<string, string> = { agent: "Agent", policy: "Policy", operator: "Operator" }

// Kept here (not imported from lib/engine/effects.ts, which uses node:crypto) so the client bundle stays small.
const EFFECT_LABEL: Record<EffectType, string> = {
  contact_confirmed: "Contact confirmed", contact_changed: "Contact changed", window_changed: "Window changed",
  call_result_recorded: "Call result recorded", eta_reported: "ETA reported", customer_answer_recorded: "Customer answer recorded",
  operator_answer_recorded: "Operator answer recorded", cost_approved: "Cost approved", record_closed: "Record closed",
}

const LABELS = Object.values(EFFECT_LABEL)

/**
 * The change in plain words. Events stored before the line was shortened still carry the
 * label prefix, "Committed by …" and record ids; the card shows the label and actor already.
 */
export function plainEffectText(text: string): string {
  const label = LABELS.find((name) => text.startsWith(`${name}: `))
  const body = (label ? text.slice(label.length + 2) : text)
    .replace(/\.?\s*Committed by [^.]+\.\s*$/, "")
    .replace(/\s+[a-z]+-x[0-9a-f]{8,}\b/g, "")
  return body.charAt(0).toUpperCase() + body.slice(1)
}

/** The proposal title the engine puts before each of its history lines, read off its "proposed" line. */
function titlePrefix(entry: HistoryEntry, history: HistoryEntry[]): string | null {
  const proposed = history.find((row) => row.proposalId === entry.proposalId && row.kind === "proposed")
  if (!proposed || proposed === entry) return null
  let end = -1
  for (let i = 0; i < Math.min(proposed.text.length, entry.text.length) && proposed.text[i] === entry.text[i]; i++) {
    if (proposed.text.startsWith(": ", i)) end = i + 2
  }
  return end > 0 ? proposed.text.slice(0, end) : null
}

/** One history line without what its row or the line above already says. */
function historyText(entry: HistoryEntry, history: HistoryEntry[]): string {
  if (entry.kind === "effect") return plainEffectText(entry.text)
  const prefix = entry.proposalId ? titlePrefix(entry, history) : null
  return proposalEventText(prefix ? entry.text.slice(prefix.length) : entry.text)
}

export function EffectsBlock({ effects, history }: { effects: EffectEvent[]; history: HistoryEntry[] }) {
  if (!effects.length && !history.length) return null
  return <div className="checks-block" id="effects">
    {effects.length > 0 && <>
      <h3>Changes</h3>
      <ul className="effect-list">{effects.map((event) => <li key={event.id} className="effect" id={recordAnchor(event.id)}>
        <div className="effect-head">
          <Pill tone="ok">{EFFECT_LABEL[event.type]}</Pill>
          <span className="effect-at">{fmtDateTime(event.at)} · {BY_LABEL[event.by] ?? event.by}</span>
        </div>
        <p className="effect-text">{plainEffectText(event.text)}</p>
      </li>)}</ul>
    </>}
    {history.length > 0 && <More label="History">
      <ol className="proposal-history">{history.map((entry, i) => <li key={i} className={entry.kind === "effect" ? "is-effect" : undefined}>
        <span className="proposal-history-at">{fmtDateTime(entry.at)}</span>
        <span className="proposal-history-by">{BY_LABEL[entry.by] ?? entry.by} · {entry.kind === "effect" ? "change" : entry.kind}</span>
        <span className="proposal-history-text">{historyText(entry, history)}</span>
      </li>)}</ol>
    </More>}
  </div>
}
