// Tier 2, the voice agent (ticket 12). When keypad answers are not enough the call
// moves to tier 2 and the callee talks (push-to-talk on the phone page). Each turn:
//
//   1. the ear (a transcription model) writes down what the callee said, and, at the
//      same time, the audio model (audio in, audio out) answers them aloud from a short
//      brief (not the case file);
//   2. the checker (Haiku, through the ModelGateway) reads the transcript against the
//      brief's facts and the policy and writes the structured result: claims, changes
//      the callee asked for, conflicts with the records, whether the agent's reply is
//      allowed, and whether to go on, end resolved or hand over;
//   3. the agent says the audio model's reply when the checker allows it and the call
//      goes on; otherwise it says the checker's own reply through text to speech.
//
// Fallback: when the audio model fails (or none is configured), the ear listens, the
// checker decides and writes the reply, and text to speech speaks it.
//
// Simulated calls talk too, in text: a model plays the callee (simulated-person.ts) and
// its words go straight to step 2 ("text" path). No ear, no audio model, no speech; the
// checker writes every reply, exactly as in the fallback.
//
// The opener: the agent does not start from zero. It says what it already knows (the
// order, the keypad answers, why the call escalated) and asks one specific question. The
// checker's model writes it from the brief; a template stands in when that fails.
//
// The voice agent gathers information only. It never agrees to a change: a change
// the callee wants becomes a change proposal (needs the operator's yes) when the call
// ends, and what they said becomes the call result (engine `callEnded`).

import type { ChatMessage, ModelGateway } from "@/lib/reviewer/gateway"
import { DEFAULT_REVIEWER_MODEL } from "@/lib/reviewer/reviewer"
import { rows, str, type Bundle } from "@/lib/present/bundle"
import { localTime, type Call, type CallChange } from "./calls"
import { latestEta } from "./eta"
import { selectedPromise } from "./order-facts"
import type { Speech } from "./speech"
import { estimateSeconds } from "./speech"

/** A recording from the phone, base64 without a data: prefix. */
export type AudioClip = { data: string; format: "wav" | "mp3" | "webm" | "ogg" | "m4a" | "flac" }

export type Heard = { text: string; cost: number; seconds: number; model: string }

/** The ear: speech to text. */
export interface Transcriber {
  transcribe(clip: AudioClip, subject: string): Promise<Heard>
}

/** One exchange so far, as text, for the audio model's context. */
export type VoiceTurn = { by: "agent" | "callee"; text: string }

export type VoiceReply = { text: string; audioId: string | null; seconds: number; cost: number; model: string }

/** The audio-in, audio-out model: answers the callee's recording aloud. */
export interface VoiceModel {
  reply(input: { brief: string; history: VoiceTurn[]; clip: AudioClip; subject: string }): Promise<VoiceReply>
}

export type TurnNext = "continue" | "resolved" | "handover"

/** The checker's structured result for one turn (shown in the transcript). */
export type TurnCheck = {
  /** What the callee said, cleaned up. */
  heard: string
  /** Facts the callee stated, as short attributed claims. */
  claims: string[]
  /** Changes the callee asked for or reported: each becomes a change proposal (needs a yes). */
  changes: CallChange[]
  /**
   * The newest arrival time the callee gave (their local "HH:MM"), or null. Not a change
   * to the order: the engine records it as the driver's reported ETA (`eta_reported`).
   */
  eta?: CheckedEta | null
  /** Where what they said disagrees with the records in the brief. */
  conflicts: string[]
  /** Did the audio model's reply stay inside the policy (no promise, no agreeing to a change)? Null when there was no reply to check. */
  replyOk: boolean | null
  /** Why the reply was not allowed, when it was not. */
  replyIssue: string | null
  /** What the agent says next when the audio model's reply is not used. */
  reply: string
  next: TurnNext
  /** For a handover: the open question a person must settle, and the proposed next step (ticket 14). */
  openQuestion: string | null
  nextStep: string | null
  /** One line for the order's call summary. */
  summary: string
  /** The checker failed and this safe check stands in: it records nothing. */
  failed?: boolean
}

/** An ETA the callee stated: local "HH:MM" in their zone (or `at`, ISO UTC, when known) and their words. */
export type CheckedEta = { local: string; at?: string; claim: string }

