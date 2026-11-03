"use client"

// The support inbox: threads on the left, the open thread on the right. On a thread the
// operator can link an order (lib/engine/inbox.ts), read the inbox agent's suggestion
// (lib/engine/inbox-agent.ts: a draft reply and, on linked orders, the steps that answer
// the thread) and send a reply. The agent suggests only; the operator sends and acts.

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react"
import type { InboxSuggestion } from "@/lib/engine/inbox-agent"
import { fmtDateTime, fmtDay } from "@/lib/present/time"
import type { InboxThreadView, InboxView } from "@/lib/present/types"
import { Shell } from "../components/shell"
import { Icon } from "../components/icons"
import { CLOCK_EVENT } from "../components/demo-clock"
import { SituationCard } from "../components/situation"
import { ActorName, OrderLink, OrderLinks, Pill, When } from "../components/ui"

async function act(body: Record<string, unknown>): Promise<InboxView> {
  const response = await fetch("/api/inbox", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  const data = await response.json().catch(() => null) as { view?: InboxView; error?: string } | null
  if (!response.ok || !data?.view) throw new Error(data?.error ?? "Nothing changed")
  return data.view
}

export default function InboxPage() {
  const [view, setView] = useState<InboxView | null>(null)
  const [error, setError] = useState("")
  const [selected, setSelected] = useState<string | null>(null)
  const [showList, setShowList] = useState(true)

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch("/api/inbox", { signal })
      if (!response.ok) throw new Error("Could not load the inbox")
      const data = await response.json() as { view: InboxView }
      setView(data.view)
      setError("")
      setSelected((current) => {
        if (current && data.view.threads.some((thread) => thread.id === current)) return current
        const wanted = window.location.hash.replace(/^#/, "")
        return (data.view.threads.find((thread) => thread.id === wanted) ?? data.view.threads[0])?.id ?? null
      })
    } catch (cause) {
      if (!signal?.aborted) setError(cause instanceof Error ? cause.message : "Could not load the inbox")
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    // A step taken on a linked order, a clock move or a reset changes what the inbox shows.
    const reload = () => void load()
    window.addEventListener(CLOCK_EVENT, reload)
    return () => { controller.abort(); window.removeEventListener(CLOCK_EVENT, reload) }
  }, [load])

  const thread = useMemo(() => view?.threads.find((item) => item.id === selected) ?? null, [view, selected])

  const choose = (id: string) => {
    setSelected(id)
    setShowList(false)
    window.history.replaceState(null, "", `#${id}`)
  }

  return <Shell section="inbox" fixed snapshotAt={view?.snapshotAt ?? null}><main className={`mailbox${showList ? "" : " reading"}`}>
    <section className="mail-list" aria-label="Support inbox threads">
      <header className="mail-list-head">
        <h1 className="display">Support inbox</h1>
        {view && <p>{view.open} of {view.threads.length} open</p>}
      </header>
      {error && <p className="queue-error" role="alert">{error}.</p>}
      <ul className="mail-rows">{view?.threads.map((item) => {
        const last = item.messages.filter((message) => !message.internal).at(-1) ?? item.messages.at(-1)
        return <li key={item.id}>
          <button type="button" className="mail-row" onClick={() => choose(item.id)} aria-current={item.id === selected ? "true" : undefined}>
            <span className="mail-row-top">
              <span className="mail-row-who">{item.counterparty?.name ?? "Unknown sender"}</span>
              <span className="mail-row-when">{fmtDay(item.updatedAt)}</span>
            </span>
            <span className="mail-row-subject">{item.categoryLabel}<Pill tone={item.linkTone}>{item.linkStateLabel}</Pill></span>
            {last && <span className="mail-row-preview">{last.author.kind === "operator" || last.author.kind === "agent" ? `You: ${last.body}` : last.body}</span>}
          </button>
        </li>
      })}</ul>
    </section>
    <section className="mail-read" aria-label="Conversation">
      {!view && !error && <p className="empty">Loading…</p>}
      {view && !thread && <p className="empty">Choose a thread.</p>}
      {thread && <Thread key={thread.id} thread={thread} onBack={() => setShowList(true)} onChange={setView} />}
    </section>
  </main></Shell>
}

