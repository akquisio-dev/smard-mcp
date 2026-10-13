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
  /** End of that last interval, i.e. how far the result reaches, or null. */
  coveredUntil: number | null;
  /** True if the data covers the whole requested range. */
  complete: boolean;
  /** Human-readable remarks, e.g. about incomplete data. */
  notes: string[];
}

/**
 * A series whose last value lies this far behind the newest series has
 * ended (e.g. nuclear, whose last SMARD value is from January 2024) instead
 * of merely being published later than the others.
 */
export const ENDED_SERIES_GAP_MS = 7 * DAY;

/**
 * Fetches all `keys` for one range and cuts every series at the newest
 * timestamp that all still-reporting series have reached, so that totals and
 * shares cover the same interval. Series without data in the range, or that
 * ended long before the others, do not hold the others back.
 */
export async function fetchAligned(
  client: SmardClient,
  keys: readonly string[],
  region: Region,
  from: number,
  to: number,
  resolution: AnalysisResolution,
  now = Date.now(),
  maxBlocks: number = MAX_BLOCKS[resolution],
): Promise<AlignedData> {
  const range = effectiveRange(from, to, resolution);
  if (range.to <= range.from) {
    return {
      series: [],
      resolution,
      from: range.from,
      to: range.to,
      dataUntil: null,
      coveredUntil: null,
      complete: false,
      notes: ["The range contains no complete day."],
    };
  }

  const series = await Promise.all(
    keys.map(async (key) => {
      const info = findSeries(key);
      if (!info) throw new Error(`Unknown series ${key}`);
      try {
        const points = await client.getRange(info.filter, region, resolution, range.from, range.to, { maxBlocks });
        return { info, points };
      } catch (err) {
        // A series SMARD does not offer for this region counts as "no data".
        if (err instanceof SmardError && err.status === 404) return { info, points: [] as DataPoint[] };
        throw err;
      }
    }),
  );

  const notes: string[] = [];
  const lastOf = (s: FetchedSeries) => s.points[s.points.length - 1]?.timestamp;
  const lasts = series.map(lastOf).filter((t): t is number => t !== undefined);
  const newest = lasts.length > 0 ? Math.max(...lasts) : null;
  let dataUntil: number | null = null;
  if (newest !== null) {
    const reporting = lasts.filter((t) => t >= newest - ENDED_SERIES_GAP_MS);
    dataUntil = Math.min(...reporting);
    for (const s of series) {
      const last = lastOf(s);
      if (last !== undefined && last < newest - ENDED_SERIES_GAP_MS) {
        notes.push(`${s.info.key} has no data after ${formatBerlin(last)}.`);
      }
      s.points = s.points.filter((p) => p.timestamp <= dataUntil!);
    }
  }

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

  const complete = dataUntil !== null && coveredEnd >= range.to && range.from === from && range.to === to;
  return {
    series,
    resolution,
    from: range.from,
    to: range.to,
    dataUntil,
    coveredUntil: dataUntil === null ? null : coveredEnd,
    complete,
    notes,
  };
}

/**
 * Newest timestamp with a value in a series (start of that interval),
 * searching backwards from the block that contains `now`; null if the last
 * few blocks hold nothing.
 */
export async function newestDataPoint(
  client: SmardClient,
  key: string,
  region: Region,
  resolution: AnalysisResolution,
  now = Date.now(),
): Promise<number | null> {
  const info = findSeries(key);
  if (!info) return null;
  try {
    const index = await client.getIndex(info.filter, region, resolution);
    // Day-ahead prices reach into tomorrow, which may be the next block.
    const candidates = index.filter((start) => start <= now + DAY).slice(-3).reverse();
    for (const start of candidates) {
      const points = await client.getBlock(info.filter, region, resolution, start, start === index[index.length - 1]);
      const last = points[points.length - 1];
      if (last) return last.timestamp;
    }
  } catch (err) {
    if (!(err instanceof SmardError)) throw err;
  }
  return null;
}

/** Message for an analysis over a period without any data. */
export function noDataMessage(newest: number | null, resolution: AnalysisResolution): string {
  const until = newest === null ? "unknown" : formatBerlin(newest + INTERVAL_MS[resolution]);
  return (
    `No data for this period; the newest data reaches until ${until}. ` +
    "For the future use get_series with forecast_generation_* / forecast_consumption_* series, " +
    "or price_de_lu (day-ahead prices for tomorrow are published after the auction around noon)."
  );
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
