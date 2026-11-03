// Tier 2, the voice agent (ticket 12), through `state`, `apply` and `phone` only.
// The audio model, the ear (transcription), the checker (Haiku through the
// ModelGateway) and speech are scripted: no network. Expected values come from the
// spec (story 71: CD-420437 "can you still deliver on time?") and the dataset.

import assert from "node:assert/strict"
import { test } from "node:test"
import type { Engine, OrderState } from "./engine"
import type { ModelGateway } from "@/lib/reviewer/gateway"
import { checkJson, jobGateway, scriptedChecker, scriptedEar, scriptedPerson, scriptedSpeech, scriptedVoice, testClip } from "./call-testing"
import { createVoiceAgent } from "./voice-agent"
import { demoAnswerer } from "./phone"
import { modelCallee } from "./simulated-person"
import { eachStore, testEngine } from "./testing"
import type { CallOptions } from "./call-runner"

async function order(engine: Engine, reference: string): Promise<OrderState> {
  const found = (await engine.state()).orders.find((row) => row.reference === reference)
  assert.ok(found, `${reference} is in the snapshot`)
  return found
}

function engineWith(calls: CallOptions = {}): Promise<Engine> {
  return testEngine({ calls: { person: scriptedPerson({}), speech: scriptedSpeech(), answererFor: demoAnswerer({ "CD-420437": ["driver"] }), ...calls } })
}

test("CD-420437's driver line waits for the operator: the ETA leaves two minutes before the promise ends", async () => {
  const engine = await engineWith()
  const before = await order(engine, "CD-420437")
  const line = before.callLines.find((row) => row.line === "driver")
  assert.ok(line, "a tight ETA gives the order a driver line")
  assert.equal(line.status, "on_request")
  assert.match(line.text, /16:58 EEST.*2 min before the promise ends at 17:00 EEST/)
  assert.equal(line.callee?.handle, "drv-367")

  await engine.apply({ type: "runCalls" })
  const after = await order(engine, "CD-420437")
  assert.equal(after.calls.length, 0, "the pump does not ring it on its own")
  assert.equal(after.group, before.group, "a line on request holds nothing")
})

test("a tight ETA (10 min or less before the promise end) puts CD-420437 and CD-420710 on request", async () => {
  const engine = await engineWith()
  const onRequest = (await engine.state()).orders.filter((row) => row.callLines.some((line) => line.status === "on_request")).map((row) => row.reference)
  assert.deepEqual(onRequest, ["CD-420437", "CD-420710"])
})

/** Rings CD-420437's driver live, answers, says now is fine and presses 2: "no, I can't make it". */
async function toTier2(engine: Engine) {
  const id = (await order(engine, "CD-420437")).id
  await engine.apply({ type: "startCall", orderId: id, line: "driver", live: true })
  let call = (await engine.phone("driver")).current!
  assert.equal(call.reference, "CD-420437")
  await engine.apply({ type: "callEvent", callId: call.id, input: { type: "answer" } })
  await engine.apply({ type: "callEvent", callId: call.id, input: { type: "key", digit: "1" } })
  call = (await engine.phone("driver")).current!
  assert.match(call.expecting?.type === "key" ? call.expecting.text : "", /still deliver within the promised window/)
  await engine.apply({ type: "callEvent", callId: call.id, input: { type: "key", digit: "2" } })
  return (await engine.phone("driver")).current
}

