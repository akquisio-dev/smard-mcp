/** Nationwide public holidays in Germany (port of smard-forecast's sf/kalender.py). */

/** Easter Sunday (Gregorian calendar) as [month, day]. */
export function easterSunday(year: number): [number, number] {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const g = Math.floor((8 * b + 13) / 25);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const n = h + l - 7 * m + 114;
  return [Math.floor(n / 31), (n % 31) + 1];
}

const cache = new Map<number, Set<string>>();

/** Holidays of a year as "YYYY-MM-DD". */
export function holidays(year: number): Set<string> {
  const hit = cache.get(year);
  if (hit) return hit;
  const [em, ed] = easterSunday(year);
  const easter = Date.UTC(year, em - 1, ed);
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const rel = (days: number) => iso(easter + days * 86_400_000);
  const p = (m: number, d: number) => `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const set = new Set([p(1, 1), rel(-2), rel(1), p(5, 1), rel(39), rel(50), p(10, 3), p(12, 25), p(12, 26)]);
  cache.set(year, set);
  return set;
}
