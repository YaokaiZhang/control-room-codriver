// A contact's name as a person reads it in a sentence. Pure: the order page runs it in the browser too.

/**
 * "Adrian Alderbrook, stock control" -> "Adrian Alderbrook"; "The assigned driver, drv-331" -> "the assigned driver";
 * "The driver who delivered the car (driver ID drv-136)" -> "the driver who delivered the car".
 * A role description ("The …", "A …") is lowercased to sit mid-sentence; an address stays as it is.
 */
export function plainName(name: string | null | undefined, fallback = "the contact"): string {
  const text = (name ?? "").replace(/\s*\([^)]*\)/g, "").split(",")[0].trim()
  if (!text) return fallback
  return /^(The|A|An) /.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text
}

/** Capitalises the first letter, for a name or headline that opens a sentence. */
export const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)