test("a reported problem moves the live call to tier 2: the voice agent opens with what it knows and one question, then waits for speech", async () => {
  const checker = scriptedChecker([])
  const engine = await engineWith({ voice: createVoiceAgent({ voice: scriptedVoice([]), ear: scriptedEar([]), checker }) })
  const call = await toTier2(engine)
  assert.ok(call, "the call is still on the phone")
  assert.equal(call.state, "tier2")
  assert.equal(call.tier, 2)
  assert.deepEqual(call.expecting, { type: "speech" })
  const opener = call.transcript.at(-1)!
  assert.equal(opener.by, "agent")
  assert.equal(opener.tier, 2)
  assert.ok(opener.audioId, "the opener is spoken")
  assert.equal(opener.text, "About order CD-420437: you told me there is a problem on the keypad. What exactly is holding you up?")
  assert.equal(opener.cost > 0.0005, true, "writing the opener goes on the meter, with its speech")
  assert.equal(checker.calls.length, 0, "the opener uses up no turn check")
  const brief = checker.openers[0].messages.at(-1)!.content as string
  assert.match(brief, /CD-420437/)
  assert.match(brief, /"Can you still deliver within the promised window\?" No\./, "what was said on the keypad")
  assert.match(brief, /Moved to tier 2: Driver cannot deliver within the promised window\./, "why it escalated")
  assert.match(brief, /Latest ETA on record: 15:58/)
  assert.ok(!/hold the talk button/i.test(opener.text), "no generic instructions")

  const row = await order(engine, "CD-420437")
  assert.equal(row.group, "in_progress")
  assert.match(row.reason, /Calling Thomas Mellervik: /)
})

const LATE = "I'm stuck in traffic after an accident, I'll be about forty minutes late, around half past four."
// A new arrival time is a reported ETA (`eta`, committed at once; supersedes.test.ts), never a
// change. A change is something the order would have to do differently, such as another handover place.
const NEXT_DOOR = "Nobody is here to take the car. Can I leave it with the dealership next door?"
const LEAVE_NEXT_DOOR = {
  title: "Change where the car is handed over", change: "Leave the car with the dealership next door, because nobody is at the delivery address to take it.",
  claim: "Nobody at the delivery address; asks to leave the car with the dealership next door",
}

test("each spoken turn is transcribed, answered aloud by the audio model and checked; its cost goes on the meter", async () => {
  const voice = scriptedVoice(["I'm sorry to hear that. Is the road moving again, or are you still stopped?"])
  const ear = scriptedEar([LATE])
  const checker = scriptedChecker([{ heard: LATE, claims: ["Stuck in traffic after an accident", "Expects to arrive around 16:30 local"], conflicts: ["The ETA on record is 15:58 local"], replyOk: true }])
  const engine = await engineWith({ voice: createVoiceAgent({ voice, ear, checker }) })
  const before = (await toTier2(engine))!
  const clip = testClip(3)

  await engine.apply({ type: "voiceTurn", callId: before.id, audio: clip })

  const call = (await engine.phone("driver")).current!
  assert.equal(call.state, "tier2")
  assert.deepEqual(call.expecting, { type: "speech" }, "the driver's turn again")
  const added = call.transcript.slice(before.transcript.length)
  assert.deepEqual(added.map((line) => line.by), ["callee", "system", "agent"])
  assert.equal(added[0].text, LATE, "what the driver said, from the ear")
  assert.deepEqual(added[1].check?.claims, ["Stuck in traffic after an accident", "Expects to arrive around 16:30 local"])
  assert.deepEqual(added[1].check?.conflicts, ["The ETA on record is 15:58 local"])
  assert.equal(added[1].check?.next, "continue")
  assert.equal(added[2].text, "I'm sorry to hear that. Is the road moving again, or are you still stopped?")
  assert.equal(added[2].audioId, "v00000001", "the audio model's own voice")
  assert.equal(added[2].path, "voice")

  assert.equal(ear.heard[0], clip)
  assert.equal(voice.requests[0].clip, clip, "the audio model hears the recording itself")
  const brief = voice.requests[0].brief
  assert.match(brief, /CD-420437/)
  assert.match(brief, /Latest ETA on record: 15:58/, "times in the driver's zone (Europe/Berlin)")
  assert.match(brief, /Delivery promise to the customer: 11:00 to 16:00/)
  assert.ok(brief.length < 1200, "a short brief, not the case file")
  assert.equal(checker.calls[0].job, "call-check")

  assert.equal(Math.round((call.cost.modelUsd - before.cost.modelUsd) * 1e6) / 1e6, 0.00165, "ear $0.00005 + checker $0.001 + audio model $0.0006")
  assert.ok(call.cost.phoneSeconds > before.cost.phoneSeconds + 3, "the driver's 3 s of speech is phone time")
})

