/**
 * Builds the model inputs from one weather run, exactly like smard-forecast's
 * sf/merkmale.py (ausrichten, lauf_merkmale, kalender). Every change there
 * must be mirrored here; test/forecast-parity.test.ts compares both.
 *
 * Time alignment: a row is the SMARD hour starting at S (UTC). Radiation at
 * Open-Meteo is the mean of the hour ENDING at the stamp, so the value at S+1h
 * belongs to S. Instantaneous values are averaged to the middle of the hour.
 * Wind direction is split into sine and cosine before averaging. Python
 * computes these in float32; Math.fround reproduces that closely enough (the
 * parity test bounds the remaining difference).
 */

import { holidays } from "./holidays.js";
import { solarElevation } from "./sun.js";

export const RADIATION = new Set(["shortwave_radiation", "direct_radiation", "diffuse_radiation"]);
const HOUR = 3_600_000;
const f32 = Math.fround;
const DEG = f32(Math.PI / 180);

export interface Place {
  name: string;
  lat: number;
  lon: number;
  typ: string[];
}

/** One place's hourly forecast: times (ms, UTC, hourly steps) and values per variable. */
export interface PlaceSeries {
  time: number[];
  values: Record<string, (number | null)[]>;
}

/** Aligned columns of one place, keyed by feature suffix (e.g. wind_direction_100m_sin). */
export function align(series: PlaceSeries, variables: string[]): Record<string, number[]> {
  const n = series.time.length;
  const out: Record<string, number[]> = {};
  const at = (arr: (number | null)[], i: number) => {
    const v = i < n ? arr[i] : null;
    return v === null || v === undefined ? NaN : f32(v);
  };
  for (const v of variables) {
    const raw = series.values[v] ?? [];
    if (v.startsWith("wind_direction")) {
      const sin: number[] = [];
      const cos: number[] = [];
      for (let i = 0; i < n; i++) {
        const a = at(raw, i);
        const b = at(raw, i + 1);
        const ra = f32(a * DEG);
        const rb = f32(b * DEG);
        sin.push(f32(f32(f32(Math.sin(ra)) + f32(Math.sin(rb))) / 2));
        cos.push(f32(f32(f32(Math.cos(ra)) + f32(Math.cos(rb))) / 2));
      }
      out[`${v}_sin`] = sin;
      out[`${v}_cos`] = cos;
      continue;
    }
    const col: number[] = [];
    for (let i = 0; i < n; i++) {
      const next = at(raw, i + 1);
      col.push(RADIATION.has(v) ? next : f32(f32(at(raw, i) + next) / 2));
    }
    out[v] = col;
  }
  return out;
}

const weekdayFmt = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Berlin", weekday: "short" });
const dateFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" });
const WEEKDAY: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

function dayOfYear(ms: number): number {
  const d = new Date(ms);
  return Math.floor((ms - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000) + 1;
}

/** Calendar features of the hour starting at `start` (ms, UTC). */
export function calendar(start: number, places: Place[]): Record<string, number> {
  const mid = start + HOUR / 2;
  const h = new Date(mid).getUTCHours() + 0.5;
  const doy = dayOfYear(mid);
  const localDate = dateFmt.format(new Date(mid));
  let sunMax = -Infinity;
  for (const p of places) sunMax = Math.max(sunMax, solarElevation(mid, p.lat, p.lon));
  return {
    stunde_sin: Math.sin((2 * Math.PI * h) / 24),
    stunde_cos: Math.cos((2 * Math.PI * h) / 24),
    jahr_sin: Math.sin((2 * Math.PI * doy) / 365.25),
    jahr_cos: Math.cos((2 * Math.PI * doy) / 365.25),
    sonne_mitte: solarElevation(mid, 51.0, 10.0),
    sonne_max: sunMax,
    wochentag: WEEKDAY[weekdayFmt.format(new Date(mid))]!,
    feiertag: holidays(Number(localDate.slice(0, 4))).has(localDate) ? 1 : 0,
  };
}

export interface FeatureRows {
  time: number[];
  /** Feature values per row, in the model's feature order; vorlauf_tag is left as NaN. */
  rows: Float64Array[];
  sunMax: number[];
}

/**
 * Feature rows for one source. `places` are the places of that source's type,
 * `series` maps place name to its forecast; all series must share one time axis.
 */
export function buildFeatures(featureNames: string[], places: Place[], series: Map<string, PlaceSeries>, variables: string[]): FeatureRows {
  const first = series.get(places[0]!.name)!;
  const time = first.time;
  const columns = new Map<string, number[]>();
  const suffixes: string[] = [];
  for (const p of places) {
    const s = series.get(p.name);
    if (!s) throw new Error(`weather for ${p.name} missing`);
    for (const [suffix, col] of Object.entries(align(s, variables))) {
      columns.set(`${p.name}__${suffix}`, col);
      if (!suffixes.includes(suffix)) suffixes.push(suffix);
    }
  }
  for (const suffix of suffixes) {
    const mean: number[] = [];
    for (let i = 0; i < time.length; i++) {
      let sum = 0;
      let count = 0;
      for (const p of places) {
        const v = columns.get(`${p.name}__${suffix}`)![i]!;
        if (!Number.isNaN(v)) {
          sum = f32(sum + v); // pandas sums float32 columns in float32
          count++;
        }
      }
      mean.push(count > 0 ? f32(sum / count) : NaN);
    }
    columns.set(`mittel__${suffix}`, mean);
  }
  const calendarNames = Object.keys(calendar(time[0] ?? 0, places));
  const unknown = featureNames.filter((n) => n !== "vorlauf_tag" && !columns.has(n) && !calendarNames.includes(n));
  if (unknown.length > 0) throw new Error(`model expects unknown features: ${unknown.join(", ")}`);
  const rows: Float64Array[] = [];
  const sunMax: number[] = [];
  for (let i = 0; i < time.length; i++) {
    const cal = calendar(time[i]!, places);
    sunMax.push(cal.sonne_max!);
    const row = new Float64Array(featureNames.length);
    featureNames.forEach((name, j) => {
      const col = columns.get(name);
      row[j] = col ? col[i]! : name in cal ? cal[name]! : NaN;
    });
    rows.push(row);
  }
  return { time, rows, sunMax };
}
