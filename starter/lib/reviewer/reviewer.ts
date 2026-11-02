// The Reviewer: one fresh model context per order per run. It sends the cached
// system prompt and the prepared case file, lets the model use read-only tools at
// most `maxToolCalls` times, takes its answer through submit_findings, checks the
// evidence (one repair attempt, then drop), and caches the result by case-file hash.
// Approved lessons whose rule tags match the order's failing rules follow the system
// prompt as their own block (the cached prefix stays), and their hash joins the key.
//
//   const reviewer = createReviewer({ gateway, source, cache })
//   const result = await reviewer.review("CD-420516", { now, rules, prior })
//   const again = await reviewer.reviewFile(mistake.caseFile)   // a kept case file, as read then
//
// With no gateway (no ANTHROPIC_API_KEY) a cached result is still served; anything
// else comes back as "not reviewed yet" instead of failing.
//
// Each review that calls the model is one agent run (trace.ts) with the prompt version,
// the exact system prompt, the lessons in it and the case file's hash; the result names
// that run, and a cached result keeps naming it (serving from the cache writes nothing).

import { createHash } from "node:crypto"
import type { Bundle } from "@/lib/present/bundle"
import { lessonsFor, lessonsHash, renderLessons, type InjectedLesson, type LessonFeed } from "./lessons"
import { buildCaseFile, caseFileHash, renderCaseFile, type CaseFile, type CaseInput } from "./case-file"
import { createMemoryReviewCache, type ReviewCache } from "./cache"
import { addUsage, NO_USAGE, type ChatMessage, type Effort, type ModelGateway, type ToolCall, type Usage } from "./gateway"
import { PROMPT_VERSION, SYSTEM_PROMPT } from "./prompt"
import { findBundle, type ReviewSource } from "./source"
import { hashPrompt, promptOf, startRun } from "./trace"
import { READ_TOOL_SPECS, READ_TOOLS, runReadTool, SUBMIT_FINDINGS, SUBMIT_SPEC } from "./tools"
import { checkFinding, type Finding, type RecordIndex } from "./validate"

export type { Finding } from "./validate"

/** Anthropic model id for reasoning jobs (spec: ModelGateway table). Override with REVIEWER_MODEL. */
export const DEFAULT_REVIEWER_MODEL = "claude-haiku-5-5"
/** The lesson writer (lib/engine/distil.ts): a stronger model with medium thinking. Override with LESSONS_MODEL. */
export const DEFAULT_LESSONS_MODEL = "claude-opus-5-5"
export const DEFAULT_MAX_TOOL_CALLS = 8
export const NOT_REVIEWED_YET = "not reviewed yet"

export type DroppedFinding = { title: string | null; errors: string[] }

export type Reviewed = {
  status: "reviewed"
  orderId: string
  reference: string
  /** Hash of the case file the result answers. */
  hash: string
  summary: string
  findings: Finding[]
  /** Findings that failed the evidence check after their repair attempt. */
  dropped: DroppedFinding[]
  recordsRead: number
  /** Read-only tool calls that ran (at most the budget). */
  toolCalls: number
  /** Tool calls refused because the budget was used up. */
  refusedToolCalls: number
  turns: number
  /** Model cost of this call: 0 when served from the cache. */
  cost: number
  usage: Usage
  model: string
  /** When the model run happened (real time). */
  reviewedAt: string
  cached: boolean
  // Traceability. Absent on reviews cached before it.
  /** The agent run that produced this result (cr_agent_runs); null when the gateway was not traced. */
  runId?: string | null
  promptVersion?: string
  /** sha256 of the exact system prompt sent, lessons rendered in (cr_prompt_texts). */
  promptHash?: string
  /** The approved lessons in the prompt. */
  lessonIds?: string[]
}

export type NotReviewed = {
  status: "not_reviewed"
  orderId: string
  reference: string
  hash: string
  /** "not reviewed yet: ..." with the cause. */
  reason: string
  recordsRead: number
  cost: number
}

export type ReviewResult = Reviewed | NotReviewed

export type ReviewerOptions = {
  /** null when no API key is configured. */
  gateway: ModelGateway | null
  source: ReviewSource
  cache?: ReviewCache
  model?: string
  effort?: Effort
  maxToolCalls?: number
  /** Real time, for `reviewedAt`. */
  clock?: () => Date
  /** The approved reviewer lessons; absent: none. */
  lessons?: LessonFeed
}