test("the agent never agrees to a change: a reply that does is replaced, and the change becomes a proposal for the operator's yes", async () => {
  const voice = scriptedVoice(["No problem, just leave it next door."])
  const checker = scriptedChecker([{
    heard: NEXT_DOOR, claims: [LEAVE_NEXT_DOOR.claim], changes: [LEAVE_NEXT_DOOR], replyOk: false,
    replyIssue: "The draft agrees to change the handover place.", next: "resolved",
    reply: "Thank you, I've noted that nobody is there to take the car. A colleague will review it with the customer. Goodbye.",
    summary: "Nobody at the delivery address; the driver asks to leave the car with the dealership next door.",
  }])
  const speech = scriptedSpeech()
  const engine = await engineWith({ speech, voice: createVoiceAgent({ voice, ear: scriptedEar([NEXT_DOOR]), checker }) })
  const call = (await toTier2(engine))!

  await engine.apply({ type: "voiceTurn", callId: call.id, audio: testClip() })

  assert.equal((await engine.phone("driver")).current, null, "the call ended")
  const row = await order(engine, "CD-420437")
  const ended = row.calls[0]
  assert.equal(ended.outcome, "resolved")
  assert.equal(ended.tier, 2)
  assert.ok(!ended.transcript.some((line) => /leave it next door/.test(line.text)), "the agreeing reply is never said")
  const reply = ended.transcript.filter((line) => line.by === "agent").at(-1)!
  assert.match(reply.text, /A colleague will review it/)
  assert.ok(speech.spoken.includes(reply.text), "spoken by text to speech instead")
  assert.equal(reply.path, "replaced")
  assert.match(ended.transcript.find((line) => line.check)?.text ?? "", /Audio reply not used/)
  assert.deepEqual(ended.changes, [LEAVE_NEXT_DOOR])
  assert.match(ended.summary ?? "", /leave the car with the dealership next door/)

  const change = row.proposals.find((proposal) => proposal.kind === "change")
  assert.ok(change, "the handover change waits for the operator")
  assert.equal(change.status, "proposed")
  assert.equal(change.change, LEAVE_NEXT_DOOR.change)
  assert.ok(!row.effects.some((event) => event.type === "eta_reported"), "no arrival time was said, so no ETA is reported")
  assert.equal(row.group, "solved", "the change from the call waits in Fixed, review it")
  assert.match(row.reason, /waiting for your yes/)
  assert.equal(row.callLines.find((line) => line.line === "driver")?.status, "done", "the on-time check is covered")
})

