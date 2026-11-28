import { eventsOnDate, isValidTimeZone, localDateKey, parseIcal, type CalendarEvent } from "./ical";

/**
 * Finds the workout planned for a day in the rider's calendar.
 *
 * The calendar is read from `PLANNED_WORKOUTS_ICAL_URL` (for Google Calendar: Settings →
 * the calendar → "Secret address in iCal format"). An event counts as a planned workout when
 * its title or description names a workout from the library, by id (e.g. `sweet-spot-3x10`)
 * or by name (e.g. "Norwegian 4x4").
 */

export type PlannedWorkout = {
  workoutId: string;
  eventTitle: string;
  start: string;
  allDay: boolean;
};

type LibraryEntry = { id: string; name: string };

const CACHE_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
let cache: { url: string; fetchedAt: number; text: string } | null = null;

export function plannedWorkoutsCalendarUrl() {
  return process.env.PLANNED_WORKOUTS_ICAL_URL?.trim() || null;
}

export function defaultPlannedWorkoutsTimeZone() {
  return process.env.PLANNED_WORKOUTS_TIMEZONE?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

async function fetchCalendar(url: string) {
  if (cache && cache.url === url && Date.now() - cache.fetchedAt < CACHE_MS) return cache.text;
  // Google shows the secret address as https://; webcal:// is the same feed.
  const response = await fetch(url.replace(/^webcal:\/\//i, "https://"), {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Calendar request failed with ${response.status}`);
  const text = await response.text();
  cache = { url, fetchedAt: Date.now(), text };
  return text;
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Position of `needle` in `haystack` as a whole phrase (case-insensitive), or -1. */
function phraseIndex(haystack: string, needle: string) {
  const trimmed = needle.trim();
  if (trimmed.length < 3) return -1;
  const match = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(trimmed)}(?![\\p{L}\\p{N}])`, "iu").exec(haystack);
  return match ? match.index : -1;
}

/**
 * Picks the library workout an event refers to. An id match beats a name match; otherwise the
 * workout mentioned first wins (so "Z2 Steady 60 (or Z2 Spark 45)" picks Z2 Steady 60), with
 * longer names winning ties.
 */
export function matchWorkout(event: Pick<CalendarEvent, "summary" | "description">, library: LibraryEntry[]) {
  const text = `${event.summary}\n${event.description}`;
  let best: { id: string; byId: boolean; index: number; length: number } | null = null;
  for (const workout of library) {
    const idIndex = phraseIndex(text, workout.id);
    const nameIndex = phraseIndex(text, workout.name);
    const candidate =
      idIndex !== -1
        ? { id: workout.id, byId: true, index: idIndex, length: workout.id.length }
        : nameIndex !== -1
          ? { id: workout.id, byId: false, index: nameIndex, length: workout.name.length }
          : null;
    if (!candidate) continue;
    if (
      !best ||
      (candidate.byId && !best.byId) ||
      (candidate.byId === best.byId &&
        (candidate.index < best.index || (candidate.index === best.index && candidate.length > best.length)))
    ) {
      best = candidate;
    }
  }
  return best?.id ?? null;
}

/**
 * Chooses among the day's workout events: the first one that has not ended yet, otherwise the
 * last one of the day (a ride planned for the morning can still be done in the evening).
 */
export function pickPlannedWorkout(
  events: CalendarEvent[],
  library: LibraryEntry[],
  now: Date = new Date(),
): PlannedWorkout | null {
  const matches = events
    .map((event) => ({ event, workoutId: matchWorkout(event, library) }))
    .filter((entry): entry is { event: CalendarEvent; workoutId: string } => entry.workoutId !== null);
  if (matches.length === 0) return null;
  const chosen = matches.find(({ event }) => event.allDay || event.end.getTime() > now.getTime()) ?? matches[matches.length - 1];
  return {
    workoutId: chosen.workoutId,
    eventTitle: chosen.event.summary,
    start: chosen.event.allDay ? chosen.event.allDayDate ?? chosen.event.start.toISOString() : chosen.event.start.toISOString(),
    allDay: chosen.event.allDay,
  };
}

export async function findPlannedWorkout(options: {
  library: LibraryEntry[];
  timeZone?: string;
  now?: Date;
}): Promise<PlannedWorkout | null> {
  const url = plannedWorkoutsCalendarUrl();
  if (!url) return null;
  const now = options.now ?? new Date();
  const timeZone =
    options.timeZone && isValidTimeZone(options.timeZone) ? options.timeZone : defaultPlannedWorkoutsTimeZone();
  const text = await fetchCalendar(url);
  const events = eventsOnDate(parseIcal(text), localDateKey(now, timeZone), timeZone);
  return pickPlannedWorkout(events, options.library, now);
}
