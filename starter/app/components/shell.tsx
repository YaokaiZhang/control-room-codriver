"use client"

import Link from "next/link"
import type { ReactNode } from "react"
import { homeFor, PICKER_PATH } from "@/lib/persona"
import { AgentAvatar } from "./agent-avatar"
import { BriefingToasts, useBriefingFeed } from "./briefing"
import { DemoClock } from "./demo-clock"
import { BahnLogo } from "./logo"
import { PersonaSwitch, usePersona } from "./persona"

export type Section = "orders" | "briefing" | "inbox" | "customers" | "drivers" | "sites" | "lessons"

export const NAV_LINKS: { section: Section; href: string; label: string }[] = [
  { section: "orders", href: "/", label: "Orders" },
  { section: "briefing", href: "/briefing", label: "Briefing" },
  { section: "inbox", href: "/inbox", label: "Inbox" },
  { section: "customers", href: "/customers", label: "Customers" },
  { section: "drivers", href: "/drivers", label: "Drivers" },
  { section: "sites", href: "/sites", label: "Places" },
  { section: "lessons", href: "/lessons", label: "Lessons" },
]

/**
 * Bahn's page header: wordmark, pill navigation in a sand track, the demo clock (with the Operator's
 * demo-only controls) and the persona switch.
 * The operator's navigation shows only to the Operator persona; Site and Driver get the bar without it.
 */
export function Shell({ children, section, snapshotAt, fixed = false }: { children: ReactNode; section?: Section; snapshotAt?: string | null; fixed?: boolean }) {
  const persona = usePersona()
  const briefing = useBriefingFeed(persona === "operator")
  return <div className={`shell${fixed ? " shell-fixed" : ""}`}>
    <header className="bar">
      <Link href={persona ? homeFor(persona) : PICKER_PATH} className="brand" aria-label="Co-Driver home">
        <BahnLogo />
        <span className="brand-room">Co-Driver</span>
      </Link>
      {persona === "operator" && <nav className="nav" aria-label="Main navigation">
        {NAV_LINKS.map((link) => <Link key={link.section} href={link.href} aria-current={section === link.section ? "page" : undefined}>
          {link.label}
          {link.section === "briefing" && briefing.unread > 0 && <span className="nav-badge">{briefing.unread}<span className="sr-only"> unread</span></span>}
        </Link>)}
      </nav>}
      <DemoClock operator={persona === "operator"} snapshotAt={snapshotAt} />
      <span className="bar-fiction">Fictional data</span>
      <PersonaSwitch />
    </header>
    <div className="shell-main">{children}</div>
    {persona === "operator" && <BriefingToasts feed={briefing} />}
    {persona === "operator" && <AgentAvatar />}
  </div>
}