function Thread({ thread, onBack, onChange }: { thread: InboxThreadView; onBack: () => void; onChange: (view: InboxView) => void }) {
  const [suggestion, setSuggestion] = useState<InboxSuggestion | null>(null)
  const [thinking, setThinking] = useState(true)
  const [suggestError, setSuggestError] = useState("")
  const [draft, setDraft] = useState("")
  const [fromAgent, setFromAgent] = useState(false)
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState("")

  // The agent reads the thread again whenever what it reads changes: a link, a reply, the orders' state.
  const linkedKey = thread.linked.map((order) => order.id).join(",")
  const messageCount = thread.messages.length
  const [stamp, setStamp] = useState(0)
  // Steps on orders the thread no longer links (or not yet) must not linger while the agent reads again.
  useEffect(() => { setSuggestion(null) }, [linkedKey])
  useEffect(() => {
    const bump = () => setStamp((value) => value + 1)
    window.addEventListener(CLOCK_EVENT, bump)
    return () => window.removeEventListener(CLOCK_EVENT, bump)
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    setThinking(true)
    setSuggestError("")
    fetch(`/api/inbox/suggest?thread=${encodeURIComponent(thread.id)}`, { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json().catch(() => null) as { suggestion?: InboxSuggestion; error?: string } | null
        if (!response.ok || !data?.suggestion) throw new Error(data?.error ?? "The agent could not read this thread")
        setSuggestion(data.suggestion)
      })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setSuggestError(cause instanceof Error ? cause.message : "The agent could not read this thread") })
      .finally(() => { if (!controller.signal.aborted) setThinking(false) })
    return () => controller.abort()
  }, [thread.id, linkedKey, messageCount, stamp])

  const useDraft = () => { if (suggestion) { setDraft(suggestion.reply); setFromAgent(true); setSendError("") } }

  async function send(event: FormEvent) {
    event.preventDefault()
    setSending(true)
    setSendError("")
    try {
      onChange(await act({ action: "reply", threadId: thread.id, text: draft, suggested: fromAgent }))
      setDraft("")
      setFromAgent(false)
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : "The reply was not sent")
    } finally {
      setSending(false)
    }
  }

  const sender = thread.counterparty?.name ?? "the sender"
  return <article>
    <button type="button" className="mail-back btn btn-tertiary btn-s" onClick={onBack}><Icon name="chevron" size={13} style={{ transform: "rotate(180deg)" }} /> All threads</button>
    <header className="mail-head">
      <h2>{thread.categoryLabel}</h2>
      <div className="hero-pills">
        <Pill tone={thread.linkTone}>{thread.linkStateLabel}</Pill>
        <Pill tone={thread.tone}>{thread.statusLabel}</Pill>
      </div>
      <dl className="mail-facts">
        <div><dt>From</dt><dd>{thread.counterparty ? <><ActorName actor={thread.counterparty} />{thread.counterparty.role && <> <span className="muted">({capitalise(thread.counterparty.role)})</span></>}</> : "Unknown"}</dd></div>
        <div><dt>Channel</dt><dd>{thread.channelLabel}</dd></div>
        <div><dt>Owner</dt><dd>{thread.owner ?? "Not recorded"}</dd></div>
        {thread.waitingOn && <div><dt>Waiting on</dt><dd>{thread.waitingOn}</dd></div>}
        <div><dt>Opened</dt><dd><When at={thread.openedAt} withZone={false} /></dd></div>
        {thread.linked.length > 0 && <div><dt>Linked orders</dt><dd><LinkedOrders thread={thread} onChange={onChange} /></dd></div>}
        {thread.candidates.length > 0 && !thread.linked.length && <div><dt>Likely order</dt><dd><OrderLinks orders={thread.candidates} /> <span className="muted">(not linked yet)</span></dd></div>}
        {thread.resolution && <div><dt>Resolved</dt><dd>{thread.resolution.decisionLabel}{thread.resolution.at ? ` ${fmtDateTime(thread.resolution.at)}` : ""}</dd></div>}
      </dl>
      {thread.candidateBasis && <p className="mail-basis"><b>Why:</b> {thread.candidateBasis}</p>}
      <LinkOrder thread={thread} onChange={onChange} />
    </header>


    <div className="messages mail-messages">{thread.messages.map((message) => <div className={`msg${message.internal ? " internal" : message.author.kind === "operator" ? " from-operator" : ""}`} key={message.id}>
      <div className="msg-meta"><b><ActorName actor={message.author} /></b>{message.internal
        ? <span>· {message.channelLabel}</span>
        : <><span>to {message.recipient.name}</span><span>· {message.channelLabel}</span></>}
        {message.sentFromApp && <Pill tone="ok">{message.draftedByAgent ? "Sent, drafted by the agent" : "Sent from the inbox"}</Pill>}
        <time dateTime={message.at}>{fmtDateTime(message.at)}</time></div>
      <p className="msg-body">{message.body}</p>
    </div>)}</div>
    {thread.messages.length === 0 && <p className="empty">No messages filed under this thread.</p>}

    <section className="mail-agent" aria-label="The agent's suggestion" aria-busy={thinking}>
      <div className="mail-agent-head">
        <h3>Agent suggestion</h3>
      </div>
      {thinking && !suggestion && <p className="mail-agent-note">The agent is reading the thread{thread.linked.length ? " and its orders" : ""}…</p>}
      {suggestError && <p className="sit-error" role="alert">{suggestError}</p>}
      {suggestion && <>
        {suggestion.note && <p className="mail-agent-note">{suggestion.note}</p>}
        {suggestion.orders.length > 0 && <div className="mail-agent-orders">{suggestion.orders.map((order) => <SituationCard key={order.orderId} orderId={order.orderId} reference={order.reference}
          situation={{ headline: order.headline, body: order.why, step: order.steps[0] ?? null, others: order.steps.slice(1) }} />)}</div>}
        <div className="mail-agent-draft">
          <p className="mail-agent-label">Suggested reply to {sender}</p>
          <p className="msg-body">{suggestion.reply}</p>
          <div className="sit-actions">
            <button type="button" className="btn btn-s btn-primary" onClick={useDraft} disabled={thinking}>Use this reply</button>
          </div>
        </div>
      </>}
    </section>

    <form className="sit-form mail-reply" onSubmit={send}>
      <label className="mail-agent-label" htmlFor={`${thread.id}-reply`}>Reply to {sender} · {thread.channelLabel}</label>
      <textarea id={`${thread.id}-reply`} rows={draft ? 8 : 3} value={draft} placeholder="Write a reply"
        onChange={(event) => { setDraft(event.target.value); if (!event.target.value) setFromAgent(false) }} />
      <div className="sit-actions">
        <button type="submit" className="btn btn-s btn-primary" disabled={sending || !draft.trim()}>{sending ? "Sending…" : "Send reply"}</button>
        {draft && <button type="button" className="btn btn-s btn-quiet" disabled={sending} onClick={() => { setDraft(""); setFromAgent(false) }}>Clear</button>}
        {fromAgent && <span className="mail-agent-source">Starts from the agent's draft; edit before sending.</span>}
      </div>
      {sendError && <p className="sit-error" role="alert">{sendError}</p>}
    </form>
  </article>
}

