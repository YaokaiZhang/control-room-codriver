"use client"

// The driver market on the Driver's phone (spec .scratch/publishing): every job live for
// drivers, soonest pickup first. A demanding job carries the travel planner's suggestion,
// folded away and marked as a suggestion only.

import { useEffect, useState } from "react"
import type { DriverJob, DriverJobs } from "@/lib/present/types"
import { fmtDateTime } from "@/lib/present/time"
import { useClockVersion } from "./demo-clock"
import { TravelPlanView } from "./travel-plan"
import { More } from "./ui"

/** How often the job list re-reads the market (ms). */
const POLL_MS = 5000

function useJobs(): { jobs: DriverJob[] | null; error: string } {
  const [jobs, setJobs] = useState<DriverJob[] | null>(null)
  const [error, setError] = useState("")
  const clockVersion = useClockVersion()
  useEffect(() => {
    let stopped = false
    const read = () => fetch("/api/phone/jobs")
      .then((response) => { if (!response.ok) throw new Error("Could not load the jobs"); return response.json() as Promise<DriverJobs> })
      .then((data) => { if (!stopped) { setJobs(data.jobs); setError("") } })
      .catch((cause: unknown) => { if (!stopped) setError(cause instanceof Error ? cause.message : "Could not load the jobs") })
    read()
    const timer = setInterval(read, POLL_MS)
    return () => { stopped = true; clearInterval(timer) }
  }, [clockVersion])
  return { jobs, error }
}

const slotText = (slot: DriverJob["pickupWindow"]) => slot ? `${fmtDateTime(slot.start, slot.zone, false)}–${fmtDateTime(slot.end, slot.zone).split(" ").slice(2).join(" ")}` : "time to agree"

/** The crossing in a few words: "ferry East Sweden → South Finland" when the plan names the terminals, else "ferry crossing" or "train leg". */
function crossingText(job: DriverJob, crossing: string): string {
  if (crossing.startsWith("rail")) return "train leg"
  const placeholder = (name: string) => /^((departure|arrival) )?terminal$/i.test(name.trim())
  const ferry = job.plan?.legs.find((leg) => leg.kind === "ferry" && !placeholder(leg.from) && !placeholder(leg.to))
  const port = (name: string) => name.replace(/\s+terminal$/i, "")
  if (ferry) return `ferry ${port(ferry.from)} → ${port(ferry.to)}`
  return crossing.startsWith("ferry quotes") ? "likely a ferry" : "ferry crossing"
}

/** What makes a job demanding, in a few words: "ferry East Sweden → South Finland · ~15 h driving". */
function demands(job: DriverJob): string | null {
  if (!job.check.demanding) return null
  const parts = [
    ...job.check.crossings.map((crossing) => crossingText(job, crossing)),
    job.check.driveHours !== null && job.check.driveHours > 12 ? `~${job.check.driveHours} h driving` : null,
  ].filter(Boolean)
  return parts.length ? `Demanding: ${parts.join(" · ")}` : "Demanding"
}

function JobCard({ job }: { job: DriverJob }) {
  const hard = demands(job)
  return <li className="job">
    <div className="job-head">
      <b>{job.from.city} → {job.to.city}</b>
      {job.fee && <span className="job-fee">{job.fee}</span>}
    </div>
    <div className="job-when">{slotText(job.pickupWindow)} → {job.deliveryWindow ? fmtDateTime(job.deliveryWindow.end, job.deliveryWindow.zone) : "time to agree"}</div>
    <div className="job-meta">{job.car ? `${job.car} · ` : ""}{job.check.km ? `${job.check.km} km · ` : ""}{job.reference}</div>
    {hard && <div className="job-hard">{hard}</div>}
    {job.plan && <More label="Suggested travel plan"><TravelPlanView plan={job.plan} /></More>}
  </li>
}

export function DriverJobsList() {
  const { jobs, error } = useJobs()
  return <section className="phone-jobs" aria-label="Open jobs">
    <h2>Open jobs <em>{jobs ? jobs.length : ""}</em></h2>
    {error && <p className="phone-error" role="alert">{error}</p>}
    {!jobs && !error && <p className="phone-queue-why">Loading jobs…</p>}
    {jobs && jobs.length === 0 && <p className="phone-queue-why">No open jobs right now.</p>}
    {jobs && jobs.length > 0 && <ul>{jobs.map((job) => <JobCard key={job.orderId} job={job} />)}</ul>}
  </section>
}
