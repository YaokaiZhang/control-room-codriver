"use client"

import type { RecordView } from "@/lib/present/types"
import { fmtDateTime, fmtRange } from "@/lib/present/time"
import { Icon } from "../icons"
import { FactList, More, Pill, When } from "../ui"

export function FactsPanel({ view }: { view: RecordView }) {
  return <section className="detail" aria-label="Order facts">
    <h3>Order facts</h3>
    <FactList facts={view.header.facts} />
    {view.header.tradeIn && <p className="entry-text">Trade-in on the same order: {view.header.tradeIn.title}{view.header.tradeIn.plate ? ` · ${view.header.tradeIn.plate}` : ""}. Its return leg has its own status.</p>}
  </section>
}

export function WorkPanel({ view }: { view: RecordView }) {
  const { alerts, workItems, incidents } = view
  const count = alerts.length + workItems.length + incidents.length
  return <section className="detail" id="work" aria-label="Alerts and work">
    <h3>Alerts and work <span className="count">{count || ""}</span></h3>
    {count === 0 && <p className="entry-text">No alert, work item or incident recorded.</p>}
    {incidents.map((incident) => <div className="entry" key={incident.id}>
      <div className="entry-title"><Icon name="incident" size={14} className={`tone-${incident.tone}`} />{incident.kindLabel} <Pill tone={incident.tone}>{incident.statusLabel}</Pill></div>
      {incident.facts.map((fact) => <p className="entry-text" key={fact.label}><b>{fact.label}:</b> {fact.value}{fact.hint ? ` (${fact.hint})` : ""}</p>)}
      <p className="entry-meta">{incident.owner && <span>Owner {incident.owner}</span>}<span>Opened <When at={incident.openedAt} /></span>{incident.resolvedAt && <span>Resolved <When at={incident.resolvedAt} /></span>}</p>
    </div>)}
    {alerts.map((alert) => <div className="entry" key={alert.id}>
      <div className="entry-title"><Icon name="alert" size={14} className={`tone-${alert.tone}`} />{alert.signalLabel} <Pill tone={alert.tone}>{alert.statusLabel}</Pill></div>
      <p className="entry-text">{alert.summary}</p>
      {alert.nextAction && <p className="entry-text"><b>Next:</b> {alert.nextAction}</p>}
      {alert.acknowledgementReason && <p className="entry-text"><b>Acknowledged because:</b> {alert.acknowledgementReason}</p>}
      {alert.resolutionReason && <p className="entry-text"><b>Resolution:</b> {alert.resolutionReason}</p>}
      <p className="entry-meta">
        <span>{alert.severity} severity</span>
        <span>Raised <When at={alert.triggeredAt} /></span>
        {alert.owner && alert.status !== "ACKNOWLEDGED" && <span>Owner {alert.owner}</span>}
        {alert.acknowledgedAt && <span>Acknowledged{alert.status === "ACKNOWLEDGED" && alert.owner ? ` by ${alert.owner}` : ""} <When at={alert.acknowledgedAt} />{alert.status === "ACKNOWLEDGED" ? ", still open" : ""}</span>}
        {alert.resolvedAt && <span>Resolved <When at={alert.resolvedAt} /></span>}
        {alert.evidenceCount > 0 && <span>{alert.evidenceCount} evidence link{alert.evidenceCount === 1 ? "" : "s"}</span>}
      </p>
    </div>)}
    {workItems.map((item) => <div className="entry" key={item.id}>
      <div className="entry-title"><Icon name="work" size={14} className={`tone-${item.tone}`} />{item.kindLabel} <Pill tone={item.tone}>{item.statusLabel}</Pill></div>
      <p className="entry-text">{item.summary}</p>
      {item.nextAction && <p className="entry-text"><b>Next:</b> {item.nextAction}</p>}
      {item.outcome && <p className="entry-text"><b>Outcome:</b> {item.outcome}</p>}
      <p className="entry-meta">
        {item.owner && <span>Owner {item.owner}</span>}
        {item.priority && <span>{item.priority} priority</span>}
        {item.dueAt && <span>Due <When at={item.dueAt} snapshotAt={view.snapshotAt} relative /></span>}
        {item.closedAt && <span>Closed <When at={item.closedAt} /></span>}
        {item.sourceCount > 0 && <span>{item.sourceCount} source record{item.sourceCount === 1 ? "" : "s"}</span>}
      </p>
    </div>)}
  </section>
}

