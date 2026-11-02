"use client"

import type { Group, PlannedAction, RuleResult, SourceRef } from "@/lib/engine/checks"
import type { OrderChecks, Tone } from "@/lib/present/types"
import { Icon } from "./icons"
import { CallsBlock } from "./calls"
import { CloseButton } from "./close"
import { EffectsBlock } from "./effects"
import { CompactProposals, ProposalsBlock } from "./proposals"
import { PublishingBlock } from "./publishing"
import { ReviewBlock } from "./review"
import { More, Pill } from "./ui"

export const GROUP_LABEL: Record<Group, string> = {
  needs_action: "Blocked", in_progress: "In progress", solved: "Fixed, review it", normal: "Normal", done: "Finished",
}

export function groupTone(group: Group, urgent = false): Tone {
  return group === "needs_action" ? (urgent ? "danger" : "warn") : group === "in_progress" || group === "solved" ? "accent" : group === "done" ? "ok" : "neutral"
}

export function GroupPill({ group, urgent = false }: { group: Group; urgent?: boolean }) {
  return <Pill tone={groupTone(group, urgent)}>{group === "normal" ? <><Icon name="check" size={13} />Checked · Normal</> : GROUP_LABEL[group]}</Pill>
}

/** The folded record section on the order page that holds each collection. */
const SECTION: Record<string, string> = {
  order_endpoint_details: "route", time_windows: "route", sites: "route", transport_points: "route", endpoint_claims: "route", tracking_observations: "route",
  alerts: "work", work_items: "work", incidents: "work",
  work_assignments: "drivers",
  travel_reservations: "travel",
  expenses: "costs",
  documents: "evidence-details", proofs: "evidence-details", custody_assets: "evidence-details",
  agent_proposals: "proposals",
  conversations: "conversations",
}

export function sourceHref(orderId: string, source: SourceRef, samePage: boolean): string {
  const anchor = SECTION[source.collection] ?? "records"
  return samePage ? `#${anchor}` : `/orders/${encodeURIComponent(orderId)}#${anchor}`
}

function Sources({ orderId, sources, samePage }: { orderId: string; sources: SourceRef[]; samePage: boolean }) {
  if (!sources.length) return null
  // Records the operator can close here (a finished order's open records): one row each, with its button.
  if (sources.every((source) => source.close)) return <ul className="close-list">{sources.map((source) => <li key={`${source.collection}-${source.id}`}>
    <a className="source-link" href={sourceHref(orderId, source, samePage)} title={`${source.collection} ${source.id}`}>{source.label}</a>
    <CloseButton orderId={orderId} record={{ collection: source.collection, recordId: source.id }} verb={source.close!} />
  </li>)}</ul>
  return <span className="check-sources">{sources.map((source) => <a key={`${source.collection}-${source.id}`} className="source-link"
    href={sourceHref(orderId, source, samePage)} title={source.id}>{source.label}</a>)}</span>
}

const OUTCOME_ICON = { fail: "alert", unknown: "note", pass: "check" } as const

function RuleItem({ orderId, rule, samePage }: { orderId: string; rule: RuleResult; samePage: boolean }) {
  const tone: Tone = rule.outcome === "fail" ? (rule.firstAction === "show_person" || rule.firstAction === "operator_proposal" ? "danger" : "warn") : rule.outcome === "pass" ? "ok" : "neutral"
  return <li className="check" id={`rule-${rule.id}`}>
    <Icon name={OUTCOME_ICON[rule.outcome]} className={`tone-${tone}`} />
    <div>
      <div className="check-title">{rule.title}</div>
      {!rule.sources.some((source) => source.close) && <div className="check-detail">{rule.detail}</div>}
      <Sources orderId={orderId} sources={rule.sources} samePage={samePage} />
    </div>
  </li>
}

function plannedText(action: PlannedAction): string {
  if (action.kind === "reviewer_pass") return "Reviewer pass"
  const who = action.callee ? action.callee.name ?? action.callee.handle : null
  return action.kind === "site_call" ? `Site call to ${who ?? "the pickup site"}` : "Driver call"
}

/**
 * What the engine checked on one order: its group and why, planned agent work, and each rule with its source records.
 * `led`: the situation card above already says what is wrong and what to do, so the head only counts the checks.
 */
export function ChecksPanel({ orderId, checks, compact = false, led = false }: { orderId: string; checks: OrderChecks; compact?: boolean; led?: boolean }) {
  const samePage = !compact
  // Urgency ranks Blocked; on other groups it would read as a second verdict.
  const urgent = checks.group === "needs_action" && checks.urgency.urgent
  const failed = checks.rules.filter((rule) => rule.outcome === "fail")
  const unknown = checks.rules.filter((rule) => rule.outcome === "unknown")
  const passed = checks.rules.filter((rule) => rule.outcome === "pass")
  const list = (rules: RuleResult[]) => <ul className="checks-list">{rules.map((rule) => <RuleItem key={rule.id} orderId={orderId} rule={rule} samePage={samePage} />)}</ul>
  return <section className={`checks${compact ? " checks-compact" : ""}`} id="checks" aria-label="What the system checked">
    <div className="checks-head">
      <h2 className="checks-title">Checks</h2>
      {!led && <GroupPill group={checks.group} urgent={urgent} />}
    </div>
    {!led && <p className={`checks-reason tone-${groupTone(checks.group, urgent)}`}>{checks.reason}</p>}
    {checks.publication && <PublishingBlock orderId={orderId} publication={checks.publication} group={checks.group} calls={checks.calls ?? []} bare={compact} />}
    {checks.planned.length > 0 && <div className="checks-block">
      <h3>Planned</h3>
      <ul className="checks-list">{checks.planned.map((action) => <li className="check" key={action.kind}>
        <Icon name={action.kind === "reviewer_pass" ? "bot" : "phone"} className="tone-accent" />
        <div className="check-title">{plannedText(action)}</div>
      </li>)}</ul>
    </div>}
    {/* In the queue preview, what a yes means comes first. */}
    {compact && <CompactProposals orderId={orderId} proposals={checks.proposals ?? []} />}
    <CallsBlock orderId={orderId} calls={checks.calls} lines={checks.callLines} blocked={checks.blockedCalls} compact={compact} />
    {!compact && <ProposalsBlock orderId={orderId} proposals={checks.proposals ?? []} />}
    {!compact && <EffectsBlock effects={checks.effects ?? []} history={checks.history ?? []} />}
    {checks.review && <ReviewBlock orderId={orderId} review={checks.review} compact={compact}
      shown={new Set((checks.proposals ?? []).map((proposal) => proposal.findingId).filter((id): id is string => !!id))} />}
    {failed.length > 0 && <div className="checks-block"><h3>Didn&apos;t pass</h3>{list(failed)}</div>}
    {unknown.length > 0 && (led
      ? <More label={`Couldn't check (${unknown.length})`}>{list(unknown)}</More>
      : <div className="checks-block"><h3>Couldn&apos;t check</h3>{list(unknown)}</div>)}
    {passed.length > 0 && <More label={`Passed (${passed.length})`}>{list(passed)}</More>}
  </section>
}
