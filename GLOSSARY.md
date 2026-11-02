# Car Delivery Control Room

The place where Bahn operators and agents work together to get every car delivered. Agents check orders, ask the cheap questions, and bring an operator only the decisions that need a person.

## People and parties

**Operator**:
A Bahn operations staff member who reviews agent work and makes decisions in the control room.
_Avoid_: Admin, operator manager, user

**Customer**:
The party that pays Bahn for an order (`orders.customer_id`), usually a dealer.
_Avoid_: Buyer, client, account, persona

**Customer side**:
The customer, any contact the customer gave us on the order, and any site the customer owns. The agent never contacts the customer side; it only proposes contact to an operator. One exception (ADR 0001 amendment): a pickup-readiness call to the order's pickup place or pickup contact, even when that is a customer-owned site or a contact the customer gave us. The paying customer is never called.

**Driver**:
The freelance driver assigned to move the car.

**Seller**:
The party responsible for releasing the car at pickup: its readiness, papers and keys.
_Avoid_: Pickup place, site (a site is a place, not a party)

**Persona**:
A demo login role (Operator, Site, Driver) that decides which screen a person sees. A persona is not a party to the order.
_Avoid_: Customer, user type

## Places

**Endpoint**:
An order's pickup or delivery point, with its address, access instructions and contact. It may be a private address with no site.
_Avoid_: Pickup place, location, stop

**Site**:
A managed place profile (dealership, source dealer, storage or transfer yard) with standard hours, rules and a contact email that an endpoint may point to.
_Avoid_: Place, branch, location

## Checking

**Rule check**:
A deterministic test over an order's records that passes, fails, or can't be evaluated.
_Avoid_: Flag, alert, validation

**Strong rule**:
A rule check whose failure puts the order in front of an agent or operator on its own.

**Couldn't-check item**:
A known gap in an order's records (for example, no pickup contact on record) that is listed openly but does not by itself make the order need action.
_Avoid_: Warning, weak flag

**Reviewer**:
The LLM agent that reads one order's records and looks for information that conflicts or is wrong.
_Avoid_: Document reviewer agent, checker

**Finding**:
One conflict the reviewer found, citing the records that disagree and the record that names who to ask.
_Avoid_: Issue, flag, conflict report

**Alert**:
A signal recorded in the dataset that is a reason to look, not a diagnosis. Not produced by the control room.
_Avoid_: Flag, finding

**Checked normal**:
An order whose rule checks passed and whose records the reviewer read without finding a conflict.
_Avoid_: Quiet, no alert, OK

## Order groups

