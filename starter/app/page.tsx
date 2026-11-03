"use client"

// Needs action (spec .scratch/publishing): the orders that are not normal, Blocked, Fixed, review it and
// In progress as a queue, soonest deadline first, with the selected order opened beside it.
// Normal and finished orders are on the Overview.

import { useEffect, useState } from "react"
import type { ApprovalQueue, BoardCard } from "@/lib/present/types"
import { GROUP_LABEL } from "./components/checks"
import { byEmergency } from "./components/columns"
import { useClockVersion } from "./components/demo-clock"
import { BatchApproval } from "./components/proposals"
import { QueueBoard, type QueueFilter } from "./components/queue"

const FILTERS: QueueFilter[] = [
  { key: "needs_action", label: GROUP_LABEL.needs_action, empty: "Nothing needs you.", loud: true },
  { key: "solved", label: GROUP_LABEL.solved, empty: "No call results wait for your yes." },
  { key: "in_progress", label: GROUP_LABEL.in_progress, empty: "No agent work is planned or running." },
]

const place = (card: BoardCard) => {
  const group = card.verdict?.group
  return group === "needs_action" || group === "solved" || group === "in_progress" ? group : null
}

export default function NeedsActionBoard() {
  const clockVersion = useClockVersion()
  // Proposals waiting for a yes, across orders, for batch approval (ticket 07).
  const [approvals, setApprovals] = useState<ApprovalQueue | null>(null)
  const [batch, setBatch] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    fetch("/api/proposals", { signal: controller.signal })
      .then((response) => response.ok ? response.json() as Promise<ApprovalQueue> : null)
      .then((data) => { if (data) setApprovals(data) })
      .catch(() => {})
    return () => controller.abort()
  }, [clockVersion])

  const waiting = approvals?.waiting.length ?? 0
  return <QueueBoard board="attention" filters={FILTERS} place={place} sort={byEmergency}
    tools={waiting > 0 && <button type="button" className={`btn btn-s ${batch ? "btn-primary" : "btn-tertiary"} queue-batch`} aria-pressed={batch} onClick={() => setBatch((value) => !value)}>
      {batch ? "Done approving" : `Approve ${waiting} agent ${waiting === 1 ? "proposal" : "proposals"}`}
    </button>}
    aside={batch && approvals ? <BatchApproval queue={approvals} onClose={() => setBatch(false)} /> : null} />
}
