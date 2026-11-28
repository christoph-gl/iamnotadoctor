/**
 * Minimal iCalendar (RFC 5545) reader for finding the events that fall on one day.
 *
 * Supports what calendar exports such as Google Calendar's "secret address in iCal format"
 * use for training plans: single events, all-day events, TZID / UTC times, and DAILY,
 * WEEKLY, MONTHLY and YEARLY recurrence with INTERVAL, BYDAY (weekly), UNTIL, COUNT,
 * EXDATE and moved/cancelled instances (RECURRENCE-ID). Other RRULE parts are ignored.
 */

export type CalendarEvent = {
  uid: string;
  summary: string;
  description: string;
  /** Start instant (for all-day events: midnight UTC of the date; see allDay). */
  start: Date;
  end: Date;
  allDay: boolean;
  /** Local date (YYYY-MM-DD) of an all-day event. */
  allDayDate?: string;
};

type IcalDate = {
  /** Wall-clock parts in `tzid` (or UTC when utc is true). */
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  ss: number;
  dateOnly: boolean;
  utc: boolean;
  tzid?: string;
};

type RawEvent = {
  uid: string;
  summary: string;
  description: string;
  status: string;
  dtstart?: IcalDate;
  dtend?: IcalDate;
  durationSeconds?: number;
  rrule?: Record<string, string>;
  exdates: IcalDate[];
  recurrenceId?: IcalDate;
};

type Property = { name: string; params: Record<string, string>; value: string };

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

function unfold(text: string) {
  return text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
}

function parseProperty(line: string): Property | null {
  // NAME;PARAM=VALUE;PARAM="VALUE":value  (colon inside quoted params is allowed)
  let inQuotes = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') inQuotes = !inQuotes;
    if (char === ":" && !inQuotes) {
      colon = i;
      break;
    }
  }
  if (colon === -1) return null;
  const [name, ...paramParts] = line.slice(0, colon).split(";");
  const params: Record<string, string> = {};
  for (const part of paramParts) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: name.toUpperCase(), params, value: line.slice(colon + 1) };
}

function unescapeText(value: string) {
  return value.replace(/\\([\\;,nN])/g, (_, char: string) => (char === "n" || char === "N" ? "\n" : char));
}

function parseDateValue(value: string, params: Record<string, string>): IcalDate | null {
  const match = value.trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!match) return null;
  const dateOnly = params.VALUE === "DATE" || match[4] === undefined;
  return {
    y: Number(match[1]),
    m: Number(match[2]),
    d: Number(match[3]),
    hh: dateOnly ? 0 : Number(match[4]),
    mm: dateOnly ? 0 : Number(match[5]),
    ss: dateOnly ? 0 : Number(match[6]),
    dateOnly,
    utc: match[7] === "Z",
    tzid: params.TZID,
  };
}

function parseDuration(value: string) {
  const match = value.match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!match) return undefined;
  const [, sign, w, d, h, m, s] = match;
  const seconds =
    Number(w ?? 0) * 604800 + Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0);
  return sign === "-" ? -seconds : seconds;
}

/** Offset (ms) of `timeZone` from UTC at the given instant. */
function timeZoneOffsetMs(instant: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(instant / 1000) * 1000;
}