/**
 * Who made the words the agent said: the audio model ("voice"), the checker because the
 * audio model's reply was not allowed ("replaced"), the checker because the audio model
 * failed ("fallback"), or the checker on a simulated callee's text turn ("text").
 */
export type TurnPath = "voice" | "replaced" | "fallback" | "text"

export type TurnResult = {
  heard: Heard
  check: TurnCheck
  checkCost: number
  checkModel: string
  /** The checker failed: a safe check stands in for it. */
  checkError: string | null
  path: TurnPath
  /** Why the audio model was not used, when it was not. */
  voiceError: string | null
  /** What the agent says now. */
  said: { text: string; audioId: string | null; seconds: number; cost: number; model: string | null; from: "voice" | "speech" }
}

/** The agent's first words at tier 2, and what writing them cost. */
export type Opener = { text: string; cost: number; model: string | null; error: string | null }

/** What the callee said: a recording (live phone) or text (a simulated callee). */
export type TurnInput = { clip: AudioClip } | { text: Heard }

export type VoiceAgent = {
  /**
   * The first words at tier 2: what the agent already knows, then one specific question.
   * Per call, so its speech is generated per call (the cache only helps a repeat).
   */
  opener(input: { call: Call; brief: string }): Promise<Opener>
  turn(input: TurnInput & { call: Call; brief: string; history: VoiceTurn[]; speech: Speech | null; turn: number }): Promise<TurnResult>
  /** Turns a call may take before the agent hands it over. */
  maxTurns: number
  /** Can it take recordings (has an ear)? Without one it talks with simulated callees only. */
  listens: boolean
}

export type VoiceAgentOptions = {
  /** The audio model; null or a failure uses the fallback. */
  voice?: VoiceModel | null
  /** The ear; null when no transcription model is configured (text turns only). */
  ear: Transcriber | null
  /** Haiku's gateway (the reviewer's ModelGateway). */
  checker: ModelGateway
  model?: string
  maxTurns?: number
}

const SAFE_REPLY = "Thank you. Could you tell me a little more about that?"

/** The rules every reply follows; the audio model's system prompt and the checker's policy. */
export const VOICE_POLICY = [
  "You gather information only. Never agree to, promise or confirm a change to the order (time, address, contact, receiver, cost, route).",
  "If the person asks for a change or reports one, say you have noted it and a colleague in the control room will review it.",
  "Start by acknowledging in a few words what the person just told you, including any time or place they gave. Then ask one short question that moves the call on: what the problem is, what it means for the delivery, or what they will do next.",
  "Two sentences at most. Plain spoken English, no lists.",
  "Never invent facts. Never discuss prices or blame.",
].join("\n")