/** The linked orders; the ones the operator linked here can be taken back. */
function LinkedOrders({ thread, onChange }: { thread: InboxThreadView; onChange: (view: InboxView) => void }) {
  const [busy, setBusy] = useState("")
  const [error, setError] = useState("")
  const unlink = async (orderId: string) => {
    setBusy(orderId)
    setError("")
    try { onChange(await act({ action: "unlink", threadId: thread.id, order: orderId })) } catch (cause) { setError(cause instanceof Error ? cause.message : "Nothing changed") } finally { setBusy("") }
  }
  return <span className="mail-linked">
    {thread.linked.map((order) => <span key={order.id} className="mail-linked-order">
      <OrderLink order={order} />
      {thread.operatorLinked.includes(order.id) && <button type="button" className="btn-link" disabled={busy === order.id} onClick={() => void unlink(order.id)}>{busy === order.id ? "Unlinking…" : "Unlink"}</button>}
    </span>)}
    {error && <span className="close-error" role="alert">{error}</span>}
  </span>
}

/** Links an order to the thread: a candidate in one click, or any order by its reference. */
function LinkOrder({ thread, onChange }: { thread: InboxThreadView; onChange: (view: InboxView) => void }) {
  const [open, setOpen] = useState(false)
  const [reference, setReference] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const linked = new Set(thread.linked.map((order) => order.id))
  const candidates = thread.candidates.filter((order) => !linked.has(order.id))

  const link = async (order: string) => {
    setBusy(true)
    setError("")
    try {
      onChange(await act({ action: "link", threadId: thread.id, order }))
      setReference("")
      setOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Nothing changed")
    } finally {
      setBusy(false)
    }
  }

  return <div className="mail-link">
    {candidates.map((order) => <button key={order.id} type="button" className="btn btn-s btn-quiet" disabled={busy} onClick={() => void link(order.id)}>Link {order.reference}</button>)}
    {open
      ? <form className="mail-link-form" onSubmit={(event) => { event.preventDefault(); void link(reference) }}>
        <label className="sr-only" htmlFor={`${thread.id}-link`}>Order reference</label>
        <input id={`${thread.id}-link`} className="field" autoFocus placeholder="CD-420000" value={reference} onChange={(event) => setReference(event.target.value)} />
        <button type="submit" className="btn btn-s btn-primary" disabled={busy || !reference.trim()}>{busy ? "Linking…" : "Link"}</button>
        <button type="button" className="btn-link" onClick={() => { setOpen(false); setError("") }}>Cancel</button>
      </form>
      : <button type="button" className="btn btn-s btn-quiet" onClick={() => setOpen(true)}>{thread.linked.length ? "Link another order" : "Link an order"}…</button>}
    {error && <p className="close-error" role="alert">{error}</p>}
  </div>
}

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)
