// The Rules page (ticket 07). The approval policy (who is contacted, the
// kind of action, and whether the agent acts alone, needs a yes or may only propose)
// and every rule check with its first action. Both are read from their one source:
// POLICY in lib/reviewer/policy.ts and RULE_CATALOGUE in lib/engine/rules.ts.
// Proposals link here as /rules#<policy row id>. The one part that takes decisions is
// Lessons (app/components/lessons.tsx): the operator approves what the agents learned.

import type { Metadata } from "next"
import Link from "next/link"
import { RULE_CATALOGUE, type RuleInfo } from "@/lib/engine/rules"
import { CONTACT_TYPE_LABEL, CONTACT_TYPES, POLICY, policyFor, type ActionType, type Decision } from "@/lib/reviewer/policy"
import type { Tone } from "@/lib/present/types"
import { Lessons } from "../components/lessons"
import { Shell } from "../components/shell"
import { Pill } from "../components/ui"

export const metadata: Metadata = { title: "Rules · Control Room" }

const DECISION_TONE: Record<Decision, Tone> = { "acts alone": "accent", "needs a yes": "warn", "propose only": "danger" }
const ACTIONS: { type: ActionType; label: string }[] = [{ type: "question", label: "Ask a question or call" }, { type: "change", label: "Change the order" }]

function RuleRow({ rule }: { rule: RuleInfo }) {
  return <li className="rule-row rule-row-2" id={`rule-${rule.id}`}>
    <dl><dt>Rule</dt><dd className="rule-name"><span className="rule-id"><Pill>{rule.id}</Pill></span>{rule.title}</dd></dl>
    <dl><dt>First action</dt><dd>{rule.firstAction}</dd></dl>
  </li>
}

/** The column names, once above a list; each row's own labels show only on a phone. */
function Cols({ names }: { names: string[] }) {
  return <div className={`rule-cols${names.length === 2 ? " rule-row-2" : ""}`} aria-hidden="true">{names.map((name) => <span key={name}>{name}</span>)}</div>
}

export default function RulesPage() {
  const rules = Object.values(RULE_CATALOGUE)
  const strong = rules.filter((rule) => rule.strength === "strong")
  const weak = rules.filter((rule) => rule.strength === "weak")
  return <Shell section="rules"><main className="page rules-page">
    <header className="entity-head">
      <h1 className="display">Rules</h1>
      <p className="rules-intro">The contact&apos;s type decides what the agent may do alone, what needs your yes, and what it only proposes.</p>
    </header>

    <section className="rules-section" aria-labelledby="policy-head">
      <h2 id="policy-head">Approval policy</h2>
      <p>The agent never contacts the customer side, except for a pickup-readiness call to the pickup place or contact. It never calls the paying customer.</p>
      <Cols names={["Who is contacted", "Kind of action", "The agent"]} />
      <ol className="rules-list">{POLICY.map((row) => <li className="rule-row" id={row.id} key={row.id}>
        <dl>
          <dt>Who is contacted</dt>
          <dd className="rule-name">{row.shown ?? row.contact}</dd>
          {/* The types only add something when a row covers several of them. */}
          {row.contactTypes.length > 1 && row.contactTypes.length < CONTACT_TYPES.length &&
            <dd className="rule-types">{row.contactTypes.map((type) => <Pill key={type}>{CONTACT_TYPE_LABEL[type]}</Pill>)}</dd>}
        </dl>
        <dl><dt>Kind of action</dt><dd>{row.action}</dd></dl>
        <dl><dt>The agent</dt><dd><Pill tone={DECISION_TONE[row.decision]}>{row.decision}</Pill></dd><dd>{row.agentDoes}</dd></dl>
      </li>)}</ol>
    </section>

    <section className="rules-section" aria-labelledby="matrix-head">
      <h2 id="matrix-head">By contact type</h2>
      <Cols names={["Contact type", ...ACTIONS.map((action) => action.label)]} />
      <ol className="rules-list">{CONTACT_TYPES.map((type) => <li className="rule-row" key={type}>
        <dl><dt>Contact type</dt><dd className="rule-name">{CONTACT_TYPE_LABEL[type]}</dd></dl>
        {ACTIONS.map((action) => {
          const row = policyFor(type, action.type)
          return <dl key={action.type}><dt>{action.label}</dt><dd>
            <Link className="policy-link" href={`#${row.id}`}><Pill tone={DECISION_TONE[row.decision]}>{row.decision}</Pill></Link>
          </dd></dl>
        })}
      </li>)}</ol>
    </section>

    <section className="rules-section" aria-labelledby="checks-head">
      <h2 id="checks-head">Rule checks</h2>
      <p>Run on every order at the demo clock. A strong rule that fails takes its first action.</p>
      <Cols names={["Strong rule", "First action"]} />
      <ol className="rules-list">{strong.map((rule) => <RuleRow key={rule.id} rule={rule} />)}</ol>
      <h3 className="rules-sub">Weak signals</h3>
      <p>These never block an order. When one can&apos;t be confirmed, the agent calls the site if pickup is within 48 h and a contact is known.</p>
      <Cols names={["Weak signal", "First action"]} />
      <ol className="rules-list">{weak.map((rule) => <RuleRow key={rule.id} rule={rule} />)}</ol>
    </section>

    <Lessons />
  </main></Shell>
}