export function createVoiceAgent(options: VoiceAgentOptions): VoiceAgent {
  const model = options.model ?? DEFAULT_REVIEWER_MODEL
  const maxTurns = options.maxTurns ?? 4
  const ear = options.ear
  return {
    maxTurns,
    listens: ear !== null,
    async opener({ call, brief }) {
      const fallback = openerTemplate(call)
      try {
        const response = await options.checker.chat({ job: "call-opener", subject: call.reference, model, effort: "none", maxTokens: 200, messages: openerMessages(brief) })
        const written = (response.message.content ?? "").trim().replace(/^["']|["']$/g, "").trim()
        // One sentence of context and one question: anything else is the template's job.
        const usable = written.length >= 20 && written.length <= 400 && written.includes("?") && !written.includes("\n")
        return { text: usable ? written : fallback, cost: response.usage.cost, model: response.model, error: usable ? null : "The opener was not one short spoken question" }
      } catch (error) {
        return { text: fallback, cost: 0, model: null, error: message(error) }
      }
    },
    async turn(input) {
      const { call, brief, history, speech, turn } = input
      const subject = call.reference
      // The ear and the audio model run side by side: the transcript does not wait for the reply.
      // A text turn (simulated callee) has neither: the checker writes the reply.
      if (!("text" in input) && !ear) throw new Error("No transcription model: the voice agent cannot hear a recording")
      const [heard, voiced] = "text" in input ? [input.text, { reply: null, error: null }] as const : await Promise.all([
        ear!.transcribe(input.clip, subject),
        options.voice
          ? options.voice.reply({ brief, history, clip: input.clip, subject }).then((reply) => ({ reply, error: null }), (error: unknown) => ({ reply: null, error: message(error) }))
          : Promise.resolve({ reply: null, error: "no audio model configured" }),
      ])
      const draft = voiced.reply
      let check: TurnCheck
      let checkCost = 0
      let checkModel = model
      let checkError: string | null = null
      try {
        const response = await options.checker.chat({
          job: "call-check", subject, model, effort: "none", maxTokens: 900,
          messages: checkMessages({ brief, history, heard: heard.text, draft: draft?.text ?? null, turn, maxTurns }),
        })
        checkCost = response.usage.cost
        checkModel = response.model
        check = parseCheck(response.message.content ?? "", heard.text, draft !== null)
      } catch (error) {
        checkError = message(error)
        check = safeCheck(heard.text, draft !== null, turn >= maxTurns)
      }
      if (turn >= maxTurns && check.next === "continue") {
        check = { ...check, next: "handover", openQuestion: check.openQuestion ?? "The call ran out of turns before the problem was settled.", reply: handoverReply() }
      }
      if (check.next !== "continue") check = { ...check, reply: closing(check.reply) }
      const useVoice = draft !== null && check.replyOk === true && check.next === "continue"
      let said: TurnResult["said"]
      if (useVoice) {
        said = { ...draft, from: "voice" }
      } else {
        const text = check.reply || SAFE_REPLY
        const spoken = speech ? await speech.speak(text) : null
        said = { text, audioId: spoken?.audioId ?? null, seconds: spoken?.seconds ?? estimateSeconds(text), cost: (draft?.cost ?? 0) + (spoken?.cost ?? 0), model: spoken?.model ?? null, from: "speech" }
      }
      const path: TurnPath = "text" in input ? "text" : !draft ? "fallback" : useVoice ? "voice" : "replaced"
      return { heard, check, checkCost, checkModel, checkError, path, voiceError: voiced.error, said }
    },
  }
}

/**
 * The short brief the audio model and the checker read: who, why, what the keypad
 * said, and the few facts the call is about (times in the callee's zone). Not the case file.
 */
export function briefFor(bundle: Bundle, call: Call): string {
  const local = (iso: string) => `${localTime(iso, call.zone)}`
  const name = call.callee.name ? call.callee.name.split(",")[0] : call.callee.handle
  const windowOf = (purpose: string) => rows(bundle, "time_windows").find((row) => row.details.purpose === purpose && row.details.is_selected === true)
  const facts: string[] = []
  const promise = selectedPromise(bundle)
  const slot = windowOf("SELECTED_PICKUP_SLOT")
  if (call.line === "driver") {
    const start = str(promise?.details.start_at)
    const end = str(promise?.details.end_at)
    if (start && end) facts.push(`Delivery promise to the customer: ${local(start)} to ${local(end)} (${call.zone}).`)
    const eta = latestEta(bundle)
    if (eta) facts.push(`Latest ETA on record: ${local(eta.at)}${eta.reported ? " (reported by the driver on an earlier call)" : ""}.`)
  } else {
    const start = str(slot?.details.start_at)
    const end = str(slot?.details.end_at)
    if (start && end) facts.push(`Booked pickup slot: ${local(start)} to ${local(end)} (${call.zone}).`)
  }
  const keypad = keypadSoFar(call).map(({ question, label }) => `"${question}" ${label}.`)
  const escalation = escalationOf(call)
  return [
    `Order ${call.reference}${call.car ? `, a ${call.car}` : ""}.`,
    `You are the car delivery control room's assistant on the phone with ${name}, the ${call.line === "driver" ? "assigned driver" : `contact at the pickup site${call.callee.role ? ` (${call.callee.role})` : ""}`}.`,
    `Why we called (control room note, times in the control room's zone): ${call.reason}`,
    ...(keypad.length ? [`Keypad answers so far: ${keypad.join(" ")}`] : []),
    ...(escalation ? [`Moved to tier 2: ${escalation}.`] : []),
    ...facts,
    "Goal: find out what the problem is, what it means for the delivery, and what they will do next.",
  ].join("\n")
}

/** The tier-1 questions the callee answered on the keypad, without the "Press 1 for..." part. */
function keypadSoFar(call: Call): { question: string; label: string }[] {
  return call.answers.filter((answer) => answer.ask.startsWith("q")).flatMap((answer) => {
    const question = call.questions[Number(answer.ask.slice(1))]
    return question ? [{ question: question.text.replace(/\s*Press \d.*$/, ""), label: answer.label || `pressed ${answer.digit}` }] : []
  })
}

/** Why the call moved to tier 2: the escalation the call logged ("Moved to tier 2: <why>."). */
function escalationOf(call: Call): string | null {
  const line = call.transcript.find((row) => row.by === "system" && row.text.startsWith("Moved to tier 2: "))?.text
  return line ? line.slice("Moved to tier 2: ".length).replace(/\.$/, "") : null
}

/** The one question the template asks per escalation (call-script.ts escalate effects). */
const OPENER_QUESTION: Record<string, string> = {
  "Driver cannot deliver within the promised window": "What time do you now expect to arrive?",
  "Driver reports a problem": "What is the problem with the delivery?",
  "The car will not be ready in the booked slot": "When will the car be ready for collection?",
  "No signed release at the site yet": "When will the signed release be ready for our driver?",
  "Says they are not the pickup contact": "Who should our driver ask for at pickup?",
  "Key collection is more complicated": "Where exactly should our driver collect the keys?",
}

/** The opener without a model: the order, the last keypad answer, one question for the escalation. */
export function openerTemplate(call: Call): string {
  const last = keypadSoFar(call).at(-1)
  const why = escalationOf(call)
  const heard = last ? ` You answered "${last.label}" when I asked: ${last.question}` : ""
  // A reviewer question (or an unclear answer) has no fixed follow-up: ask it in words.
  const question = (why && OPENER_QUESTION[why]) ?? (last && why === "Can answer, needs a conversation" ? `Go ahead: ${last.question}` : "Could you tell me in a few words what is going on?")
  return `About order ${call.reference}${call.car ? `, the ${call.car}` : ""}.${heard} ${question}`
}

function openerMessages(brief: string): ChatMessage[] {
  const system = [
    "You are the car delivery control room's voice assistant. A phone call has just moved from keypad questions to a spoken conversation. Write the first words you say now.",
    "First, in one short sentence, say what you already know: the order, what the person answered on the keypad and why that needs a conversation. Then ask exactly one specific question that helps find out what the problem is, what it means for the delivery, or what they will do next.",
    "Do not greet them again and do not introduce yourself: you are already on the call. Use the times as written in the brief (the person's local time).",
    "Policy:", VOICE_POLICY,
    "Reply with only the words to say, no quotes.",
  ].join("\n")
  return [{ role: "system", content: system }, { role: "user", content: brief }]
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The last words of a call ask nothing: the checker now and then leaves a question in
 * front of "Goodbye." (seen live), which the callee could never answer. Drop it.
 */
function closing(reply: string): string {
  const kept = reply.split(/(?<=[.!?])\s+/).filter((sentence) => !sentence.trim().endsWith("?")).join(" ").trim()
  if (!kept) return "Thank you, I've noted that. Goodbye."
  return /goodbye[.!]?$/i.test(kept) ? kept : `${kept} Goodbye.`
}

function handoverReply(): string {
  return "Thank you, that helps. A colleague from the control room will call you back shortly to settle this. Goodbye."
}

/** The checker's stand-in when the checker fails: record nothing, hand over after a second failure or at the turn limit. */
function safeCheck(heard: string, hadDraft: boolean, last: boolean): TurnCheck {
  return {
    failed: true, heard, claims: [], changes: [], conflicts: [], replyOk: hadDraft ? false : null, replyIssue: hadDraft ? "Not checked: the checker failed." : null,
    reply: last ? handoverReply() : SAFE_REPLY, next: last ? "handover" : "continue",
    openQuestion: last ? "The agent could not check what was said." : null, nextStep: last ? "Call the driver back and settle the problem." : null,
    summary: heard ? `Said: ${heard}` : "Nothing heard.",
  }
}

function checkMessages(input: { brief: string; history: VoiceTurn[]; heard: string; draft: string | null; turn: number; maxTurns: number }): ChatMessage[] {
  const system = [
    "You check one turn of a phone call made by the delivery control room's voice agent. You return JSON only.",
    "Policy for the agent:", VOICE_POLICY,
    "",
    "Return exactly this JSON object:",
    `{"heard": string (what the person said, cleaned up),
 "claims": string[] (ALL facts the person has stated on this call so far, merged and without repeats, short, e.g. "Expects to arrive at 16:40 local"),
 "changes": {"title": string, "change": string, "claim": string}[] (ALL changes to the order the person asked for or reported on this call so far, one per subject, e.g. a new address or a different receiver; NOT an arrival time, which goes in "eta"; empty if none),
 "eta": {"local": "HH:MM" (24-hour, the person's local time), "claim": string} | null (the newest arrival time the person gave on this call, e.g. "about half past four" -> "16:30"; null if they gave none),
 "conflicts": string[] (where the person's words disagree with the facts in the brief),
 "replyOk": boolean | null (null when there is no draft reply; false ONLY if the draft agrees to, promises or confirms a change, invents facts, discusses prices, or makes no sense after what the person said; wording and style are not reasons),
 "replyIssue": string | null,
 "reply": string (what the agent should say next, following the policy; when next is "continue" it asks one short question; when next is not "continue" it asks nothing, says what was noted and ends with "Goodbye."),
 "next": "continue" | "resolved" | "handover" ("resolved" when the agent knows what the problem is, what it means for the delivery and what the person will do, or the person has nothing more to say; a new arrival time does NOT need a handover, it is recorded as the driver's ETA, and a reported change becomes a proposal for the operator; "handover" only when the person needs a decision now, asks for a person, or the situation is still unclear; if the only open matter is a change you listed, next is "resolved"),
 "openQuestion": string | null (for handover: the question a person must settle),
 "nextStep": string | null (for handover: the proposed next step for the operator),
 "summary": string (one line: what the call learned so far)}`,
    `This is turn ${input.turn} of at most ${input.maxTurns}. On the last turn, next must not be "continue".`,
  ].join("\n")
  const user = JSON.stringify({
    brief: input.brief,
    transcript_so_far: input.history,
    person_just_said: input.heard,
    agent_draft_reply: input.draft,
  }, null, 1)
  return [{ role: "system", content: system }, { role: "user", content: user }]
}

const NEXT: TurnNext[] = ["continue", "resolved", "handover"]

const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((row): row is string => typeof row === "string" && !!row.trim()).map((row) => row.trim()) : []
const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null

/** The checker's JSON (code fences allowed). Throws when it is not a usable check. */
export function parseCheck(content: string, heard: string, hadDraft: boolean): TurnCheck {
  const body = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
  const start = body.indexOf("{")
  const end = body.lastIndexOf("}")
  if (start < 0 || end < start) throw new Error("The checker did not reply with JSON")
  const raw = JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>
  const next = NEXT.includes(raw.next as TurnNext) ? raw.next as TurnNext : null
  if (!next) throw new Error(`The checker's next step is not one of ${NEXT.join(", ")}`)
  const reply = text(raw.reply)
  if (!reply || reply.length > 500) throw new Error("The checker wrote no usable reply")
  const changes: CallChange[] = Array.isArray(raw.changes) ? raw.changes.flatMap((row) => {
    const item = row && typeof row === "object" ? row as Record<string, unknown> : {}
    const title = text(item.title)
    const change = text(item.change)
    return title && change ? [{ title, change, claim: text(item.claim) ?? change }] : []
  }) : []
  const etaRaw = raw.eta && typeof raw.eta === "object" ? raw.eta as Record<string, unknown> : null
  const etaLocal = text(etaRaw?.local)
  const eta: CheckedEta | null = etaLocal && /^\d{1,2}:\d{2}$/.test(etaLocal) ? { local: etaLocal, claim: text(etaRaw?.claim) ?? `Expects to arrive at ${etaLocal} local` } : null
  return {
    heard: text(raw.heard) ?? heard,
    claims: strings(raw.claims),
    changes,
    eta,
    conflicts: strings(raw.conflicts),
    replyOk: hadDraft ? raw.replyOk === true : null,
    replyIssue: text(raw.replyIssue),
    reply,
    next,
    openQuestion: text(raw.openQuestion),
    nextStep: text(raw.nextStep),
    summary: text(raw.summary) ?? (text(raw.heard) ?? heard),
  }
}
