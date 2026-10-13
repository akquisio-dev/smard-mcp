/**
 * In-memory imitation of the SMARD chart_data API for tests.
 *
 * Hourly and quarter-hourly data come in weekly blocks starting Monday
 * 00:00 Berlin, daily data in yearly blocks starting 1 January, as on
 * smard.de. Daily values are the sum (energy) or mean (prices) of the
 * hourly values of that Berlin day. Values at or after `dataEnd` are null.
 */

import { berlinMidnight } from "../src/time.js";

const HOUR = 3_600_000;

/** Hourly value of a series, or null for "no data". */
export type ValueFn = (timestamp: number, region: string) => number | null;

export interface FakeSeries {
  value: ValueFn;
  /** How daily values are derived from hourly ones. */
  aggregate?: "sum" | "mean";
  /** Regions with data; others answer 404. Default: all. */
  regions?: string[];
}

export interface FakeSmardOptions {
  series: Record<number, FakeSeries>;
  /** First instant without data (e.g. "now"). */
  dataEnd: number;
}

function weeklyStarts(): number[] {
  // Monday 2025-09-29 .. end of 2026
  const starts: number[] = [];
  for (let d = 0; d < 7 * 66; d += 7) starts.push(berlinMidnight(2025, 9, 29 + d));
  return starts;
}

function yearlyStarts(): number[] {
  return [2024, 2025, 2026].map((y) => berlinMidnight(y, 1, 1));
}

function dayStartsBetween(from: number, to: number): number[] {
  const out: number[] = [];
  const first = new Date(from + 12 * HOUR); // safely inside the first Berlin day
  for (let i = 0; ; i++) {
    const t = berlinMidnight(first.getUTCFullYear(), first.getUTCMonth() + 1, first.getUTCDate() + i);
    if (t >= to) break;
    if (t >= from) out.push(t);
  }
  return out;
}

export function createFakeSmard(options: FakeSmardOptions) {
  const weeks = weeklyStarts();
  const years = yearlyStarts();
  const calls: string[] = [];

  function hourly(series: FakeSeries, t: number, region: string): number | null {
    return t + HOUR <= options.dataEnd ? series.value(t, region) : null;
  }

  function block(filter: number, region: string, resolution: string, start: number): [number, number | null][] | undefined {
    const s = options.series[filter];
    if (!s) return undefined;
    if (resolution === "hour" || resolution === "quarterhour") {
      const i = weeks.indexOf(start);
      if (i < 0) return undefined;
      const end = weeks[i + 1] ?? start + 7 * 24 * HOUR;
      const step = resolution === "hour" ? HOUR : HOUR / 4;
      const out: [number, number | null][] = [];
      for (let t = start; t < end; t += step) {
        const hourStart = t - ((t - start) % HOUR);
        out.push([t, t + step <= options.dataEnd ? s.value(hourStart, region) : null]);
      }
      return out;
    }
    if (resolution === "day") {
      const i = years.indexOf(start);
      if (i < 0) return undefined;
      const end = years[i + 1] ?? berlinMidnight(2027, 1, 1);
      return dayStartsBetween(start, end).map((day) => {
        const next = berlinMidnight(new Date(day + 12 * HOUR).getUTCFullYear(), new Date(day + 12 * HOUR).getUTCMonth() + 1, new Date(day + 12 * HOUR).getUTCDate() + 1);
        if (next > options.dataEnd) return [day, null];
        const vals: number[] = [];
        for (let t = day; t < next; t += HOUR) {
          const v = hourly(s, t, region);
          if (v !== null) vals.push(v);
        }
        if (vals.length === 0) return [day, null];
        const total = vals.reduce((a, b) => a + b, 0);
        return [day, s.aggregate === "mean" ? total / vals.length : total];
      });
    }
    return undefined;
  }

  const fetch = async (input: string | URL | Request): Promise<Response> => {
    const path = String(input).replace(/^.*\/chart_data\//, "");
    calls.push(path);
    const index = /^(\d+)\/([^/]+)\/index_(\w+)\.json$/.exec(path);
    if (index) {
      const [, f, region, res] = index;
      const s = options.series[Number(f)];
      if (!s || (s.regions && !s.regions.includes(region!))) return new Response("", { status: 404 });
      const timestamps = res === "day" ? years : res === "hour" || res === "quarterhour" ? weeks : undefined;
      if (!timestamps) return new Response("", { status: 404 });
      return Response.json({ timestamps });
    }
    const data = /^(\d+)\/([^/]+)\/\d+_[^_]+_(\w+)_(\d+)\.json$/.exec(path);
    if (data) {
      const [, f, region, res, start] = data;
      const s = options.series[Number(f)];
      if (s?.regions && !s.regions.includes(region!)) return new Response("", { status: 404 });
      const series = block(Number(f), region!, res!, Number(start));
      return series ? Response.json({ meta_data: { version: 1 }, series }) : new Response("", { status: 404 });
    }
    return new Response("", { status: 404 });
  };

  return { fetch: fetch as typeof globalThis.fetch, calls };
}
