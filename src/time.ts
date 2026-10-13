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

/** Midnight Europe/Berlin of the given calendar day, as ms since epoch. */
export function berlinMidnight(year: number, month: number, day: number): number {
  const guess = Date.UTC(year, month - 1, day);
  // Take the offset at the candidate instant itself; DST switches happen at
  // 01:00 UTC, so they never fall between local midnight and UTC midnight.
  const candidate = guess - berlinOffsetMinutes(guess) * 60_000;
  return guess - berlinOffsetMinutes(candidate) * 60_000;
}

/**
 * Parses an ISO 8601 date or date-time. A plain date (YYYY-MM-DD) means the
 * start of that day in Berlin, or with `endOfDay` the start of the next day.
 */
export function parseTime(input: string, endOfDay = false): number {
  const m = DATE_ONLY.exec(input);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const check = new Date(Date.UTC(y, mo - 1, d));
    if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) throw new Error(`Invalid date: ${input}`);
    return endOfDay ? berlinMidnight(y, mo, d + 1) : berlinMidnight(y, mo, d);
  }
  if (!/[Tt ]\d{2}:\d{2}/.test(input) || !/(Z|z|[+-]\d{2}:?\d{2})$/.test(input)) {
    throw new Error(`Invalid time "${input}": use YYYY-MM-DD or a full ISO 8601 date-time with offset, e.g. 2026-10-01T00:00:00+02:00`);
  }
  const ms = Date.parse(input);
  if (Number.isNaN(ms)) throw new Error(`Invalid time: ${input}`);
  return ms;
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
