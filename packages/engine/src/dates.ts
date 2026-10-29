/**
 * Date helpers that work in the tenant's time zone without external libraries.
 * Dates the engine returns are plain calendar dates (yyyy-mm-dd) in that zone.
 */

const DAY_MS = 86_400_000;

/** Calendar date (yyyy-mm-dd) of an instant in a given IANA time zone. */
export function localDate(isoInstant: string, timeZone: string): string {
  const d = new Date(isoInstant);
  if (Number.isNaN(d.getTime())) {
    throw new RangeError(`Invalid date: ${isoInstant}`);
  }
  // en-CA formats as yyyy-mm-dd
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** Calendar year of an instant in the tenant's time zone. */
export function localYear(isoInstant: string, timeZone: string): string {
  return localDate(isoInstant, timeZone).slice(0, 4);
}

/** ISO day of week (1 = Monday ... 7 = Sunday) for a yyyy-mm-dd date. */
export function isoDayOfWeek(ymd: string): number {
  const d = new Date(`${ymd}T00:00:00Z`);
  const js = d.getUTCDay(); // 0 = Sunday
  return js === 0 ? 7 : js;
}

/** Add calendar days to a yyyy-mm-dd date. */
export function addCalendarDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  return new Date(d.getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Add working days, skipping the tenant's weekend days.
 * 0 days returns the same date (immediate resolution).
 */
export function addWorkingDays(ymd: string, days: number, weekendDays: number[]): string {
  let current = ymd;
  let remaining = days;
  while (remaining > 0) {
    current = addCalendarDays(current, 1);
    if (!weekendDays.includes(isoDayOfWeek(current))) {
      remaining -= 1;
    }
  }
  return current;
}

/** Whole days between two instants (b - a), floored. */
export function daysBetween(aIso: string, bIso: string): number {
  return Math.floor((new Date(bIso).getTime() - new Date(aIso).getTime()) / DAY_MS);
}
