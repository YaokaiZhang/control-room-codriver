// The situation card's text and steps (lib/present/situation.ts): deterministic
// shortenings of the engine's own words. Hand-built inputs, no database.

import assert from "node:assert/strict"
import { test } from "node:test"
import type { RuleResult } from "@/lib/engine/checks"
import type { Call } from "@/lib/engine/calls"
import type { Proposal } from "@/lib/engine/proposals"
import { ruleProblem, situationFor, whoSaid, type SituationInput } from "./situation"

const rule = (id: RuleResult["id"], detail: string, firstAction: RuleResult["firstAction"] = "show_person"): RuleResult =>
  ({ id, strength: "strong", title: "t", outcome: "fail", detail, firstAction, sources: [] })

const base: SituationInput = {
  group: "needs_action", rules: [], urgency: { urgent: false, reasons: [], dueAt: null }, planned: [],
  proposals: [], calls: [], callLines: [], publication: null,
}

test("rule headlines say what is wrong in plain words", () => {
  assert.deepEqual(ruleProblem(rule("R11", "The pickup slot ended 21 Oct 11:00 EEST and no pickup is recorded.")),
    { headline: "Pickup slot passed, nothing collected", situation: "The slot ended 21 Oct 11:00 EEST" })
  assert.deepEqual(ruleProblem(rule("R1", "Kovellin Hamburg requires a signed release and no verified release authority is on file for the pickup on 23 Oct 10:00 CEST.")),
    { headline: "No signed release for the pickup at Kovellin Hamburg", situation: "Pickup 23 Oct 10:00 CEST" })
  assert.equal(ruleProblem(rule("CLOSE", "The order is delivered but one record is still open: proof to review.")).headline, "Delivered, proof waits for review")
  assert.deepEqual(ruleProblem(rule("CLOSE", "The order is delivered but 2 records are still open: open alert, unsettled proposal.")),
    { headline: "Delivered, but 2 records are still open", situation: "Still to close: open alert, unsettled proposal" })
})

test("a call result reads as who said what", () => {
  assert.equal(whoSaid("Adrian Aldermere", "Says they are not the pickup contact."), "Adrian Aldermere says they are not the pickup contact")
  assert.equal(whoSaid("Karin Calverick", "Driver cannot deliver within the promised window."), "Driver cannot deliver within the promised window")
})

test("a rule shown to a person: headline from the rule, the work item as the suggestion, a look at the evidence as the step", () => {
  const situation = situationFor({
    ...base,
    rules: [rule("CLOSE", "The order is delivered but 4 records are still open: proof to review, signed handover missing, open alert, open work item.")],
    urgency: { urgent: true, reasons: [{ kind: "action_due", text: "Overdue work item: Ask the receiver for the signed record; review the photos separately.", at: null }], dueAt: null },
  })
  assert.ok(situation)
  assert.equal(situation.headline, "Delivered, but 4 records are still open")
  assert.match(situation.body ?? "", /Suggestion: ask the receiver for the signed record\.$/)
  assert.deepEqual(situation.step, { label: "Review the open records", do: "open", anchor: "rule-CLOSE" })
})

test("a change waiting for a yes: the approval is the step, dismissing is another", () => {
  const proposal = {
    id: "chg-1", kind: "change", status: "proposed", waitingOn: "operator", title: "Confirm the pickup contact",
    why: "Adrian Alderbrook said on the site call at 09:00 UTC: Confirmed they are the pickup contact.",
    action: "Change the order: Pickup contact confirmed.", contact: { name: "Adrian Alderbrook" },
  } as unknown as Proposal
  const situation = situationFor({ ...base, proposals: [proposal] })
  assert.ok(situation)
  assert.equal(situation.headline, "Adrian Alderbrook confirmed they are the pickup contact")
  assert.deepEqual(situation.step, { label: "Approve the change", do: "approve", proposalId: "chg-1" })
  assert.ok(situation.others.some((step) => step.do === "dismiss"))
})

test("an open handover comes first, and recording what was learned is the step", () => {
  const call = {
    id: "call-1", line: "driver", callee: { name: "Karin Calverick", handle: "drv-231" },
    handover: { summary: "Karin Calverick: Driver cannot deliver within the promised window.", question: "q", nextStep: "Call Karin Calverick back, then record what you learned.", closed: null },
  } as unknown as Call
  const situation = situationFor({ ...base, calls: [call], rules: [rule("R11", "The pickup slot ended 21 Oct 11:00 EEST and no pickup is recorded.")] })
  assert.ok(situation)
  assert.equal(situation.headline, "Driver cannot deliver within the promised window")
  assert.equal(situation.step?.do, "handover")
  assert.match(situation.body ?? "", /Suggestion: call Karin Calverick back/)
})

test("normal and finished orders have no card", () => {
  assert.equal(situationFor({ ...base, group: "normal" }), null)
  assert.equal(situationFor({ ...base, group: "done" }), null)
})

test("a finished order whose open records can be closed: closing them is the step, the look is another", () => {
  const proofs = { ...rule("CLOSE", "The order is delivered but 2 records are still open: proof to review (2)."), sources: [
    { collection: "proofs", id: "proof-1", label: "Proof to review", close: "Accept" },
    { collection: "proofs", id: "proof-2", label: "Proof to review", close: "Accept" },
  ] }
  const situation = situationFor({ ...base, rules: [proofs] })
  assert.ok(situation)
  assert.deepEqual(situation.step, { label: "Accept the 2 proofs", do: "close", records: [{ collection: "proofs", recordId: "proof-1" }, { collection: "proofs", recordId: "proof-2" }] })
  assert.ok(situation.others.some((step) => step.label === "Review the open records"))

  const mixed = { ...proofs, sources: [proofs.sources[0], { collection: "work_items", id: "wi-1", label: "Open work item", close: "Mark done" }] }
  assert.equal(situationFor({ ...base, rules: [mixed] })?.step?.label, "Close all 2 records")
  const one = { ...proofs, sources: [{ collection: "work_items", id: "wi-1", label: "Open work item", close: "Mark done" }] }
  assert.equal(situationFor({ ...base, rules: [one] })?.step?.label, "Mark the work item done")
})