export type Reviewer = {
  /** The case file the reviewer would send, e.g. to show "Reviewer read N records". */
  caseFile(orderIdOrReference: string, input: CaseInput): CaseFile
  review(orderIdOrReference: string, input: CaseInput): Promise<ReviewResult>
  /** Reviews a case file kept from earlier (a mistake's), exactly as it was read then. */
  reviewFile(file: CaseFile): Promise<ReviewResult>
}

const MAX_TOKENS = 8000

function systemMessage(lessons: InjectedLesson[]): ChatMessage {
  const block = renderLessons(lessons)
  return {
    role: "system",
    content: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }, ...(block ? [{ type: "text" as const, text: block }] : [])],
  }
}

/** The approved lessons for an order: tagged with one of its failing rules, or untagged. */
export function reviewerLessons(lessons: InjectedLesson[], input: CaseInput): InjectedLesson[] {
  return lessonsFor(lessons, (input.rules ?? []).filter((rule) => rule.status === "failed").map((rule) => rule.rule))
}

function parseArguments(call: ToolCall): { args: Record<string, unknown>; error: string | null } {
  try {
    const parsed = JSON.parse(call.function.arguments || "{}") as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { args: parsed as Record<string, unknown>, error: null }
    return { args: {}, error: "arguments must be a JSON object" }
  } catch (error) {
    return { args: {}, error: `arguments are not valid JSON: ${(error as Error).message}` }
  }
}

function parseArray(text: string): unknown[] | null {
  try {
    const parsed = JSON.parse(text) as unknown
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * The submitted findings as a list. Some models send the array JSON-encoded as a
 * string, sometimes with stray closing brackets after it; read both.
 */
function findingsList(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value
  if (typeof value !== "string") return null
  let text = value.trim()
  for (let i = 0; i < 4; i += 1) {
    const list = parseArray(text)
    if (list) return list
    const trimmed = text.replace(/\s*[}\]]$/, "")
    if (trimmed === text) return null
    text = trimmed
  }
  return null
}

function titleOf(raw: unknown): string | null {
  return raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).title === "string" ? (raw as { title: string }).title : null
}

