// Agent runs (spec .scratch/traceability): every model call is kept under the run that
// made it, with the exact prompt, so an engineer can follow a line on an order back to
// what the model was told and said.
//
//   const gateway = createTracedGateway(anthropic, store)     // where the gateway is made
//   const run = startRun(gateway, { job: "reviewer", subject, model, prompt, lessonIds })
//   await run.gateway.chat(request)                            // turn 1, 2, ... under the run
//   await run.finish({ outcome: "ok" })                        // usage and cost: its own turns'
//
// - A call with no run (`gateway.chat`) gets a one-turn run of its own from its job and
//   subject, so agents that open no run are still covered.
// - A run opened through a run's gateway is that run's child (the gate's reviews and
//   judges under their distil run).
// - An untraced gateway (tests, eval scripts) gives runs with id null and writes nothing.
// - The system prompt is stored once by hash (cr_prompt_texts); a logged request keeps
//   only its hash in the system message's place. The request is what the agent handed
//   the gateway: the provider adds auth outside it, so no key is ever logged.
// - Tracing never breaks or slows an agent: writes run off the call's path, in order per
//   run, and a failed write is logged and swallowed. `finish` waits for the run's writes;
//   a script calls `flush()` before it closes the database.

import { createHash, randomUUID } from "node:crypto"
import { performance } from "node:perf_hooks"
import { addUsage, NO_USAGE, type ChatMessage, type ChatRequest, type ChatResponse, type ModelGateway, type TextPart, type Usage } from "./gateway"

export type RunStart = {
  job: string
  subject: string
  model: string
  /** Default: the run whose gateway opened this one, else none. */
  parentRunId?: string | null
  promptVersion?: string | null
  /** The exact system prompt as sent (see `promptOf`); stored once, named by its hash. */
  prompt?: string | null
  /** The lessons in the prompt. */
  lessonIds?: string[]
  /** A hash of what the run read (the reviewer: the case file's). */
  inputHash?: string | null
}

export type RunEnd = {
  /** "ok", "failed" or free text. */
  outcome: string
  /** Default: the sum of the run's own turns (child runs keep theirs). */
  usage?: Usage
  cost?: number
}

export type AgentRun = {
  /** null when the gateway is not traced. */
  readonly id: string | null
  /** Calls through it are this run's turns; runs opened through it are its children. */
  readonly gateway: ModelGateway
  /** Once; later calls do nothing. Never throws. */
  finish(end: RunEnd): Promise<void>
}

export type TracedGateway = ModelGateway & { startRun(start: RunStart): AgentRun }

/** One row of cr_agent_runs. */
export type AgentRunRow = {
  id: string
  job: string
  subject: string
  parentRunId: string | null
  promptVersion: string | null
  promptHash: string | null
  model: string
  lessonIds: string[]
  inputHash: string | null
  /** Real time. */
  startedAt: string
  finishedAt: string | null
  /** "running" until finished. */
  outcome: string
  usage: Usage | null
  cost: number | null
}

export type LoggedRequest = Omit<ChatRequest, "job" | "subject" | "messages"> & {
  /** The messages as sent, a system message as `{ role: "system", promptHash }`. */
  messages: unknown[]
}

export type LoggedResponse = Pick<ChatResponse, "message" | "finishReason" | "model"> & { id?: string }

/** One row of cr_model_calls: one model turn. */
export type ModelCallRow = {
  runId: string
  /** From 1, in the order the run made them. */
  turn: number
  /** When the call was sent (real time). */
  at: string
  latencyMs: number
  request: LoggedRequest
  response: LoggedResponse | null
  usage: Usage | null
  error: string | null
}

export type RunQuery = Partial<Pick<AgentRunRow, "job" | "subject" | "parentRunId">>

export type RunFinish = Pick<AgentRunRow, "finishedAt" | "outcome" | "usage" | "cost">