test("when the audio model fails, the ear, the checker and text to speech complete the same call", async () => {
  const voice = scriptedVoice([], "OpenRouter 503: no audio provider available")
  const checker = scriptedChecker([
    { heard: LATE, claims: ["Expects to arrive around 16:30 local"], reply: "I'm sorry to hear that. Are you still stopped, or moving again?", replyOk: null },
    { heard: "Moving again slowly.", claims: ["Expects to arrive around 16:30 local", "Traffic is moving again slowly"], eta: { local: "16:30", claim: "Expects to arrive around 16:30 local" }, next: "resolved", reply: "Thank you, I've noted it. Goodbye.", summary: "Late after an accident; expects 16:30 local." },
  ])
  const speech = scriptedSpeech()
  const engine = await engineWith({ speech, voice: createVoiceAgent({ voice, ear: scriptedEar([LATE, "Moving again slowly."]), checker }) })
  const call = (await toTier2(engine))!

  await engine.apply({ type: "voiceTurn", callId: call.id, audio: testClip() })
  const middle = (await engine.phone("driver")).current!
  const reply = middle.transcript.at(-1)!
  assert.equal(reply.path, "fallback")
  assert.equal(reply.text, "I'm sorry to hear that. Are you still stopped, or moving again?")
  assert.ok(reply.audioId?.startsWith("a"), "spoken by text to speech")
  assert.ok(speech.spoken.includes(reply.text))

  await engine.apply({ type: "voiceTurn", callId: call.id, audio: testClip() })
  const ended = (await order(engine, "CD-420437")).calls[0]
  assert.equal(ended.outcome, "resolved")
  assert.deepEqual(ended.claims.slice(-2), ["Expects to arrive around 16:30 local", "Traffic is moving again slowly"])
  assert.ok(ended.transcript.filter((line) => line.path).every((line) => line.path === "fallback"))
  const reported = (await order(engine, "CD-420437")).effects.find((event) => event.type === "eta_reported")
  assert.ok(reported && reported.type === "eta_reported", "the new arrival time is a reported ETA, not a change proposal")
  assert.equal(reported.etaAt, "2026-10-21T14:30:00.000Z")
})

test("an unresolved tier-2 call ends politely as a handover with the open question and a next step", async () => {
  const checker = scriptedChecker([{
    heard: "The customer wants a different address now, I need to talk to someone.", claims: ["Customer asked the driver for a different delivery address"],
    next: "handover", reply: "Thank you. A colleague from the control room will call you back shortly to settle this. Goodbye.",
    openQuestion: "May the driver deliver to the new address the customer gave?", nextStep: "Confirm the address with the customer, then call the driver back.",
    summary: "The customer asked the driver to deliver to a different address.",
  }])
  const engine = await engineWith({ voice: createVoiceAgent({ voice: scriptedVoice(["Okay."]), ear: scriptedEar(["The customer wants a different address now, I need to talk to someone."]), checker }) })
  const call = (await toTier2(engine))!
  await engine.apply({ type: "voiceTurn", callId: call.id, audio: testClip() })

  const row = await order(engine, "CD-420437")
  const ended = row.calls[0]
  assert.equal(ended.outcome, "handover")
  assert.deepEqual(ended.handover, {
    question: "May the driver deliver to the new address the customer gave?",
    nextStep: "Confirm the address with the customer, then call the driver back.",
    summary: "The customer asked the driver to deliver to a different address.",
    closed: null,
  })
  assert.match(ended.transcript.filter((line) => line.by === "agent").at(-1)!.text, /colleague .* call you back/)
  assert.equal(row.callLines.find((line) => line.line === "driver")?.status, "handover")
  assert.equal(row.group, "needs_action")
})

test("tier 2 takes only speech or a hang-up; a hang-up hands the call over", async () => {
  const engine = await engineWith({ voice: createVoiceAgent({ voice: scriptedVoice([]), ear: scriptedEar([]), checker: scriptedChecker([]) }) })
  const call = (await toTier2(engine))!
  await assert.rejects(engine.apply({ type: "callEvent", callId: call.id, input: { type: "key", digit: "1" } }), /listening/)
  await engine.apply({ type: "callEvent", callId: call.id, input: { type: "hang_up" } })
  const ended = (await order(engine, "CD-420437")).calls[0]
  assert.equal(ended.outcome, "handover")
  assert.match(ended.handover?.question ?? "", /hung up/)
  await assert.rejects(engine.apply({ type: "voiceTurn", callId: call.id, audio: testClip() }), /not listening/)
})