**Blocked**:
The group of orders the agent cannot move forward alone: they wait on an operator's decision or contact.
_Avoid_: Problem, needs action (the board's name)

**In progress**:
The group of orders where an agent action is running or waiting on a reply.

**Normal**:
The group of orders that are checked normal and not finished.

**Solved**:
The group of orders where the agent's calls settled the open points and the operator has not confirmed them yet: the call results on an order not published yet, or a change a person confirmed on the agent's call on any order. Shown as "Fixed, review it". An order on the market or on the road keeps its stage.
_Avoid_: Done, resolved

**Finished**:
The group of orders that are finished completely: delivered or cancelled, with nothing open.
_Avoid_: Done

## Publishing

**Fixed, review it**:
The tag of a Solved order, and the Overview stage of one not published yet: the agent fixed it, and the operator checks it. The operator reads each rewrite or change and the call transcripts; their approval confirms the changes, and publishes an order not published yet.

**Needs action**:
The board of the orders that are not normal: Blocked, Fixed, review it and In progress, each most pressing first: urgent orders, then the soonest deadline, then orders with no deadline left.
_Avoid_: Not normal

**Overview**:
The board of every order by stage: Unpublished, Fixed, review it, Finding a driver, Driver assigned (booked or moving), Done (delivered or cancelled). Its state (Blocked, Fixed, review it, In progress, Normal) is a small tag on the card.
_Avoid_: Pipeline

**Rewrite**:
One call result shown as before (what the records said) and now (what the person said on the call), with the call's transcript.

**Published**:
On the driver market (Finding a driver), by the agent for a reviewed Normal order, or by the operator.
_Avoid_: Posted, listed

**Demanding job**:
A job on the market that is cross-country, needs more than 12 hours of driving, or needs a ferry or train between the endpoints. The demand filter decides it before drivers see the job.

**Travel plan**:
The travel planner's rough suggestion for a demanding job: getting to pickup, a hotel when needed, ferry or train tickets, the way home, against the order's travel budget. Nothing is booked.
_Avoid_: Booking, itinerary
_Avoid_: Delivered (a delivered order can still have gaps)

## Agent work and decisions

**Proposal**:
Something an agent wants to do or change, with its evidence, who pays, and the policy row that applies, waiting for an operator's decision.
_Avoid_: Suggestion, recommendation, action item, task, to-do
A proposal moves through proposed, approved, answered and dismissed. It stays one proposal throughout. **Answered** means the question it asked got its answer: the operator recorded the customer side's answer (customer-side contact), the operator answered their own question (operator question), or the agent's call carrying it ended with a result (call). A change proposal is never answered: its yes commits it.

**Approve**:
An operator's yes on a proposal. On a change proposal it writes an effect event; on a customer-side proposal it hands the contact to the operator.
_Avoid_: Accept, confirm, sign off

**Policy row**:
One line of the approval policy that says, for a contact type and action type, whether the agent acts alone, needs a yes, or may only propose.

**Instruction**:
An operator's direction to the agent, saved on a proposal, explaining how to act differently.
_Avoid_: Comment, note, feedback

**Mistake**:
A stored record that an agent got something wrong: an operator dismissed one of its proposals with a reason or edited its script, or a validator rejected its output. The operator's reason is kept as typed and restated as a neutral correction, checked by code; only usable mistakes may feed a lesson. Mistakes survive a demo reset.
_Avoid_: Error, failure, feedback

**Mistake group**:
The usable mistakes of one agent that share a failing rule and a contact type. A lesson is written from a group once it has enough mistakes on enough orders and days.

**Lesson**:
One or two plain sentences an agent reads in its prompt, written by the distiller from a mistake group and starting with the group's contact type ("Only for questions to the paying customer:"), kept only if the reviewer eval does not get worse with it (the gate), and used only after the operator approves it. Lessons survive a demo reset.
_Avoid_: Rule (a rule check is code), memory, training

**Learned case**:
An eval case made from a lesson's source mistake: the order's case file as the agent read it, and the correction (the restatement, the edit or the validator's reason). The reviewer reviews the case file again, and the judge says whether the new review repeats the mistake. Learned cases are added beside the spec's cases and never replace one.

**Judge**:
A small model call in the lessons gate that reads a correction and a new review and answers `repeats`, `fixed` or `unclear`. It does not know whether a lesson was in the prompt. Its verdicts are for the gate and engineers, never shown to the operator.
_Avoid_: Grader, critic

**Agent run**:
One piece of work by one agent (a review of an order, a distil, a judge's verdict, a digest's prose), kept for engineers with the exact prompt it sent, the lessons in it, every model turn and what it cost. A model call made outside a run gets a one-turn run of its own. Judge runs and the gate's reviews sit under the distil run that asked for them.
_Avoid_: Trace (the whole chain), session, job (that is the run's kind)

**Effect event**:
The append-only record of something committed on an order, layered over the snapshot. A change to the order (a contact confirmed or changed, a window moved, a cost approved) is written only after an operator's yes; the operator's own answers are committed when given. A call result and a reported ETA are written by the agent at once, without a yes, because they are attributed statements (what the person said on the call), not changes to the order. Proposal text is never a fact; an effect event is.
_Avoid_: Update, change, mutation, operational event (that is the dataset's history)

**Close a record**:
The operator marks an open record done from the app: accepts a submitted proof (or waives a required one), marks a work item or custody follow-up done, resolves an alert, incident or claim, marks a document received, closes a thread or a stale proposal. Each close is an effect event committed by the operator; the record itself is never edited. Closing a finished order's last open record takes it out of Blocked.
_Avoid_: Delete, dismiss (a dismissed proposal is the agent's, not a record)

**Snapshot**:
The fixed dataset as of 2026-10-21T09:00Z. Effect events are layered on top of it, and it is never edited.

**Demo clock**:
The control room's notion of "now", starting at the snapshot time and moved forward only on purpose.

## Calls

**Call**:
A mock phone contact by the agent with a site or driver, run in tiers from cheapest to most expensive.
_Avoid_: Contact (broader), phone task

**Tier**:
One level of a call: 1 is fixed keypad questions, 2 is the LLM voice agent, 3 is handover to an operator.

**Opener**:
The voice agent's first words at tier 2: what it already knows (the order, the keypad answers, why the call escalated), then one specific question.
_Avoid_: Greeting (tier 1 greets)

**Simulated callee**:
Who answers a background call: keypad moves from a script at tier 1, and a model playing the person in text at tier 2, answering from the order's records.
_Avoid_: Bot, fake caller

**Handover**:
The end of a call that the voice agent couldn't resolve, giving an operator the transcript, a summary, the open question, and a proposed next step.
_Avoid_: Escalation, transfer

**Callback**:
A later call the agent scheduled because nobody answered or the person was busy.

**Next check**:
A follow-up time already recorded in the snapshot from earlier work, such as a site call due at 10:00. It is not a callback; the agent did not schedule it.
_Avoid_: Callback, reminder

**Reported ETA**:
A new arrival time the driver states on a call, recorded at once as a time attributed to the driver. It replaces the tracking estimate as the current ETA. It is the driver's statement, not a change to the order: the delivery promise stays the customer's.
_Avoid_: New window, rescheduled delivery, updated promise

## Summaries

**Digest**:
A scheduled summary in the Briefing inbox, with counts taken from rule checks and prose written by an LLM.
_Avoid_: Report, email, summary email

**Urgent push**:
An immediate template-only notice that an order became urgent or a handover arrived.
_Avoid_: Alert, notification

## Support inbox

**Thread**:
A conversation in the support inbox with a customer, driver or site, filed before its order link is certain. Its candidate orders are hypotheses; only linked orders are confirmed.
_Avoid_: Ticket, case, conversation (that is an order's own message thread)

**Link an order**:
The operator confirms which order a thread is about: a candidate in one click, or any order by its reference. The link is an inbox event laid over the thread; the operator can take back a link they made, but not a seeded one.
_Avoid_: Match (that is the hypothesis), assign

**Suggested reply**:
The inbox agent's draft answer to a thread's sender, in the sender's language. It uses only facts in the thread and its linked orders, and reveals nothing about an order the thread is not linked to. The operator edits and sends it; the agent never sends.
_Avoid_: Auto-reply, response

**Suggested steps**:
On a linked thread, the steps of the order's situation card that answer the thread, the agent's picks first with its reason. They are the same actions the order offers anywhere else.
_Avoid_: Recommendations, tasks
