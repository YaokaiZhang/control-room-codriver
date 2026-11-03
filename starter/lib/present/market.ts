// The record reads the dataset's lane and offers; publishing can have put a new or ready
// order on the driver market since. Pure, so the order page and the queue preview run it in the browser.

import type { Publication } from "@/lib/engine/publishing"
import type { RecordView } from "./types"

/** Headlines the record writes for an order that is not on the market yet. */
const UNPOSTED = new Set(["Ready to post. Nobody is driving it.", "Still being prepared."])

/** The record as the operator should read it once publishing put the order on the market. */
export function withPublication(view: RecordView, publication: Publication | null | undefined): RecordView {
  if (publication?.stage !== "market") return view
  return {
    ...view,
    story: UNPOSTED.has(view.story.headline) ? { ...view.story, headline: "Looking for a driver." } : view.story,
    tiles: view.tiles.map((tile) => tile.label === "Driver" && tile.hint === "not on the market" ? { ...tile, hint: "on the market" } : tile),
  }
}