/** Where runs, turns and prompt texts are kept: memory (tests) or Postgres (postgres-trace.ts). */
export type TraceStore = {
  startRun(row: AgentRunRow): Promise<void>
  finishRun(id: string, end: RunFinish): Promise<void>
  addCall(row: ModelCallRow): Promise<void>
  /** Keeps the first text for a hash. */
  putPrompt(hash: string, text: string): Promise<void>
  readRun(id: string): Promise<AgentRunRow | null>
  /** The runs matching every given field, oldest first. */
  readRuns(where: RunQuery): Promise<AgentRunRow[]>
  /** In turn order. */
  readCalls(runId: string): Promise<ModelCallRow[]>
  readPrompt(hash: string): Promise<string | null>
}

/** A system message's text: its parts in order, separated by a blank line. */
export function systemText(content: string | TextPart[]): string {
  return typeof content === "string" ? content : content.map((part) => part.text).join("\n\n")
}

/** The system prompt of a request as stored: every system message's text; null for none. */
export function promptOf(messages: ChatMessage[]): string | null {
  const system = messages.filter((message) => message.role === "system")
  return system.length ? system.map((message) => systemText(message.content)).join("\n\n") : null
}

export function hashPrompt(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

function isTraced(gateway: ModelGateway): gateway is TracedGateway {
  return typeof (gateway as Partial<TracedGateway>).startRun === "function"
}

/** Opens a run on `gateway`; an untraced gateway gives a run with id null that records nothing. */
export function startRun(gateway: ModelGateway, start: RunStart): AgentRun {
  if (isTraced(gateway)) return gateway.startRun(start)
  return { id: null, gateway, finish: async () => {} }
}

/**
 * A gateway that runs `around` on every call, including the calls of runs opened
 * through it (e.g. a spend meter that must also see the gate's reviews).
 */
export function interceptGateway(inner: ModelGateway, around: (request: ChatRequest, next: (request: ChatRequest) => Promise<ChatResponse>) => Promise<ChatResponse>): ModelGateway {
  const chat = (request: ChatRequest) => around(request, (next) => inner.chat(next))
  if (!isTraced(inner)) return { chat }
  const traced: TracedGateway = {
    chat,
    startRun(start) {
      const run = inner.startRun(start)
      return { id: run.id, finish: run.finish, gateway: interceptGateway(run.gateway, around) }
    },
  }
  return traced
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error)

export type TraceOptions = {
  /** Real time. */
  clock?: () => Date
  /** Where failed trace writes are reported; default console.error. */
  log?: (line: string) => void
}

export type TracingGateway = TracedGateway & {
  /** Resolves once every trace write started so far has landed (tests, scripts before exit). */
  flush(): Promise<void>
}

/**
 * `inner` with every call kept in `store`. Writes run in order per run, off the call's
 * path: a reply is handed back without waiting for its turn to be stored, and
 * `finish` resolves once the run's writes have landed.
 */
export function createTracedGateway(inner: ModelGateway, store: TraceStore, options: TraceOptions = {}): TracingGateway {
  const clock = options.clock ?? (() => new Date())
  const log = options.log ?? ((line: string) => console.error(`trace: ${line}`))
  /** Prompt hashes already stored by this process. */
  const stored = new Set<string>()
  const pending = new Set<Promise<unknown>>()

  async function safely(what: string, write: () => Promise<void>): Promise<boolean> {
    try {
      await write()
      return true
    } catch (error) {
      log(`${what} not recorded: ${message(error)}`)
      return false
    }
  }

  async function savePrompt(text: string): Promise<string> {
    const hash = hashPrompt(text)
    if (!stored.has(hash)) {
      stored.add(hash)
      if (!await safely("prompt text", () => store.putPrompt(hash, text))) stored.delete(hash)
    }
    return hash
  }

  async function logged(request: ChatRequest): Promise<LoggedRequest> {
    const { job: _job, subject: _subject, messages, ...rest } = request
    const out: unknown[] = []
    for (const item of messages) out.push(item.role === "system" ? { role: "system", promptHash: await savePrompt(systemText(item.content)) } : item)
    return { ...rest, messages: out }
  }

  function open(start: RunStart): AgentRun {
    const id = `run-${randomUUID()}`
    const startedAt = clock().toISOString()
    let turns = 0
    let usage = NO_USAGE
    let finished = false
    /** This run's writes, one after another. */
    let queue: Promise<unknown> = Promise.resolve()
    const write = (what: string, work: () => Promise<void>): Promise<unknown> => {
      const next = queue.then(() => safely(what, work))
      queue = next
      pending.add(next)
      void next.finally(() => pending.delete(next))
      return next
    }

    write(`run ${id}`, async () => {
      const promptHash = start.prompt == null ? null : await savePrompt(start.prompt)
      await store.startRun({
        id, job: start.job, subject: start.subject, parentRunId: start.parentRunId ?? null, promptVersion: start.promptVersion ?? null,
        promptHash, model: start.model, lessonIds: start.lessonIds ?? [], inputHash: start.inputHash ?? null,
        startedAt, finishedAt: null, outcome: "running", usage: null, cost: null,
      })
    })

    const gateway: TracedGateway = {
      async chat(request) {
        turns += 1
        const turn = turns
        const at = clock().toISOString()
        const began = performance.now()
        const sent = { ...request, messages: [...request.messages] }
        const record = (rest: Pick<ModelCallRow, "response" | "usage" | "error">) => {
          const latencyMs = Math.round(performance.now() - began)
          write(`turn ${turn} of ${id}`, async () => store.addCall({ runId: id, turn, at, latencyMs, request: await logged(sent), ...rest }))
        }
        try {
          const response = await inner.chat(request)
          usage = addUsage(usage, response.usage)
          const { message: reply, finishReason, model, id: responseId } = response
          record({ response: { message: reply, finishReason, model, ...(responseId ? { id: responseId } : {}) }, usage: response.usage, error: null })
          return response
        } catch (error) {
          record({ response: null, usage: null, error: message(error) })
          throw error
        }
      },
      startRun: (child) => open({ ...child, parentRunId: child.parentRunId ?? id }),
    }

    return {
      id,
      gateway,
      async finish(end) {
        if (finished) return
        finished = true
        const total = end.usage ?? usage
        const finishedAt = clock().toISOString()
        await write(`end of ${id}`, () => store.finishRun(id, { finishedAt, outcome: end.outcome, usage: total, cost: end.cost ?? total.cost }))
      },
    }
  }

  return {
    async chat(request) {
      const run = open({ job: request.job, subject: request.subject, model: request.model, prompt: promptOf(request.messages) })
      try {
        const response = await run.gateway.chat(request)
        void run.finish({ outcome: "ok" })
        return response
      } catch (error) {
        void run.finish({ outcome: "failed" })
        throw error
      }
    },
    startRun: open,
    async flush() {
      while (pending.size) await Promise.all([...pending])
    },
  }
}

/** Runs, turns and prompts in memory, for tests. */
export function createMemoryTraceStore(): TraceStore {
  const runs = new Map<string, AgentRunRow>()
  const calls: ModelCallRow[] = []
  const prompts = new Map<string, string>()
  return {
    async startRun(row) { if (!runs.has(row.id)) runs.set(row.id, structuredClone(row)) },
    async finishRun(id, end) {
      const row = runs.get(id)
      if (row) runs.set(id, { ...row, ...structuredClone(end) })
    },
    async addCall(row) {
      if (!calls.some((call) => call.runId === row.runId && call.turn === row.turn)) calls.push(structuredClone(row))
    },
    async putPrompt(hash, text) { if (!prompts.has(hash)) prompts.set(hash, text) },
    async readRun(id) { return runs.has(id) ? structuredClone(runs.get(id)!) : null },
    async readRuns(where) {
      const matches = (row: AgentRunRow) => (Object.keys(where) as (keyof RunQuery)[]).every((key) => where[key] === undefined || row[key] === where[key])
      return structuredClone([...runs.values()].filter(matches).sort((a, b) => a.startedAt.localeCompare(b.startedAt)))
    },
    async readCalls(runId) { return structuredClone(calls.filter((call) => call.runId === runId).sort((a, b) => a.turn - b.turn)) },
    async readPrompt(hash) { return prompts.get(hash) ?? null },
  }
}
