// The support inbox: mail that arrived before an order link was certain.
// Candidate orders are hypotheses; only linked orders are confirmed.

import type { Directory } from "./actors"
import { obj, str, strings } from "./bundle"
import { humanize, label, labelIn } from "./labels"
import type { Actor, InboxThreadView, InboxView, Row, Tone } from "./types"

const LINK_TONE: Record<string, Tone> = {
  PENDING_MATCH: "warn", PENDING_IDENTITY: "warn", ACCOUNT_CONFLICT: "danger",
  CONFIRMED_SINGLE: "ok", CONFIRMED_MULTI: "ok", NO_ORDER_REQUIRED: "neutral",
}

// Inbox wording that differs from the shared labels: say what is missing, and don't repeat the link pill.
const LINK_STATE_LABEL: Record<string, string> = {
  PENDING_MATCH: "Order not identified", PENDING_IDENTITY: "Reference not on sender's account",
}
const DECISION_LABEL: Record<string, string> = {
  LINK_ONE_ORDER: "Linked", LINK_SEVERAL_ORDERS: "Linked", OPERATOR_LINKED: "Linked",
}

export function buildInboxView(threads: Row[], messages: Row[], dir: Directory, refs: Record<string, string>, snapshotAt: string | null): InboxView {
  const ref = (id: string) => ({ id, reference: refs[id] ?? id })
  const views: InboxThreadView[] = threads.map((thread) => {
    const id = str(thread.id) ?? ""
    const status = str(thread.status) ?? "OPEN"
    const linkState = str(thread.link_state) ?? "PENDING_MATCH"
    const resolution = obj(thread.resolution)
    const counterpartyType = str(thread.counterparty_type)
    const counterparty: Actor | null = counterpartyType || str(thread.counterparty_id) ? dir.resolve(thread.counterparty_id, counterpartyType) : null
    return {
      id, category: str(thread.category) ?? "", categoryLabel: label(str(thread.category)) || humanize(str(thread.category)),
      channel: str(thread.channel) ?? "", channelLabel: label(str(thread.channel)) || humanize(str(thread.channel)),
      status, statusLabel: label(status), tone: (status === "OPEN" ? "accent" : "neutral") as Tone,
      linkState, linkStateLabel: LINK_STATE_LABEL[linkState] ?? label(linkState), linkTone: LINK_TONE[linkState] ?? "neutral",
      owner: dir.title(thread.owner), waitingOn: str(thread.waiting_on) ? labelIn(str(thread.waiting_on)) : null,
      counterparty, openedAt: str(thread.opened_at), updatedAt: str(thread.updated_at),
      candidateBasis: str(thread.candidate_basis),
      candidates: strings(thread.candidate_order_ids).map(ref),
      linked: strings(thread.linked_order_ids).map(ref),
      operatorLinked: strings(thread.operator_linked_order_ids),
      resolution: resolution ? { decisionLabel: DECISION_LABEL[str(resolution.decision) ?? ""] ?? (label(str(resolution.decision)) || "Resolved"), at: str(resolution.decided_at) } : null,
      messages: messages.filter((message) => message.thread_id === id).map((message) => {
        const channel = str(message.channel) ?? ""
        return {
          id: str(message.id) ?? "", author: dir.resolve(message.author_id, message.author_type),
          recipient: dir.resolve(message.recipient_id, message.recipient_type), channel, channelLabel: label(channel) || humanize(channel),
          at: str(message.authored_at) ?? "", body: str(message.body) ?? "",
          internal: str(message.visibility) === "INTERNAL" || channel === "internal_note", language: str(message.language),
          sentFromApp: message.sent_from_app === true, draftedByAgent: message.drafted_by_agent === true,
        }
      }).sort((a, b) => a.at.localeCompare(b.at)),
    }
  }).sort((a, b) => (a.status === "OPEN" ? 0 : 1) - (b.status === "OPEN" ? 0 : 1) || String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))
  return { snapshotAt, threads: views, open: views.filter((thread) => thread.status === "OPEN").length }
}