test("a hang-up during a slow voice turn ends the call at once; the turn's reply is dropped", async () => {
  let release = () => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  const slow = scriptedVoice(["Thanks, noted."])
  const voice = { ...slow, async reply(input: Parameters<typeof slow.reply>[0]) { await held; return slow.reply(input) } }
  const engine = await engineWith({ voice: createVoiceAgent({ voice, ear: scriptedEar(["The ferry is late."]), checker: scriptedChecker([]) }) })
  const call = (await toTier2(engine))!
  const turn = engine.apply({ type: "voiceTurn", callId: call.id, audio: testClip() })
  await engine.apply({ type: "callEvent", callId: call.id, input: { type: "hang_up" } })
  assert.equal((await engine.phone("driver")).current, null, "the phone is free before the agent has answered")
  release()
  await assert.rejects(turn, /moved on/)
  const ended = (await order(engine, "CD-420437")).calls[0]
  assert.equal(ended.outcome, "handover")
  assert.ok(!ended.transcript.some((line) => line.text === "Thanks, noted."), "nothing is said after the hang-up")
})

test("the phone's moves do not wait for a background call whose prompt is still being spoken", async () => {
  let release = () => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  const speech = scriptedSpeech()
  // Background calls' greetings name their order; CD-420437's own prompts go through at once.
  const slow = { ...speech, async speak(text: string) { if (/order CD-/.test(text) && !text.includes("CD-420437")) await held; return speech.speak(text) } }
  const engine = await engineWith({ speech: slow })
  const id = (await order(engine, "CD-420437")).id
  await engine.apply({ type: "startCall", orderId: id, line: "driver", live: true })
  const call = (await engine.phone("driver")).current!
  let roundDone = false
  const round = engine.apply({ type: "runCalls" }).then(() => { roundDone = true })
  await new Promise((resolve) => setTimeout(resolve, 20))
  await engine.apply({ type: "callEvent", callId: call.id, input: { type: "answer" } })
  assert.equal((await engine.phone("driver")).current?.expecting?.type, "key", "answered and greeted while the round still waits")
  assert.equal(roundDone, false, "a background greeting is still being spoken")
  release()
  await round
})