export function createReviewer(options: ReviewerOptions): Reviewer {
  const { gateway, source } = options
  const cache = options.cache ?? createMemoryReviewCache()
  const model = options.model ?? process.env.REVIEWER_MODEL ?? DEFAULT_REVIEWER_MODEL
  const effort = options.effort ?? "medium"
  const budget = options.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS
  const clock = options.clock ?? (() => new Date())

  function bundleFor(key: string) {
    const bundle = findBundle(source, key)
    if (!bundle) throw new Error(`Unknown order ${key}`)
    return bundle
  }

  function caseFile(key: string, input: CaseInput): CaseFile {
    return buildCaseFile(bundleFor(key), source, input)
  }

  /** No lessons: the key as before lessons existed, so cached reviews still hit. */
  function cacheKey(hash: string, lessons: string): string {
    return createHash("sha256").update(`${PROMPT_VERSION}\n${model}\n${hash}${lessons ? `\n${lessons}` : ""}`).digest("hex")
  }

  function review(key: string, input: CaseInput): Promise<ReviewResult> {
    const bundle = bundleFor(key)
    return run(bundle, buildCaseFile(bundle, source, input))
  }

  async function run(bundle: Bundle, file: CaseFile): Promise<ReviewResult> {
    const input: CaseInput = { now: file.now, rules: file.rules }
    const hash = caseFileHash(file)
    const base = { orderId: file.orderId, reference: file.reference, hash, recordsRead: file.records.length }

    const lessons = reviewerLessons(options.lessons ? await options.lessons() : [], input)
    const resultKey = cacheKey(hash, lessonsHash(lessons))
    const hit = await cache.get(resultKey)
    if (hit) return { ...hit, cached: true, cost: 0 }
    if (!gateway) return { status: "not_reviewed", ...base, cost: 0, reason: `${NOT_REVIEWED_YET}: ANTHROPIC_API_KEY is not set` }

    const index: RecordIndex = new Map(file.records.map((record) => [record.id, record]))
    const ctx = { index, customerId: file.customer.id }
    const system = systemMessage(lessons)
    const prompt = promptOf([system])!
    const lessonIds = lessons.map((lesson) => lesson.id)
    const agentRun = startRun(gateway, { job: "reviewer", subject: file.reference, model, promptVersion: PROMPT_VERSION, prompt, lessonIds, inputHash: hash })
    const messages: ChatMessage[] = [system, { role: "user", content: renderCaseFile(file) }]
    let usage = NO_USAGE
    let usedTools = 0
    let refusedTools = 0
    let turns = 0
    let nudged = false
    let repairUsed = false
    let formatRetried = false
    let done = false
    let summary = ""
    let answeredModel = model
    const findings: Finding[] = []
    const dropped: DroppedFinding[] = []
    let awaitingRepair: DroppedFinding[] = []

    const notReviewed = async (reason: string): Promise<NotReviewed> => {
      await agentRun.finish({ outcome: `failed: ${reason}` })
      return { status: "not_reviewed", ...base, cost: usage.cost, reason: `${NOT_REVIEWED_YET}: ${reason}` }
    }

    /** Checks a submission; returns the tool result text for the model. */
    function submit(args: Record<string, unknown>): string {
      if (!summary && typeof args.summary === "string") summary = args.summary
      const raw = findingsList(args.findings)
      const repairing = repairUsed
      if (!raw) {
        // A format slip gets its own retry, so the evidence repair is still there.
        if (!formatRetried) {
          formatRetried = true
          return "findings must be a list (a JSON array of finding objects, not a string). Call submit_findings again; an empty list means nothing to ask."
        }
        done = true
        return "findings must be a list; the submission was dropped."
      }
      const failed: DroppedFinding[] = []
      for (const item of raw) {
        const check = checkFinding(item, ctx)
        if (check.ok) {
          const duplicate = findings.some((kept) => kept.title === check.finding.title && kept.question === check.finding.question)
          if (!duplicate) findings.push({ ...check.finding, repaired: repairing })
        } else {
          failed.push({ title: titleOf(item), errors: check.errors })
        }
      }
      if (failed.length === 0) {
        awaitingRepair = []
        done = true
        return `Accepted ${raw.length} finding(s).`
      }
      if (repairing) {
        dropped.push(...failed)
        awaitingRepair = []
        done = true
        return `Dropped ${failed.length} finding(s) that still fail the evidence check.`
      }
      repairUsed = true
      awaitingRepair = failed
      const list = failed.map((item, i) => `${i + 1}. "${item.title ?? "untitled"}": ${item.errors.join("; ")}`).join("\n")
      return `Accepted ${raw.length - failed.length} finding(s). These failed the evidence check and were not accepted:\n${list}\n`
        + "Call submit_findings once more with only the corrected findings (an empty list drops them). "
        + "Cite only record ids that exist and copy quotes exactly from the named field."
    }

    const maxTurns = budget + 4
    try {
      while (!done && turns < maxTurns) {
        const tools = usedTools >= budget ? [SUBMIT_SPEC] : [...READ_TOOL_SPECS, SUBMIT_SPEC]
        const response = await agentRun.gateway.chat({ job: "reviewer", subject: file.reference, model, effort, messages: [...messages], tools, maxTokens: MAX_TOKENS })
        turns += 1
        usage = addUsage(usage, response.usage)
        answeredModel = response.model || answeredModel
        messages.push(response.message)
        const calls = response.message.tool_calls ?? []
        if (calls.length === 0) {
          if (nudged) break
          nudged = true
          messages.push({ role: "user", content: "Answer by calling submit_findings (an empty findings list means nothing to ask)." })
          continue
        }
        for (const call of calls) {
          const { args, error } = parseArguments(call)
          let content: string
          if (error) content = `Not run: ${error}.`
          else if (call.function.name === SUBMIT_FINDINGS) content = submit(args)
          else if (!READ_TOOLS.has(call.function.name)) content = `Unknown tool ${call.function.name}.`
          else if (usedTools >= budget) {
            refusedTools += 1
            content = `Not run: the tool budget of ${budget} calls is used up. Call submit_findings now.`
          } else {
            usedTools += 1
            const output = runReadTool(call.function.name, args, source, bundle)
            for (const record of output.records) if (!index.has(record.id)) index.set(record.id, record)
            content = output.content
          }
          messages.push({ role: "tool", tool_call_id: call.id, content })
        }
      }
    } catch (error) {
      return notReviewed(`the model call failed (${(error as Error).message})`)
    }

    if (!done && !repairUsed && findings.length === 0) return notReviewed("the model did not submit findings")
    // A repair that never came: the failing findings are dropped.
    dropped.push(...awaitingRepair)

    const result: Reviewed = {
      status: "reviewed", ...base, summary, findings, dropped,
      toolCalls: usedTools, refusedToolCalls: refusedTools, turns,
      cost: usage.cost, usage, model: answeredModel, reviewedAt: clock().toISOString(), cached: false,
      runId: agentRun.id, promptVersion: PROMPT_VERSION, promptHash: hashPrompt(prompt), lessonIds,
    }
    await agentRun.finish({ outcome: "ok" })
    await cache.put(resultKey, result)
    return result
  }

  return { caseFile, review, reviewFile: (file) => run(bundleFor(file.orderId), file) }
}