export function DriversPanel({ view }: { view: RecordView }) {
  const { assignments } = view
  if (!assignments.length) return null
  return <section className="detail" aria-label="Drivers">
    <h3>Drivers <span className="count">{assignments.length}</span></h3>
    {assignments.map((assignment) => <div className="entry" key={assignment.id}>
      <div className="entry-title"><Icon name="driver" size={14} />{assignment.driver.name} <Pill tone={assignment.tone}>{assignment.statusLabel}</Pill></div>
      <p className="entry-meta">
        {assignment.driverHome && <span>Home base {assignment.driverHome}</span>}
        {assignment.fee && <span>Fee {assignment.fee}</span>}
        {assignment.acceptedAt && <span>Booked <When at={assignment.acceptedAt} /></span>}
        {assignment.startedAt && <span>Started <When at={assignment.startedAt} /></span>}
        {assignment.completedAt && <span>Completed <When at={assignment.completedAt} /></span>}
        {assignment.cancelledAt && <span>Cancelled <When at={assignment.cancelledAt} />{assignment.cancellation ? ` (${assignment.cancellation})` : ""}</span>}
      </p>
      {assignment.history && <p className="entry-text">Prior duty: {assignment.history}</p>}
    </div>)}
  </section>
}

export function MarketPanel({ view }: { view: RecordView }) {
  const { offers } = view
  return <section className="detail" id="market" aria-label="Driver market">
    <h3>Driver market <span className="count">{offers.length || ""}</span></h3>
    {offers.length === 0 && <p className="entry-text">No offer has been published for this order.</p>}
    {offers.map((offer) => <div className="entry" key={offer.id}>
      <div className="entry-title"><Icon name="offer" size={14} />{offer.type === "BUNDLE" ? `Bundle offer (${offer.memberOrders.map((order) => order.reference).join(" and ")})` : offer.visibility === "DIRECTED" ? "Directed offer" : "Public offer"} <Pill tone={offer.tone}>{offer.statusLabel}</Pill></div>
      <p className="entry-meta">
        {offer.fee && <span>{offer.fee}</span>}
        {offer.publishedAt && <span>Published <When at={offer.publishedAt} /></span>}
        {offer.acceptedAt && <span>Accepted <When at={offer.acceptedAt} /></span>}
        {offer.withdrawnAt && <span>Withdrawn <When at={offer.withdrawnAt} /></span>}
        {offer.expiresAt && offer.status === "PUBLISHED" && <span>Booking cutoff <When at={offer.expiresAt} snapshotAt={view.snapshotAt} relative /></span>}
      </p>
      {offer.pricingNote && <p className="entry-text">{offer.pricingNote}</p>}
      {offer.assumptions.length > 0 && <p className="entry-text">{offer.assumptions.join(" · ")}</p>}
      {offer.exposures.map((exposure) => <p className="entry-text" key={exposure.id}>
        Shown to <b>{exposure.driver.name}</b>{exposure.reason ? ` (${exposure.reason})` : ""} {fmtDateTime(exposure.shownAt)} · {exposure.statusLabel.toLowerCase()}{exposure.notifiedAt ? `, notified ${fmtDateTime(exposure.notifiedAt)}` : ", notification not recorded"}{exposure.viewedAt ? `, viewed ${fmtDateTime(exposure.viewedAt)}` : ", view not recorded"}{exposure.decidedAt ? `, decided ${fmtDateTime(exposure.decidedAt)}` : exposure.expiresAt ? `, deadline ${fmtDateTime(exposure.expiresAt)}` : ""}.
      </p>)}
      {offer.reach && <p className="entry-text">Dispatch screening {fmtDateTime(offer.reach.checkedAt)}: {offer.reach.screened} screened, {offer.reach.suitable} provisionally suitable, {offer.reach.matched} audience matched, {offer.reach.accessible} feed accessible. A planning estimate, not proof of willingness.{offer.reach.note ? ` ${offer.reach.note}` : ""}</p>}
      {offer.demand && <p className="entry-text">{offer.demand.views} detail view{offer.demand.views === 1 ? "" : "s"}, {offer.demand.passes} explicit pass{offer.demand.passes === 1 ? "" : "es"}{offer.demand.windowStart ? ` between ${fmtDateTime(offer.demand.windowStart)} and ${fmtDateTime(offer.demand.windowEnd)}` : ""}. Zero views does not mean nobody saw the listing.</p>}
      {offer.assessment && <p className="entry-text">Operator review: {offer.assessment}.</p>}
    </div>)}
  </section>
}

