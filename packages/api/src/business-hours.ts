// Business-hours availability fallback: generates bookable slots from a
// declared weekly schedule when an account has no calendar provider
// connected (the Cloud Run / no-database demo deployment case).
//
// Deliberately dependency-free -- no date library, no python subprocess.
// Timezone handling is done with Intl.DateTimeFormat, which every
// supported Node build ships with full ICU for.

/** One contiguous open window on one weekday, in minutes past local midnight. */
export interface BusinessHoursWindow {
  /** 0 = Sunday .. 6 = Saturday, matching Date#getUTCDay(). */
  weekday: number;
  startMinutes: number;
  endMinutes: number;
}

export interface Slot {
  start: string;
  end: string;
}

export interface Interval {
  start: string;
  end: string;
}

export const DEFAULT_BUSINESS_HOURS = 'Mon-Fri 09:00-17:00';
export const DEFAULT_BUSINESS_TZ = 'America/New_York';

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * Parses the BUSINESS_HOURS env format: comma-separated entries, each
 * `<day-or-day-range> <HH:MM>-<HH:MM>`, e.g.
 *   "Mon-Fri 09:00-17:00,Sat 10:00-14:00"
 * Day names are the first three letters, case-insensitive. A day range may
 * wrap the week ("Fri-Mon"). Malformed entries are skipped (and reported
 * by the caller) rather than crashing the server at startup.
 */
export function parseBusinessHours(spec: string): BusinessHoursWindow[] {
  const windows: BusinessHoursWindow[] = [];
  for (const rawEntry of spec.split(',')) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const match = /^([A-Za-z]{3,9})(?:\s*-\s*([A-Za-z]{3,9}))?\s+(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(
      entry
    );
    if (!match) continue;
    const from = DAY_NAMES.indexOf(match[1].slice(0, 3).toLowerCase());
    const to = match[2] ? DAY_NAMES.indexOf(match[2].slice(0, 3).toLowerCase()) : from;
    if (from < 0 || to < 0) continue;
    const startMinutes = Number(match[3]) * 60 + Number(match[4]);
    const endMinutes = Number(match[5]) * 60 + Number(match[6]);
    if (
      Number(match[3]) > 23 ||
      Number(match[5]) > 24 ||
      Number(match[4]) > 59 ||
      Number(match[6]) > 59 ||
      endMinutes <= startMinutes
    ) {
      continue;
    }
    // Inclusive day range, wrapping the week if to < from ("Fri-Mon").
    for (let i = 0, day = from; i < 7; i++, day = (day + 1) % 7) {
      windows.push({ weekday: day, startMinutes, endMinutes });
      if (day === to) break;
    }
  }
  return windows;
}

interface CivilDate {
  year: number;
  month: number; // 1-12
  day: number;
}

/** The offset (ms) of `timeZone` from UTC at the given instant. */
function tzOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second')
  );
  return asUtc - instant.getTime();
}