export function isValidTimeZone(timeZone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Instant for wall-clock parts in a time zone (UTC when none or unknown). */
function wallClockToInstant(y: number, m: number, d: number, hh: number, mm: number, ss: number, timeZone?: string) {
  const naive = Date.UTC(y, m - 1, d, hh, mm, ss);
  if (!timeZone || !isValidTimeZone(timeZone)) return naive;
  // Two passes settle the offset around DST changes.
  let instant = naive - timeZoneOffsetMs(naive, timeZone);
  instant = naive - timeZoneOffsetMs(instant, timeZone);
  return instant;
}

function toInstant(date: IcalDate, fallbackTimeZone?: string) {
  const timeZone = date.utc || date.dateOnly ? undefined : date.tzid ?? fallbackTimeZone;
  return wallClockToInstant(date.y, date.m, date.d, date.hh, date.mm, date.ss, timeZone);
}

/** YYYY-MM-DD of an instant in a time zone. */
export function localDateKey(instant: Date | number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function dayNumber(y: number, m: number, d: number) {
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

function fromDayNumber(day: number) {
  const date = new Date(day * 86400000);
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
}

function dateKey(y: number, m: number, d: number) {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function parseIcal(text: string): RawEvent[] {
  const events: RawEvent[] = [];
  let current: RawEvent | null = null;
  let nestedDepth = 0;

  for (const line of unfold(text)) {
    if (!line) continue;
    const upper = line.toUpperCase();
    if (upper === "BEGIN:VEVENT") {
      current = { uid: "", summary: "", description: "", status: "", exdates: [] };
      nestedDepth = 0;
      continue;
    }
    if (!current) continue;
    if (upper === "END:VEVENT") {
      events.push(current);
      current = null;
      continue;
    }
    if (upper.startsWith("BEGIN:")) {
      nestedDepth++;
      continue;
    }
    if (upper.startsWith("END:")) {
      nestedDepth = Math.max(0, nestedDepth - 1);
      continue;
    }
    if (nestedDepth > 0) continue; // e.g. VALARM

    const property = parseProperty(line);
    if (!property) continue;
    const { name, params, value } = property;
    switch (name) {
      case "UID":
        current.uid = value;
        break;
      case "SUMMARY":
        current.summary = unescapeText(value);
        break;
      case "DESCRIPTION":
        current.description = unescapeText(value);
        break;
      case "STATUS":
        current.status = value.toUpperCase();
        break;
      case "DTSTART":
        current.dtstart = parseDateValue(value, params) ?? undefined;
        break;
      case "DTEND":
        current.dtend = parseDateValue(value, params) ?? undefined;
        break;
      case "DURATION":
        current.durationSeconds = parseDuration(value);
        break;
      case "RRULE":
        current.rrule = Object.fromEntries(
          value.split(";").map((part) => {
            const [key, ...rest] = part.split("=");
            return [key.toUpperCase(), rest.join("=").toUpperCase()];
          }),
        );
        break;
      case "EXDATE":
        for (const item of value.split(",")) {
          const parsed = parseDateValue(item, params);
          if (parsed) current.exdates.push(parsed);
        }
        break;
      case "RECURRENCE-ID":
        current.recurrenceId = parseDateValue(value, params) ?? undefined;
        break;
    }
  }
  return events;
}

/** Whether a recurring event has an occurrence on local day `day` (day number in the event's zone). */
function ruleMatchesDay(rule: Record<string, string>, start: IcalDate, day: number) {
  const startDay = dayNumber(start.y, start.m, start.d);
  if (day < startDay) return false;
  const interval = Math.max(1, Number(rule.INTERVAL ?? 1) || 1);
  const { y, m, d } = fromDayNumber(day);
  switch (rule.FREQ) {
    case "DAILY":
      return (day - startDay) % interval === 0;
    case "WEEKLY": {
      const weekday = new Date(day * 86400000).getUTCDay();
      const byDay = rule.BYDAY
        ? rule.BYDAY.split(",").map((entry) => entry.replace(/^[+-]?\d+/, ""))
        : [WEEKDAYS[new Date(startDay * 86400000).getUTCDay()]];
      if (!byDay.includes(WEEKDAYS[weekday])) return false;
      const weekStart = Math.max(0, WEEKDAYS.indexOf(rule.WKST ?? "MO"));
      const weekIndex = (n: number) => Math.floor((n - ((new Date(n * 86400000).getUTCDay() - weekStart + 7) % 7)) / 7);
      return (weekIndex(day) - weekIndex(startDay)) % interval === 0;
    }
    case "MONTHLY": {
      if (rule.BYDAY || rule.BYSETPOS) return false; // unsupported
      const months = (y - start.y) * 12 + (m - start.m);
      const dayOfMonth = rule.BYMONTHDAY ? Number(rule.BYMONTHDAY) : start.d;
      return d === dayOfMonth && months % interval === 0;
    }
    case "YEARLY":
      return m === start.m && d === start.d && (y - start.y) % interval === 0;
    default:
      return false;
  }
}

function eventDurationMs(event: RawEvent) {
  if (event.dtend && event.dtstart) {
    return toInstant(event.dtend, event.dtstart.tzid) - toInstant(event.dtstart);
  }
  if (event.durationSeconds !== undefined) return event.durationSeconds * 1000;
  return event.dtstart?.dateOnly ? 86400000 : 0;
}

function makeOccurrence(event: RawEvent, startParts: IcalDate): CalendarEvent {
  const start = toInstant(startParts);
  return {
    uid: event.uid,
    summary: event.summary,
    description: event.description,
    start: new Date(start),
    end: new Date(start + eventDurationMs(event)),
    allDay: startParts.dateOnly,
    allDayDate: startParts.dateOnly ? dateKey(startParts.y, startParts.m, startParts.d) : undefined,
  };
}

/** Events (including recurring instances) that start on `date` (YYYY-MM-DD) in `timeZone`. */
export function eventsOnDate(events: RawEvent[], date: string, timeZone: string): CalendarEvent[] {
  const [ty, tm, td] = date.split("-").map(Number);
  const targetDay = dayNumber(ty, tm, td);
  const onTarget = (occurrence: CalendarEvent) =>
    occurrence.allDay ? occurrence.allDayDate === date : localDateKey(occurrence.start, timeZone) === date;

  // Instances moved or cancelled via RECURRENCE-ID replace their original occurrence.
  const overriddenInstants = new Map<string, Set<number>>();
  for (const event of events) {
    if (!event.recurrenceId) continue;
    const set = overriddenInstants.get(event.uid) ?? new Set<number>();
    set.add(toInstant(event.recurrenceId, event.dtstart?.tzid));
    overriddenInstants.set(event.uid, set);
  }

  const result: CalendarEvent[] = [];
  for (const event of events) {
    if (!event.dtstart || event.status === "CANCELLED") continue;

    if (!event.rrule || event.recurrenceId) {
      const occurrence = makeOccurrence(event, event.dtstart);
      if (onTarget(occurrence)) result.push(occurrence);
      continue;
    }

    const rule = event.rrule;
    const start = event.dtstart;
    const until = rule.UNTIL ? parseDateValue(rule.UNTIL, {}) : null;
    const untilInstant = until ? (until.dateOnly ? Date.UTC(until.y, until.m - 1, until.d, 23, 59, 59) : toInstant(until, start.tzid)) : Infinity;
    const count = rule.COUNT ? Number(rule.COUNT) : Infinity;
    const excluded = new Set(event.exdates.map((exdate) => toInstant(exdate, start.tzid)));
    const overridden = overriddenInstants.get(event.uid);

    const occurrenceOn = (day: number): CalendarEvent | null => {
      if (!ruleMatchesDay(rule, start, day)) return null;
      const { y, m, d } = fromDayNumber(day);
      const occurrence = makeOccurrence(event, { ...start, y, m, d });
      if (occurrence.start.getTime() > untilInstant) return null;
      return occurrence;
    };

    // Look one day either side: a timed event's day in its own zone can differ from the rider's.
    for (let day = targetDay - 1; day <= targetDay + 1; day++) {
      const occurrence = occurrenceOn(day);
      if (!occurrence || !onTarget(occurrence)) continue;
      const instant = occurrence.start.getTime();
      if (excluded.has(instant) || overridden?.has(instant)) continue;
      if (Number.isFinite(count)) {
        // COUNT includes excluded instances, so count every rule match up to this day.
        let index = 0;
        for (let n = dayNumber(start.y, start.m, start.d); n <= day && index <= count; n++) {
          if (ruleMatchesDay(rule, start, n)) index++;
        }
        if (index > count) continue;
      }
      result.push(occurrence);
    }
  }

  return result.sort((a, b) => a.start.getTime() - b.start.getTime());
}
