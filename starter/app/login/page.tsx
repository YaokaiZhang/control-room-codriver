import type { Metadata } from "next"
import { Icon } from "@/app/components/icons"
import { Windscreen, type WindscreenChoice } from "@/app/components/windscreen"
import { PERSONA_LABEL, type Persona } from "@/lib/persona"
import { currentPersona } from "@/lib/persona-server"
import { choosePersona } from "./actions"

export const metadata: Metadata = { title: "Choose a persona · Co-Driver" }

const ABOUT: Record<Persona, string> = {
  operator: "Works the orders and makes the decisions.",
  site: "Answers calls to a pickup or delivery place.",
  driver: "Answers driver calls and sees open jobs.",
}

/** Left to right on the arc: the Operator sits in the middle, straight ahead. */
const SEATS: Persona[] = ["site", "operator", "driver"]

/**
 * The persona picker. No password: the demo site sits behind basic auth, and this only decides which screens you see.
 * Site and Driver go to their phone page; the Operator goes to the start page (or the page they were sent away from).
 */
export default async function PickerPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const [{ next }, current] = await Promise.all([searchParams, currentPersona()])
  const choices: WindscreenChoice[] = SEATS.map((persona) => ({
    key: persona, label: PERSONA_LABEL[persona], name: "persona", value: persona, title: ABOUT[persona],
    current: persona === current, badge: persona === current ? <Icon name="check" size={14} /> : undefined,
  }))
  return <Windscreen
    eyebrow="Bahn Co-Driver"
    title={<>Hi, <em>Bahner</em>, who is driving today?</>}
    label="Choose a persona"
    choices={choices}
    angles={[-40, 0, 40]}
    goingTo="Taking the wheel as"
    action={choosePersona}
    hidden={next ? { next } : undefined}
  />
}
