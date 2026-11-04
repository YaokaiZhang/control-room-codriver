// Pure time and number formatting. The dataset is a frozen snapshot, so every
// relative phrase is measured against the snapshot time, never the real clock.

const LOCALE = "en-GB"

/** The control room's zone. A time not tied to a site (the demo clock, calls, the record's activity) reads in it, so a page never mixes UTC with local times. */
export const DESK_ZONE = "Europe/Helsinki"

export function zoneCity(zone: string | null | undefined): string | null {
  if (!zone || zone === "UTC") return null
  const city = zone.split("/").pop()
  return city ? city.replace(/_/g, " ") : null
}

function parse(value: string | null | undefined): Date | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

// Building an Intl.DateTimeFormat is slow (milliseconds), and the reviewer formats
// every record of every order, so formatters are built once per zone and options.
const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(options)
  let made = formatters.get(key)
  if (!made) {
    made = new Intl.DateTimeFormat(LOCALE, options)
    formatters.set(key, made)
  }
  return made
}

function safeZone(zone: string | null | undefined): string {
  if (!zone) return DESK_ZONE
  try {
    formatter({ timeZone: zone })
    return zone
  } catch {
    return DESK_ZONE
  }
}

function parts(date: Date, zone: string, options: Intl.DateTimeFormatOptions): string {
  return formatter({ timeZone: zone, hourCycle: "h23", ...options }).format(date)
}

/** "21 Oct" */
export function fmtDay(value: string | null | undefined, zone?: string | null): string {
  const date = parse(value)
  if (!date) return ""
  return parts(date, safeZone(zone), { day: "numeric", month: "short" })
}

/** "Fri 23 Oct" */
export function fmtWeekday(value: string | null | undefined, zone?: string | null): string {
  const date = parse(value)
  if (!date) return ""
  return parts(date, safeZone(zone), { weekday: "short", day: "numeric", month: "short" })
}

/** "09:00" */
export function fmtClock(value: string | null | undefined, zone?: string | null): string {
  const date = parse(value)
  if (!date) return ""
  return parts(date, safeZone(zone), { hour: "2-digit", minute: "2-digit" })
}

/** "21 Oct 08:14" in the given zone (the control room's when none), with the zone's short name: "23 Oct 09:00 EEST". */
export function fmtDateTime(value: string | null | undefined, zone?: string | null, withZone = true): string {
  const date = parse(value)
  if (!date) return ""
  const tz = safeZone(zone)
  const text = parts(date, tz, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).replace(",", "")
  if (!withZone) return text
  const name = tz === "UTC" ? "UTC" : zoneName(date, tz)
  return `${text} ${name}`
}

/** "21 October 2026, 11:14 EEST" for tooltips, in the control room's zone. */
export function fmtLong(value: string | null | undefined): string {
  const date = parse(value)
  if (!date) return ""
  return `${parts(date, DESK_ZONE, { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" })} ${zoneName(date, DESK_ZONE)}`
}

/** "11:14 EEST": a clock time in the control room's zone, with the zone's short name. */
export function fmtDeskClock(value: string | null | undefined): string {
  const date = parse(value)
  if (!date) return ""
  return `${parts(date, DESK_ZONE, { hour: "2-digit", minute: "2-digit" })} ${zoneName(date, DESK_ZONE)}`
}

/** "EEST": the control room zone's short name at that moment. */
export function deskZoneName(value?: string | null): string {
  return zoneName(parse(value) ?? new Date(), DESK_ZONE)
}

export function zoneName(date: Date, zone: string): string {
  const formatted = formatter({ timeZone: zone, timeZoneName: "short" }).formatToParts(date)
  return formatted.find((part) => part.type === "timeZoneName")?.value ?? zone
}

/** "23 Oct 09:00–11:00 EEST" or "23 Oct 09:00 – 24 Oct 11:00 EEST". */
export function fmtRange(start: string | null | undefined, end: string | null | undefined, zone?: string | null): string {
  const from = parse(start)
  const to = parse(end)
  if (!from) return ""
  const tz = safeZone(zone)
  const name = tz === "UTC" ? "UTC" : zoneName(from, tz)
  const fromDay = parts(from, tz, { day: "numeric", month: "short" })
  const fromClock = parts(from, tz, { hour: "2-digit", minute: "2-digit" })
  if (!to) return `${fromDay} ${fromClock} ${name}`
  const toDay = parts(to, tz, { day: "numeric", month: "short" })
  const toClock = parts(to, tz, { hour: "2-digit", minute: "2-digit" })
  if (fromDay === toDay) return `${fromDay} ${fromClock}–${toClock} ${name}`
  return `${fromDay} ${fromClock} – ${toDay} ${toClock} ${name}`
}

export type Relative = { text: string; past: boolean; minutes: number }

/** Distance between a time and the snapshot: "in 2 d", "4 h ago", "now". */
export function relativeTo(value: string | null | undefined, snapshot: string | null | undefined): Relative | null {
  const date = parse(value)
  const base = parse(snapshot)
  if (!date || !base) return null
  const minutes = Math.round((date.getTime() - base.getTime()) / 60000)
  const abs = Math.abs(minutes)
  const past = minutes < 0
  let amount: string
  if (abs < 1) return { text: "now", past: false, minutes }
  if (abs < 60) amount = `${abs} min`
  else if (abs < 36 * 60) amount = `${Math.round(abs / 60)} h`
  else amount = `${Math.round(abs / (24 * 60))} d`
  return { text: past ? `${amount} ago` : `in ${amount}`, past, minutes }
}

export function minutesBetween(from: string | null | undefined, to: string | null | undefined): number | null {
  const a = parse(from)
  const b = parse(to)
  if (!a || !b) return null
  return Math.round((b.getTime() - a.getTime()) / 60000)
}

export function isBefore(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = parse(a)
  const y = parse(b)
  return !!x && !!y && x.getTime() < y.getTime()
}

/** "2026-10-21" in the given zone, for grouping. */
export function dayKey(value: string | null | undefined, zone?: string | null): string {
  const date = parse(value)
  if (!date) return ""
  const tz = safeZone(zone)
  const year = parts(date, tz, { year: "numeric" })
  const month = parts(date, tz, { month: "2-digit" })
  const day = parts(date, tz, { day: "2-digit" })
  return `${year}-${month}-${day}`
}

/** "Wednesday 21 October" */
export function fmtDayHeading(value: string | null | undefined, zone?: string | null): string {
  const date = parse(value)
  if (!date) return ""
  return parts(date, safeZone(zone), { weekday: "long", day: "numeric", month: "long" })
}

export function fmtMoney(cents: number | null | undefined, currency: string | null | undefined): string {
  if (typeof cents !== "number" || !currency) return ""
  try {
    return new Intl.NumberFormat(LOCALE, { style: "currency", currency }).format(cents / 100)
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`
  }
}

export function fmtDuration(minutes: number | null | undefined): string {
  if (typeof minutes !== "number" || Number.isNaN(minutes)) return ""
  const abs = Math.abs(Math.round(minutes))
  if (abs < 60) return `${abs} min`
  const hours = Math.floor(abs / 60)
  const rest = abs % 60
  if (hours < 48) return rest ? `${hours} h ${rest} min` : `${hours} h`
  return `${Math.round(abs / (24 * 60))} d`
}

export function compareIso(a: string | null | undefined, b: string | null | undefined): number {
  return String(a ?? "").localeCompare(String(b ?? ""))
}