test("a failed check gives a safe reply and records nothing; the turn limit hands the call over", async () => {
  const failing = { async chat(): Promise<never> { throw new Error("OpenRouter 500") } }
  const engine = await engineWith({ voice: createVoiceAgent({ voice: scriptedVoice(["Sure, I'll tell the customer you're late."]), ear: scriptedEar(["one", "two"]), checker: failing, maxTurns: 2 }) })
  const call = (await toTier2(engine))!
  await engine.apply({ type: "voiceTurn", callId: call.id, audio: testClip() })
  const first = (await engine.phone("driver")).current!
  const check = first.transcript.find((line) => line.check)!
  assert.deepEqual(check.check?.claims, [])
  assert.match(check.text, /Check failed/)
  assert.ok(!first.transcript.some((line) => /I'll tell the customer/.test(line.text)), "an unchecked reply is not said")

  await engine.apply({ type: "voiceTurn", callId: call.id, audio: testClip() })
  const ended = (await order(engine, "CD-420437")).calls[0]
  assert.equal(ended.outcome, "handover", "two turns without settling: a person follows up")
})

test("without a voice agent a reported problem still ends as a handover", async () => {
  const engine = await engineWith()
  const call = await toTier2(engine)
  assert.equal(call, null, "the phone is free")
  const [ended] = (await order(engine, "CD-420437")).calls
  assert.equal(ended.outcome, "handover")
  assert.ok(ended.path.includes("tier2"))
})

// -- Simulated calls talk too ------------------------------------------------------
// A background call that escalates goes to the same voice agent. A model plays the
// callee in text (`modelCallee`); one fake gateway answers the opener, the callee and
// the checker by job. No ear, no audio model, no speech at tier 2.

const FLAT = "I've got a flat tyre outside Lahti. Roadside help is on its way, so I should be moving again in about an hour."
const STILL_TODAY = "Yes, it's only a short drive after that, I'd say I'm there by half past three."
const OFFICE = "The customer just called me, they want the car at their office instead of at home. I can't decide that, someone has to sort it with them."
const SIM_OPENER = "About order CD-420806: you said there's a problem on the road. What has happened?"

/** CD-420806's background driver call: "now is fine", then "2, there is a problem". Nobody else escalates. */
function simulated(gateway: ModelGateway, talk = true) {
  const ear = scriptedEar([])
  const voiceModel = scriptedVoice([])
  const speech = scriptedSpeech()
  const person = scriptedPerson({ "CD-420806": [["answer", "1", "2"]] })
  const calls: CallOptions = {
    person: talk ? { ...person, talk: modelCallee(gateway) } : person, speech,
    voice: createVoiceAgent({ voice: voiceModel, ear, checker: gateway }),
  }
  return { calls, ear, voiceModel, speech }
}

eachStore("a simulated escalation is talked through at tier 2: the callee answers in text, Haiku checks each turn, and the call ends resolved", async (engine) => {
  await engine.apply({ type: "runCalls" })

  const row = await order(engine, "CD-420806")
  const [call] = row.calls
  assert.equal(call.answerer, "simulated")
  assert.deepEqual(call.path, ["ringing", "answered", "availability", "tier1", "tier2", "ended"])
  assert.equal(call.outcome, "resolved")
  assert.equal(call.tier, 2, "settled by the agent, no person needed")
  const tier2 = call.transcript.filter((line) => line.tier === 2)
  assert.deepEqual(tier2.map((line) => [line.by, line.check ? "check" : line.text]), [
    ["system", "Moved to tier 2: Driver reports a problem."],
    ["agent", SIM_OPENER],
    ["callee", FLAT], ["system", "check"], ["agent", "I'm sorry to hear that. Will you still reach the customer today?"],
    ["callee", STILL_TODAY], ["system", "check"], ["agent", "Thank you, I've noted all of that. Goodbye."],
    ["system", call.summary],
  ])
  assert.ok(tier2.filter((line) => line.path).every((line) => line.path === "text"), "the checker wrote every reply")
  assert.ok(tier2.every((line) => !line.audioId), "no audio at tier 2")
  assert.deepEqual(call.claims.slice(-2), ["Flat tyre outside Lahti; roadside help on the way", "Expects to arrive around 15:30 local"])
  assert.match(call.summary ?? "", /Flat tyre outside Lahti/)
  assert.ok(row.effects.some((event) => event.type === "eta_reported"), "the time the driver gave is a reported ETA")
  // On the meter: the opener and two checks ($0.001 each); the callee's own model is not the agent's cost.
  assert.equal(Math.round(tier2.reduce((sum, line) => sum + line.cost, 0) * 1e6) / 1e6, 0.003)
  assert.ok(tier2.filter((line) => line.by === "callee").every((line) => line.cost === 0))
}, { calls: () => simulated(jobGateway({
  "call-opener": [SIM_OPENER],
  "call-callee": [FLAT, STILL_TODAY],
  "call-check": [
    checkJson({ heard: FLAT, claims: ["Flat tyre outside Lahti; roadside help on the way"], reply: "I'm sorry to hear that. Will you still reach the customer today?" }),
    checkJson({
      heard: STILL_TODAY, claims: ["Flat tyre outside Lahti; roadside help on the way", "Expects to arrive around 15:30 local"],
      // A question left before the goodbye is dropped: nobody could answer it.
      eta: { local: "15:30", claim: "Expects to arrive around 15:30 local" }, next: "resolved", reply: "Thank you, I've noted all of that. Is there anything else? Goodbye.",
      summary: "Flat tyre outside Lahti; expects to arrive around 15:30 local.",
    }),
  ],
})).calls })

test("the simulated callee reads the order's records and the conversation; the checker reads its words; nothing is spoken or transcribed", async () => {
  const gateway = jobGateway({
    "call-opener": [SIM_OPENER],
    "call-callee": [FLAT],
    "call-check": [checkJson({ heard: FLAT, claims: ["Flat tyre outside Lahti"], next: "resolved", reply: "Thank you, noted. Goodbye.", summary: "Flat tyre outside Lahti." })],
  })
  const sim = simulated(gateway)
  const engine = await testEngine({ calls: sim.calls })
  await engine.apply({ type: "runCalls" })

  assert.deepEqual(gateway.calls.map((request) => request.job), ["call-opener", "call-callee", "call-check"])
  const callee = gateway.calls[1]
  const system = callee.messages[0].content
  const persona = Array.isArray(system) ? system.map((part) => part.text).join("\n") : String(system)
  assert.match(persona, /You play .*the driver delivering this car, on order CD-420806/)
  assert.match(persona, /You: Pressed 2: No\./, "it knows what it pressed")
  assert.match(persona, /because: Driver reports a problem/)
  assert.match(persona, /\] work_assignments/, "the order's records")
  assert.deepEqual(callee.messages.slice(1), [{ role: "user", content: SIM_OPENER }])
  const check = JSON.parse(gateway.calls[2].messages[1].content as string) as { person_just_said: string; brief: string }
  assert.equal(check.person_just_said, FLAT)
  assert.match(check.brief, /Moved to tier 2: Driver reports a problem\./)
  assert.equal(sim.ear.heard.length, 0, "no transcription")
  assert.equal(sim.voiceModel.requests.length, 0, "no audio model")
  assert.ok(!sim.speech.spoken.includes(SIM_OPENER) && !sim.speech.spoken.includes("Thank you, noted. Goodbye."), "no speech at tier 2")
})

eachStore("a simulated call the agent cannot settle hands over to a person with the open question; a failed opener falls back to the template", async (engine) => {
  await engine.apply({ type: "runCalls" })

  const row = await order(engine, "CD-420806")
  const [call] = row.calls
  assert.equal(call.outcome, "handover")
  assert.equal(call.tier, 3)
  const opener = call.transcript.find((line) => line.tier === 2 && line.by === "agent")!
  assert.match(opener.text, /^About order CD-420806.* You answered "No" when I asked: Are you still on track with this delivery\? What is the problem with the delivery\?$/)
  assert.equal(call.transcript.find((line) => line.by === "callee" && line.tier === 2)?.text, OFFICE)
  assert.deepEqual(call.handover, {
    question: "May the car be delivered to the customer's office instead of their home?",
    nextStep: "Confirm the new address with the customer, then call the driver back.",
    summary: "The customer asked the driver to deliver to their office instead.",
    closed: null,
  })
  assert.deepEqual(call.changes, [OFFICE_CHANGE])
  assert.equal(row.callLines.find((line) => line.line === "driver")?.status, "handover")
  assert.equal(row.group, "needs_action")
}, { calls: () => simulated(jobGateway({
  "call-callee": [OFFICE],
  "call-check": [checkJson({
    heard: OFFICE, claims: ["Customer asked the driver to deliver to their office"], changes: [OFFICE_CHANGE],
    next: "handover", reply: "Thank you. A colleague from the control room will call you back shortly to settle this. Goodbye.",
    openQuestion: "May the car be delivered to the customer's office instead of their home?",
    nextStep: "Confirm the new address with the customer, then call the driver back.",
    summary: "The customer asked the driver to deliver to their office instead.",
  })],
})).calls })

const OFFICE_CHANGE = { title: "Deliver to the customer's office", change: "Deliver the car to the customer's office instead of their home.", claim: "Customer asked the driver to deliver to their office" }

test("a simulated person who cannot talk still ends an escalation as a handover, even with a voice agent", async () => {
  const gateway = jobGateway({})
  const engine = await testEngine({ calls: simulated(gateway, false).calls })
  await engine.apply({ type: "runCalls" })
  const [call] = (await order(engine, "CD-420806")).calls
  assert.equal(call.outcome, "handover")
  assert.match(call.transcript.filter((line) => line.by === "agent").at(-1)!.text, /colleague from the control room will follow up/)
  assert.equal(gateway.calls.length, 0, "no model was asked")
})
