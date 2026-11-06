import type { Metadata } from "next"
import { PhoneApp } from "@/app/components/phone"
import { Shell } from "@/app/components/shell"
import { currentPersona } from "@/lib/persona-server"

export const metadata: Metadata = { title: "Phone · Co-Driver" }

/**
 * The mock phone (ticket 11) for the Site and Driver personas: it rings for demo
 * calls and calls the operator rings live. The Operator can open either phone.
 */
export default async function PhonePage() {
  const persona = await currentPersona()
  return <Shell><main className="phone-page">
    <h1 className="display">Phone</h1>
    <PhoneApp persona={persona === "driver" ? "driver" : persona === "site" ? "site" : "operator"} />
  </main></Shell>
}
