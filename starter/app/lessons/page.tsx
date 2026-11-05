// The Lessons page (spec .scratch/self-improving-agents): what the agents learned from the
// operator's corrections, and the one place the operator approves, rejects or retires a
// lesson. The fixed rules (approval policy, rule checks) live in code and are not listed.

import type { Metadata } from "next"
import { Lessons } from "../components/lessons"
import { Shell } from "../components/shell"

export const metadata: Metadata = { title: "Lessons · Control Room" }

export default function LessonsPage() {
  return <Shell section="lessons"><main className="page lessons-page">
    <header className="entity-head">
      <h1 className="display">Lessons</h1>
      <p className="lessons-intro">When you correct the same kind of mistake a few times, the agents propose a lesson. It is tested against past orders first, and only lessons you approve go into their instructions.</p>
    </header>
    <Lessons />
  </main></Shell>
}
