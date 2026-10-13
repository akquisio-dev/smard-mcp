/**
 * Shared building blocks of the analysis tools: choosing a resolution,
 * fetching several series for one range, and cutting them to a common
 * data horizon so that totals and shares are always computed over the
 * same interval.
 */

import { GENERATION_SERIES, findSeries, type Region, type SeriesInfo } from "./catalog.js";
import { SmardError, type DataPoint, type SmardClient } from "./smard.js";
import { berlinDayCeil, berlinDayFloor, formatBerlin } from "./time.js";

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/** Up to this range length hourly values are used, above it daily values. */
export const HOURLY_MAX_RANGE_MS = 56 * DAY;

/** Longest range the aggregating tools accept (daily values, yearly blocks). */
export const MAX_RANGE_MS = 10 * 366 * DAY;

/** Block limits per resolution: hourly blocks span a week, daily blocks a year. */
const MAX_BLOCKS = { quarterhour: 10, hour: 10, day: 12 } as const;

export type AnalysisResolution = "quarterhour" | "hour" | "day";

export const INTERVAL_MS: Record<AnalysisResolution, number> = { quarterhour: HOUR / 4, hour: HOUR, day: DAY };

/**
 * Hourly up to 8 weeks, daily above. Week/month/year values are never used
 * for aggregation: SMARD leaves the running period empty and partial periods
 * would distort sums.
 */
export function chooseResolution(from: number, to: number): "hour" | "day" {
  return to - from <= HOURLY_MAX_RANGE_MS ? "hour" : "day";
}

/** Daily values cover whole Berlin days only, so the range is shrunk to them. */
export function effectiveRange(from: number, to: number, resolution: AnalysisResolution): { from: number; to: number } {
  if (resolution !== "day") return { from, to };
  return { from: berlinDayCeil(from), to: berlinDayFloor(to) };
}

export interface FetchedSeries {
  info: SeriesInfo;
  points: DataPoint[];
}

export interface AlignedData {
  series: FetchedSeries[];
  resolution: AnalysisResolution;
  from: number;
  to: number;
  /** Start of the last interval that every series with data covers, or null. */
  dataUntil: number | null;
  /** Human-readable remarks, e.g. about incomplete data. */
  notes: string[];
}

/**
 * Fetches all `keys` for one range and cuts every series at the newest
 * timestamp that all non-empty series have reached. Series without any data
 * in the range (e.g. nuclear after April 2023) stay empty and do not hold the
 * others back.
 */
export async function fetchAligned(
  client: SmardClient,
  keys: readonly string[],
  region: Region,
  from: number,
  to: number,
  resolution: AnalysisResolution,
  now = Date.now(),
): Promise<AlignedData> {
  const range = effectiveRange(from, to, resolution);
  if (range.to <= range.from) {
    return { series: [], resolution, from: range.from, to: range.to, dataUntil: null, notes: ["The range contains no complete day."] };
  }

  const series = await Promise.all(
    keys.map(async (key) => {
      const info = findSeries(key);
      if (!info) throw new Error(`Unknown series ${key}`);
      try {
        const points = await client.getRange(info.filter, region, resolution, range.from, range.to, {
          maxBlocks: MAX_BLOCKS[resolution],
        });
        return { info, points };
      } catch (err) {
        // A series SMARD does not offer for this region counts as "no data".
        if (err instanceof SmardError && err.status === 404) return { info, points: [] as DataPoint[] };
        throw err;
      }
    }),
  );

  const lasts = series.filter((s) => s.points.length > 0).map((s) => s.points[s.points.length - 1]!.timestamp);
  const dataUntil = lasts.length > 0 ? Math.min(...lasts) : null;
  if (dataUntil !== null) {
    for (const s of series) s.points = s.points.filter((p) => p.timestamp <= dataUntil);
  }

  const notes: string[] = [];
  const interval = INTERVAL_MS[resolution];
  const expectedEnd = Math.min(range.to, resolution === "day" ? berlinDayFloor(now) : now);
  const coveredEnd = dataUntil === null ? range.from : dataUntil + interval;
  if (dataUntil === null) {
    notes.push("SMARD has no data for this range yet.");
  } else if (coveredEnd < range.to) {
    const why =
      coveredEnd >= expectedEnd - interval
        ? range.to > now
          ? "the range reaches into the future"
          : resolution === "day"
            ? "daily values are published up to the previous day"
            : "SMARD has not published later values yet"
        : "SMARD has gaps in this range";
    notes.push(`Data is incomplete: values cover ${formatBerlin(range.from)} to ${formatBerlin(coveredEnd)} only (${why}).`);
  }
  if (resolution === "day" && (range.from !== from || range.to !== to)) {
    notes.push("Daily values were used, so the range was shrunk to whole days.");
  }

  return { series, resolution, from: range.from, to: range.to, dataUntil, notes };
}

export function sum(points: readonly DataPoint[]): number {
  let total = 0;
  for (const p of points) total += p.value;
  return total;
}

export function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export const GENERATION_KEYS = GENERATION_SERIES.map((s) => s.key);
export const LOAD_KEY = "consumption_total";
export const PRICE_KEY = "price_de_lu";
