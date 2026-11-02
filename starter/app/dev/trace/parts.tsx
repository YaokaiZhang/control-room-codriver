// Shared bits of the /dev/trace pages: the plain style of /dev/learning, times, links and JSON blocks.

import { notFound } from "next/navigation"
import type { TraceLink } from "@/lib/engine/trace-view"

export const CSS = `
.dev{font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;color:#1a1a1a;background:#fff;padding:16px;max-width:1400px;margin:0 auto}
.dev h1{font-size:18px;margin:0 0 4px}.dev h2{font-size:15px;margin:28px 0 8px;border-bottom:1px solid #ccc;padding-bottom:4px}
.dev nav a{margin-right:12px}.dev .muted{color:#666}.dev table{border-collapse:collapse;width:100%}
.dev th,.dev td{border:1px solid #ddd;padding:4px 6px;vertical-align:top;text-align:left}.dev th{background:#f4f4f4}
.dev .wrap{overflow-x:auto;max-width:100%}.dev p,.dev td{overflow-wrap:anywhere}.dev pre{white-space:pre-wrap;word-break:break-word;margin:4px 0;background:#f8f8f8;padding:6px}
.dev .ok{color:#0a6b2d}.dev .bad{color:#a4161a}.dev .warn{color:#8a5a00}.dev details summary{cursor:pointer}
.dev .tag{display:inline-block;background:#eef;border-radius:3px;padding:0 4px;margin:0 2px 2px 0}
.dev tr:target{background:#fffbe0}
`

/** Off in production unless DEV_PAGES=1, like /dev/learning. */
export function guardDevPage(): void {
  if (process.env.NODE_ENV === "production" && process.env.DEV_PAGES !== "1") notFound()
}

export const time = (iso: string | null) => iso ? iso.replace("T", " ").replace(/:\d\d(\.\d+)?Z$/, "Z") : "-"
export const usd = (value: number | null) => value === null ? "-" : `$${value.toFixed(4)}`
export const tone = (value: string) => ["ok", "approved", "answered", "usable", "ended"].includes(value) ? "ok"
  : ["failed", "dismissed", "unusable", "rejected"].includes(value) || value.startsWith("failed") ? "bad" : "warn"

export function Json({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined) return null
  return <details><summary>{label}</summary><pre>{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</pre></details>
}

export function Links({ links }: { links: TraceLink[] }) {
  return <>{links.map((link, index) => <div key={index}>
    {link.label}: {link.href ? <a href={link.href}>{link.href.startsWith("#") ? link.href.slice(1) : link.href}</a> : <span className="warn">{link.note ?? "-"}</span>}
  </div>)}</>
}
