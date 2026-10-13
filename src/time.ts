/**
 * Time helpers. SMARD data follows German market time, so dates without a
 * time are interpreted as midnight in Europe/Berlin and outputs carry the
 * Berlin UTC offset.
 */

const TZ = "Europe/Berlin";
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

const partsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function berlinParts(ms: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of partsFormatter.formatToParts(new Date(ms))) out[p.type] = p.value;
  return out;
}

/** Offset of Europe/Berlin from UTC at the given instant, in minutes. */
export function berlinOffsetMinutes(ms: number): number {
  const p = berlinParts(ms);
  const asUtc = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
}

/** Converts a Europe/Berlin wall-clock time to ms since epoch. */
export function berlinLocalToUtc(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  // Two passes: the offset at the first estimate may differ from the offset at
  // the result when a DST switch lies in between. Times that do not exist
  // (spring gap) or exist twice (autumn overlap) resolve to one of the
  // neighbouring instants.
  const candidate = guess - berlinOffsetMinutes(guess) * 60_000;
  return guess - berlinOffsetMinutes(candidate) * 60_000;
}

/** Midnight Europe/Berlin of the given calendar day, as ms since epoch. */
export function berlinMidnight(year: number, month: number, day: number): number {
  return berlinLocalToUtc(year, month, day);
}

const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;

/**
 * Parses an ISO 8601 date or date-time. A plain date (YYYY-MM-DD) means the
 * start of that day in Berlin, or with `endOfDay` the start of the next day.
 * A date-time without offset is read as Europe/Berlin local time.
 */
export function parseTime(input: string, endOfDay = false): number {
  const m = DATE_ONLY.exec(input);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    checkCalendarDate(input, y, mo, d);
    return endOfDay ? berlinMidnight(y, mo, d + 1) : berlinMidnight(y, mo, d);
  }
  const local = LOCAL_DATE_TIME.exec(input);
  if (local) {
    const [y, mo, d, h, mi, sec] = local.slice(1).map((v) => Number(v ?? 0)) as [number, number, number, number, number, number];
    checkCalendarDate(input, y, mo, d);
    if (h > 23 || mi > 59 || sec > 59) throw new Error(`Invalid time: ${input}`);
    return berlinLocalToUtc(y, mo, d, h, mi, sec);
  }
  if (!/[Tt ]\d{2}:\d{2}/.test(input) || !/(Z|z|[+-]\d{2}:?\d{2})$/.test(input)) {
    throw new Error(`Invalid time "${input}": use YYYY-MM-DD or an ISO 8601 date-time, e.g. 2026-10-01T14:00 (Berlin) or 2026-10-01T12:00:00Z`);
  }
  const ms = Date.parse(input);
  if (Number.isNaN(ms)) throw new Error(`Invalid time: ${input}`);
  return ms;
}

function checkCalendarDate(input: string, y: number, mo: number, d: number): void {
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) throw new Error(`Invalid date: ${input}`);
}

/** ISO 8601 in Berlin local time with offset, e.g. 2026-10-12T14:00:00+02:00. */
export function formatBerlin(ms: number): string {
  const p = berlinParts(ms);
  const off = berlinOffsetMinutes(ms);
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${sign}${hh}:${mm}`;
}

/** Start of the Berlin calendar day containing `ms`. */
export function berlinDayFloor(ms: number): number {
  const p = berlinParts(ms);
  return berlinMidnight(+p.year!, +p.month!, +p.day!);
}

/** `ms` if it is a Berlin midnight, else the start of the next Berlin day. */
export function berlinDayCeil(ms: number): number {
  const floor = berlinDayFloor(ms);
  if (floor === ms) return ms;
  const p = berlinParts(ms);
  return berlinMidnight(+p.year!, +p.month!, +p.day! + 1);
}

/**
 * Start of the interval following the one starting at `ms`, for SMARD
 * resolutions. Calendar-based for day/week/month/year, so DST days and
 * months of different length come out right.
 */
export function nextIntervalStart(ms: number, resolution: string): number {
  const p = berlinParts(ms);
  const [y, m, d] = [+p.year!, +p.month!, +p.day!];
  switch (resolution) {
    case "quarterhour":
      return ms + 15 * 60_000;
    case "hour":
      return ms + 3_600_000;
    case "day":
      return berlinMidnight(y, m, d + 1);
    case "week":
      return berlinMidnight(y, m, d + 7);
    case "month":
      return berlinMidnight(y, m + 1, 1);
    case "year":
      return berlinMidnight(y + 1, 1, 1);
    default:
      throw new Error(`Unknown resolution ${resolution}`);
  }
}
