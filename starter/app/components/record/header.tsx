"use client"

import Image from "next/image"
import Link from "next/link"
import type { ReactNode } from "react"
import type { RecordView, Tile } from "@/lib/present/types"
import { HighlightButton } from "../highlights"
import { Pill, StagePill } from "../ui"

/**
 * Bahn's image band with an asphalt panel over its foot: the car, its stage and who it is for.
 * `lead`: what the order needs now (the situation card); without it, the record's story.
 */
export function RecordHero({ view, lead }: { view: RecordView; lead?: ReactNode }) {
  const { header, story, journey } = view
  const vehicle = header.vehicle
  const photo = vehicle?.illustrationSlug
  return <>
    <section className={`hero${photo ? "" : " no-photo"}`}>
      {photo && <figure className="hero-photo" title="Model illustration, not a photo of this car">
        <Image src={`/car-images/${photo}.webp`} alt={`Illustration of a ${vehicle?.title}`} fill sizes="(max-width: 1180px) 100vw, 1120px" priority />
      </figure>}
      <div className="hero-card">
        <div className="hero-pills">
          <StagePill lane={header.lane} label={header.laneLabel} />
          <Pill>{header.reference}</Pill>
          <HighlightButton orderId={header.id} />
        </div>
        <h1 className="display hero-title">{vehicle ? vehicle.title : "Vehicle not linked"}</h1>
        <p className="hero-facts">
          <span>For <Link href={`/customers/${header.customer.id}`}>{header.customer.name}</Link></span>
          {vehicle?.plate && <span>Plate <b>{vehicle.plate}</b></span>}
          {vehicle?.vin && <span>VIN <b>{vehicle.vin}</b></span>}
          <span>{header.routeKindLabel}{journey.distanceKm ? ` · ${journey.distanceKm} km` : ""}</span>
          {header.tradeIn && <span>Trade-in <b>{header.tradeIn.title}</b></span>}
          {header.customerReference && <span>Customer ref <b>{header.customerReference}</b></span>}
        </p>
      </div>
    </section>
    {lead ? <div className="story">{lead}</div> : <div className="story">
      <p className={`story-headline tone-${story.tone}`}>{story.headline}</p>
      {story.detail && <p className="story-detail">{story.detail}</p>}
    </div>}
  </>
}

export function KeyDates({ tiles }: { tiles: Tile[] }) {
  return <div className="dates">{tiles.map((tile) => {
    const body = <>
      <div className="date-label">{tile.label}</div>
      <div className="date-value">{tile.value}</div>
      {tile.hint && <div className="date-hint">{tile.hint}</div>}
    </>
    return tile.href
      ? <Link className={`date tone-${tile.tone}`} href={tile.href} key={tile.label}>{body}</Link>
      : <div className={`date tone-${tile.tone}`} key={tile.label}>{body}</div>
  })}</div>
}