/** The calendar date `instant` falls on in `timeZone`. */
export function civilDateIn(instant: Date, timeZone: string): CivilDate {
  const shifted = new Date(instant.getTime() + tzOffsetMs(instant, timeZone));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/**
 * The instant at which local wall-clock `date` + `minutes` past midnight
 * occurs in `timeZone`. Resolved by applying the offset and re-checking it
 * once, which settles DST transitions (the offset at the guessed instant
 * can differ from the offset at the real one).
 */
export function zonedWallClockToInstant(
  date: CivilDate,
  minutes: number,
  timeZone: string
): Date {
  const wall = Date.UTC(date.year, date.month - 1, date.day, 0, minutes);
  let instant = wall - tzOffsetMs(new Date(wall), timeZone);
  instant = wall - tzOffsetMs(new Date(instant), timeZone);
  return new Date(instant);
}

function weekdayOf(date: CivilDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

function addDays(date: CivilDate, days: number): CivilDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** How many days we'll ever walk for a single availability request. */
const MAX_DAYS = 370;

export interface ComputeBusinessHoursSlotsParams {
  start: string;
  end: string;
  slotMinutes: number;
  windows: BusinessHoursWindow[];
  timeZone: string;
  /** Already-booked intervals to subtract (non-canceled appointments). */
  busy?: Interval[];
  /** Injectable "now" -- slots never start in the past. */
  now?: Date;
}

/**
 * Business-hours slots inside [start, end), minus `busy`, never starting in
 * the past. Returned in the same `{ start, end }` ISO shape as the
 * calendar-provider path so callers can't tell the two apart.
 */
export function computeBusinessHoursSlots({
  start,
  end,
  slotMinutes,
  windows,
  timeZone,
  busy = [],
  now = new Date(),
}: ComputeBusinessHoursSlotsParams): Slot[] {
  const rangeStart = new Date(start).getTime();
  const rangeEnd = new Date(end).getTime();
  if (Number.isNaN(rangeStart) || Number.isNaN(rangeEnd)) return [];
  if (!(slotMinutes > 0) || rangeEnd <= rangeStart || windows.length === 0) return [];

  const slotMs = slotMinutes * 60_000;
  const earliest = Math.max(rangeStart, now.getTime());
  if (earliest >= rangeEnd) return [];

  const busyMs = busy
    .map((b) => ({ start: new Date(b.start).getTime(), end: new Date(b.end).getTime() }))
    .filter((b) => !Number.isNaN(b.start) && !Number.isNaN(b.end));

  const byWeekday = new Map<number, BusinessHoursWindow[]>();
  for (const w of windows) {
    const list = byWeekday.get(w.weekday) ?? [];
    list.push(w);
    byWeekday.set(w.weekday, list);
  }

  const slots: Slot[] = [];
  // Start a day early: a window that opens late in the local day can still
  // begin before `start` in UTC terms near a date boundary.
  let day = addDays(civilDateIn(new Date(rangeStart), timeZone), -1);
  const lastDay = addDays(civilDateIn(new Date(rangeEnd), timeZone), 1);
  const lastKey = lastDay.year * 10000 + lastDay.month * 100 + lastDay.day;

  for (let i = 0; i < MAX_DAYS; i++) {
    const dayWindows = (byWeekday.get(weekdayOf(day)) ?? [])
      .slice()
      .sort((a, b) => a.startMinutes - b.startMinutes);
    for (const w of dayWindows) {
      const windowStart = zonedWallClockToInstant(day, w.startMinutes, timeZone).getTime();
      const windowEnd = zonedWallClockToInstant(day, w.endMinutes, timeZone).getTime();
      for (let cursor = windowStart; cursor + slotMs <= windowEnd; cursor += slotMs) {
        const slotEnd = cursor + slotMs;
        if (cursor < earliest || slotEnd > rangeEnd) continue;
        if (busyMs.some((b) => b.start < slotEnd && b.end > cursor)) continue;
        slots.push({
          start: new Date(cursor).toISOString(),
          end: new Date(slotEnd).toISOString(),
        });
      }
    }
    if (day.year * 10000 + day.month * 100 + day.day >= lastKey) break;
    day = addDays(day, 1);
  }

  slots.sort((a, b) => a.start.localeCompare(b.start));
  return slots;
}

/** Reads BUSINESS_HOURS/BUSINESS_TZ from the environment, with defaults. */
export function businessHoursFromEnv(env: NodeJS.ProcessEnv = process.env): {
  windows: BusinessHoursWindow[];
  timeZone: string;
} {
  const spec = env.BUSINESS_HOURS || DEFAULT_BUSINESS_HOURS;
  let windows = parseBusinessHours(spec);
  if (windows.length === 0 && spec !== DEFAULT_BUSINESS_HOURS) {
    console.warn(
      `BUSINESS_HOURS="${spec}" did not parse into any open windows; falling back to "${DEFAULT_BUSINESS_HOURS}"`
    );
    windows = parseBusinessHours(DEFAULT_BUSINESS_HOURS);
  }
  let timeZone = env.BUSINESS_TZ || DEFAULT_BUSINESS_TZ;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    console.warn(`BUSINESS_TZ="${timeZone}" is not a valid IANA zone; falling back to ${DEFAULT_BUSINESS_TZ}`);
    timeZone = DEFAULT_BUSINESS_TZ;
  }
  return { windows, timeZone };
}