export function TravelPanel({ view }: { view: RecordView }) {
  const { reservations, options, confirmations, terminalEvents } = view
  const count = reservations.length + options.length
  const kindIcon = (kind: string) => kind === "FERRY" ? "ferry" : kind === "TRAIN" ? "train" : kind === "FLIGHT" ? "plane" : kind === "HOTEL" ? "hotel" : "car"
  return <section className="detail" id="travel" aria-label="Travel">
    <h3>Travel <span className="count">{count || ""}</span></h3>
    {count === 0 && <p className="entry-text">No booking or quote recorded.</p>}
    {reservations.map((reservation) => <div className="entry" key={reservation.id}>
      <div className="entry-title"><Icon name={kindIcon(reservation.kind)} size={14} />{reservation.kindLabel}{reservation.route ? `: ${reservation.route}` : ""} <Pill tone={reservation.tone}>{reservation.statusLabel}</Pill></div>
      <p className="entry-meta">
        {reservation.kind === "HOTEL"
          ? <span>Stay {fmtRange(reservation.departureAt, reservation.arrivalAt, null)}</span>
          : <><span>Departs <When at={reservation.departureAt} /></span>{reservation.arrivalAt && <span>Arrives <When at={reservation.arrivalAt} /></span>}</>}
        {reservation.checkInCutoffAt && <span>Check-in cutoff <When at={reservation.checkInCutoffAt} /></span>}
        {reservation.driver && <span>{reservation.driver.name}</span>}
        {reservation.reference && <span>{reservation.reference}</span>}
      </p>
      {reservation.checks.length > 0 && <p className="entry-text">{reservation.checks.join(" · ")}. A booking does not confirm travel.</p>}
      {reservation.amendment && <p className="entry-text tone-warn">Carrier notice: {reservation.amendment}</p>}
      {reservation.stateNote && <p className="entry-text">{reservation.stateNote}</p>}
      {(reservation.replaces || reservation.replacedBy) && <p className="entry-meta">{reservation.replaces && <span>Rebooking after an earlier reservation</span>}{reservation.replacedBy && <span>Replaced by a later reservation</span>}</p>}
    </div>)}
    {options.length > 0 && <More label={`${options.length} quote${options.length === 1 ? "" : "s"} and capacity checks`}>
      <div>{options.map((option) => <div className="entry" key={option.id}>
        <div className="entry-title"><Icon name={kindIcon(option.kind)} size={14} />{option.kindLabel}{option.route ? `: ${option.route}` : ""} <Pill tone={option.tone}>{option.statusLabel}</Pill></div>
        <p className="entry-meta">
          <span>Departs <When at={option.departureAt} /></span>
          {option.quote && <span>{option.quote}</span>}
          {option.provider && <span>{option.provider}</span>}
          <span>Checked <When at={option.checkedAt} /></span>
        </p>
        {option.note && <p className="entry-text">{option.note}. A quote is not a booking.</p>}
      </div>)}</div>
    </More>}
    {confirmations.map((confirmation) => <div className="entry" key={confirmation.id}>
      <div className="entry-title">{confirmation.kindLabel}</div>
      <p className="entry-text">{confirmation.driver.name}: {confirmation.report}</p>
      <p className="entry-meta"><span><When at={confirmation.at} /></span><span>Driver report, not an independent confirmation</span></p>
    </div>)}
    {terminalEvents.map((event) => <div className="entry" key={event.id}>
      <div className="entry-title"><Icon name="ferry" size={14} className="tone-danger" />{event.kindLabel}{event.terminal ? ` at ${event.terminal}` : ""}</div>
      {event.reason && <p className="entry-text">{event.reason}</p>}
      <p className="entry-meta"><span><When at={event.at} /></span>{event.note && <span>{event.note}</span>}</p>
    </div>)}
  </section>
}

export function CostsPanel({ view }: { view: RecordView }) {
  const { expenses } = view
  const shown = expenses.slice(0, 6)
  return <section className="detail" id="costs" aria-label="Costs">
    <h3>Costs <span className="count">{expenses.length || ""}</span></h3>
    {expenses.length === 0 && <p className="entry-text">No cost claim recorded.</p>}
    {shown.map((expense) => <ExpenseRow key={expense.id} expense={expense} />)}
    {expenses.length > shown.length && <More label={`${expenses.length - shown.length} earlier cost records`}>
      <div>{expenses.slice(shown.length).map((expense) => <ExpenseRow key={expense.id} expense={expense} />)}</div>
    </More>}
  </section>
}

/** "Receipt attached" or "No receipt": whether a sample is in the packet is not the operator's question. */
function receiptText(receipt: string): string {
  if (receipt.startsWith("receipt attached")) return "Receipt attached"
  if (receipt === "no receipt" || receipt.toLowerCase() === "missing") return "No receipt"
  return receipt.charAt(0).toUpperCase() + receipt.slice(1)
}

function ExpenseRow({ expense }: { expense: RecordView["expenses"][number] }) {
  return <div className="entry">
    <div className="entry-title">{expense.kindLabel} <span>{expense.amount}</span> <Pill tone={expense.tone}>{expense.statusLabel}</Pill></div>
    <p className="entry-meta">
      {expense.claimant && <span>{expense.claimant.name}</span>}
      {expense.payer && !expense.claimant && <span>Paid by {expense.payer}</span>}
      <span>{receiptText(expense.receipt)}</span>
      {expense.submittedAt && <span>Submitted <When at={expense.submittedAt} /></span>}
    </p>
    {expense.note && <p className="entry-text">{expense.note}</p>}
  </div>
}

export function SourcePanel({ view, orderId }: { view: RecordView; orderId: string }) {
  return <section className="detail" aria-label="Source records">
    <h3>Source records</h3>
    {view.inboxHints.map((hint) => <div className="entry" key={hint.id}>
      <div className="entry-title"><Icon name="message" size={14} />Support inbox <Pill tone={hint.confirmed ? "neutral" : "warn"}>{hint.stateLabel}</Pill></div>
      <p className="entry-text">{hint.category} by {hint.channel.toLowerCase()}{hint.owner ? ` · owner ${hint.owner}` : ""}{hint.waitingOn ? ` · waiting on ${hint.waitingOn}` : ""}. {hint.confirmed ? "Confirmed link." : "A candidate match, not a confirmed link."}{hint.basis ? ` ${hint.basis}` : ""}</p>
    </div>)}
    {view.otherRecords.length > 0 && <p className="entry-text">Also linked, not shown above: {view.otherRecords.map((record) => `${record.label.toLowerCase()} (${record.count})`).join(", ")}.</p>}
    <p className="entry-meta">Every field and link: <a href={`/api/orders/${orderId}`} target="_blank" rel="noopener noreferrer">order API</a>.</p>
  </section>
}
