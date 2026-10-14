/** find_best_hours: cheapest / greenest contiguous time window of a day. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HOUR, mean } from "../analysis.js";
import { ATTRIBUTION, findSeries, type Region } from "../catalog.js";
import { SmardError, type SmardClient } from "../smard.js";
import { berlinDayFloor, formatBerlin, nextIntervalStart, parseTime } from "../time.js";
import { InputError, READ_ONLY_REMOTE, fmt1, guarded, round1, round2, toolResult, commonFields } from "./common.js";
import { MIX_REGIONS } from "./generation-mix.js";

export const WHOLESALE_NOTE =
  "Prices are day-ahead wholesale prices (DE-LU) without taxes, levies and grid fees; for households they matter directly only with a dynamic electricity tariff.";
export const GREEN_DEFINITION =
  "Green share = wind + solar generation in % of consumption (forecasts for today and later, intraday for today where available, actual values for past days).";
export const BALANCED_DEFINITION =
  "Balanced: per interval, price and green share are each scaled to 0..1 over the intervals of the day (cheapest = 1, greenest = 1) and averaged with equal weight.";

/** Start of 15-minute day-ahead trading; before, quarter-hours repeat the hourly price. */
const QUARTER_HOUR_AUCTION_START = Date.parse("2025-09-30T22:00:00Z");

export const CRITERIA = ["balanced", "price", "green"] as const;
type Criterion = (typeof CRITERIA)[number];
type Resolution = "hour" | "quarterhour";

const STEP_MS: Record<Resolution, number> = { hour: HOUR, quarterhour: HOUR / 4 };

export interface Row {
  timestamp: number;
  price: number | null;
  green: number | null;
}

export interface Window {
  start: number;
  end: number;
  price: number | null;
  green: number | null;
}

/** All runs of `length` consecutive intervals (DST-safe: consecutive in real time). */
export function windowsOf(rows: readonly Row[], length: number, stepMs = HOUR): Row[][] {
  const out: Row[][] = [];
  for (let i = 0; i + length <= rows.length; i++) {
    const run = rows.slice(i, i + length);
    if (run.every((r, j) => j === 0 || r.timestamp - run[j - 1]!.timestamp === stepMs)) out.push(run);
  }
  return out;
}

/**
 * Score per interval for a criterion, higher is better; null where data is
 * missing. "balanced" scales price and green share each to 0..1 over the
 * intervals of the day (min-max: cheapest and greenest get 1) and weighs
 * them equally, so neither unit (EUR/MWh vs. %) dominates.
 */
export function scores(rows: readonly Row[], criterion: Criterion): (number | null)[] {
  if (criterion === "price") return rows.map((r) => (r.price === null ? null : -r.price));
  if (criterion === "green") return rows.map((r) => r.green);
  const both = rows.filter((r) => r.price !== null && r.green !== null);
  if (both.length === 0) return rows.map(() => null);
  const prices = both.map((r) => r.price!);
  const greens = both.map((r) => r.green!);
  const scale = (v: number, lo: number, hi: number) => (hi === lo ? 0.5 : (v - lo) / (hi - lo));
  const [pMin, pMax, gMin, gMax] = [Math.min(...prices), Math.max(...prices), Math.min(...greens), Math.max(...greens)];
  return rows.map((r) =>
    r.price === null || r.green === null ? null : 0.5 * (1 - scale(r.price, pMin, pMax)) + 0.5 * scale(r.green, gMin, gMax),
  );
}

/** Best and worst window for a criterion; the earliest wins on ties. */
export function rankWindows(rows: readonly Row[], length: number, criterion: Criterion, stepMs = HOUR): { best: Window; worst: Window } | null {
  const s = scores(rows, criterion);
  const indexOf = new Map(rows.map((r, i) => [r.timestamp, i]));
  let best: { score: number; run: Row[] } | null = null;
  let worst: { score: number; run: Row[] } | null = null;
  for (const run of windowsOf(rows, length, stepMs)) {
    const values = run.map((r) => s[indexOf.get(r.timestamp)!]!);
    if (values.some((v) => v === null)) continue;
    const score = mean(values as number[])!;
    if (!best || score > best.score) best = { score, run };
    if (!worst || score < worst.score) worst = { score, run };
  }
  if (!best || !worst) return null;
  return { best: describe(best.run, stepMs), worst: describe(worst.run, stepMs) };
}

function describe(run: Row[], stepMs: number): Window {
  const prices = run.map((r) => r.price);
  const greens = run.map((r) => r.green);
  return {
    start: run[0]!.timestamp,
    end: run[run.length - 1]!.timestamp + stepMs,
    price: prices.includes(null) ? null : mean(prices as number[]),
    green: greens.includes(null) ? null : mean(greens as number[]),
  };
}

/** Values of one series by timestamp; null if SMARD does not offer the series for the region. */
export async function valuesByTime(client: SmardClient, key: string, region: Region, resolution: Resolution, from: number, to: number) {
  const info = findSeries(key)!;
  try {
    const points = await client.getRange(info.filter, region, resolution, from, to);
    return new Map(points.map((p) => [p.timestamp, p.value]));
  } catch (err) {
    if (err instanceof SmardError && err.status === 404) return null;
    throw err;
  }
}

/**
 * Adds up several series per timestamp. A series SMARD does not offer for
 * the region (null, e.g. offshore wind in Amprion) counts as 0; a gap in an
 * offered series leaves the timestamp out.
 */
function addUp(parts: (Map<number, number> | null)[]): Map<number, number> | null {
  const offered = parts.filter((p): p is Map<number, number> => p !== null);
  const [first, ...rest] = offered;
  if (!first) return null;
  const out = new Map<number, number>();
  for (const [t, v] of first) {
    let total = v;
    let ok = true;
    for (const p of rest) {
      const x = p.get(t);
      if (x === undefined) ok = false;
      else total += x;
    }
    if (ok) out.set(t, total);
  }
  return out;
}

/** Where the green share comes from: measured values, or which forecast. */
export type GreenSource = "actual" | "day_ahead" | "intraday";

/**
 * Prefers the intraday forecast per interval and falls back to day-ahead
 * where the intraday value is missing.
 */
export function preferIntraday(intraday: Map<number, number> | null, dayAhead: Map<number, number> | null) {
  const merged = new Map(dayAhead ?? []);
  let fromIntraday = 0;
  for (const [t, v] of intraday ?? []) {
    merged.set(t, v);
    fromIntraday++;
  }
  return { values: merged, fromIntraday };
}

/**
 * Rows (price DE-LU, green share of `region`) for [from, to). The green
 * share uses actual values for past days, the day-ahead forecast for future
 * days and, for today, the intraday forecast (updated during the day) with
 * day-ahead as fallback.
 */
export async function loadRows(
  client: SmardClient,
  from: number,
  to: number,
  source: GreenSource,
  resolution: Resolution = "hour",
  region: Region = "DE",
): Promise<{ rows: Row[]; intradayIntervals: number }> {
  const get = (key: string, r: Region = region) => valuesByTime(client, key, r, resolution, from, to);

  async function windAndSolar(): Promise<{ values: Map<number, number> | null; intradayIntervals: number }> {
    if (source === "actual") {
      const parts = await Promise.all(["generation_wind_onshore", "generation_wind_offshore", "generation_solar"].map((k) => get(k)));
      return { values: addUp(parts), intradayIntervals: 0 };
    }
    if (source === "intraday") {
      const [intraday, dayAhead] = await Promise.all([get("forecast_intraday_wind_and_solar"), get("forecast_generation_wind_and_solar")]);
      const merged = preferIntraday(intraday, dayAhead);
      return { values: merged.values, intradayIntervals: merged.fromIntraday };
    }
    return { values: await get("forecast_generation_wind_and_solar"), intradayIntervals: 0 };
  }

  // Prices are the same for every region; SMARD's hourly price is the mean of the four quarter-hours.
  const [price, windSolar, load] = await Promise.all([
    get("price_de_lu", "DE"),
    windAndSolar(),
    get(source === "actual" ? "consumption_total" : "forecast_consumption_total"),
  ]);
  const rows: Row[] = [];
  for (let t = from; t < to; t += STEP_MS[resolution]) {
    const w = windSolar.values?.get(t);
    const l = load?.get(t);
    rows.push({ timestamp: t, price: price?.get(t) ?? null, green: w !== undefined && l ? (100 * w) / l : null });
  }
  const intradayIntervals = windSolar.intradayIntervals;
  return { rows, intradayIntervals };
}

const windowSchema = z.object({
  start: z.string(),
  end: z.string().describe("Exclusive"),
  average_price_eur_mwh: z.number().nullable(),
  average_green_share_pct: z.number().nullable(),
});

const outputShape = {
  ...commonFields,
  date: z.string(),
  region: z.string().describe("Region of the green share"),
  bidding_zone: z.literal("DE-LU").describe("Prices always refer to the DE-LU bidding zone"),
  resolution: z.enum(["hour", "quarterhour"]),
  from: z.string().describe("First interval considered"),
  to: z.string().describe("End of the intervals considered (exclusive)"),
  duration_hours: z.number(),
  optimize: z.enum(CRITERIA),
  recommended: windowSchema.nullable().describe("Best window for the chosen criterion"),
  best: z.object({ price: windowSchema.nullable(), green: windowSchema.nullable(), balanced: windowSchema.nullable() }),
  worst: windowSchema.nullable().describe("Worst window for the chosen criterion, for comparison"),
  intervals: z
    .array(z.object({ time: z.string(), price_eur_mwh: z.number().nullable(), green_share_pct: z.number().nullable() }))
    .describe("Table per interval (hour or quarter-hour)"),
  missing: z.array(z.string()).describe("Data that is not available (yet)"),
  notes: z.array(z.string()),
  source: z.string(),
};

type Result = z.infer<z.ZodObject<typeof outputShape>>;

function windowOut(w: Window | null | undefined): z.infer<typeof windowSchema> | null {
  if (!w) return null;
  return {
    start: formatBerlin(w.start),
    end: formatBerlin(w.end),
    average_price_eur_mwh: w.price === null ? null : round2(w.price) + 0,
    average_green_share_pct: w.green === null ? null : round1(w.green),
  };
}

export function registerBestHours(server: McpServer, client: SmardClient): void {
  server.registerTool(
    "find_best_hours",
    {
      title: "Best hours to use electricity",
      description:
        "Finds the best contiguous time window of a day to use electricity: cheapest (day-ahead price DE-LU), greenest (highest share of wind and solar in consumption) or balanced. " +
        "Use it for appliances with a fixed run time and questions like 'When is power cheapest today?', 'When should I run the washing machine or heat pump?'. " +
        "For charging an electric car or battery between plug-in and departure (kWh, kW, over midnight, savings in euros) use plan_charging. " +
        "Returns the best window per criterion with average price and green share, the worst window for comparison and a table per interval. " +
        "balanced weighs price and green share equally after scaling each to 0..1 over the intervals of the day (cheapest = 1, greenest = 1). " +
        "Without date: tomorrow if the day-ahead prices are already published (after the auction around noon), else the rest of today; intervals that have already started are left out. " +
        "resolution quarterhour searches in 15-minute steps (15-minute prices exist since 1 Oct 2025). " +
        "region only changes the green share; the price is always that of the DE-LU bidding zone. " +
        "Wholesale prices: for households directly relevant only with a dynamic tariff.",
      inputSchema: {
        date: z.string().optional().describe("Day as YYYY-MM-DD. Default: tomorrow if prices are published, else the rest of today."),
        duration_hours: z.number().int().min(1).max(12).default(3).describe("Length of the window in hours."),
        optimize: z.enum(CRITERIA).default("balanced").describe("price = cheapest, green = most wind and solar, balanced = both equally."),
        resolution: z.enum(["hour", "quarterhour"]).default("hour").describe("Step of the search: whole hours or 15 minutes."),
        region: z.enum(MIX_REGIONS).default("DE").describe("Region for the green share (DE or a TSO zone). The price stays DE-LU."),
      },
      outputSchema: outputShape,
      annotations: { title: "Best hours to use electricity", ...READ_ONLY_REMOTE },
    },
    async ({ date, duration_hours, optimize, resolution, region }) =>
      guarded(async () => {
        const now = Date.now();
        const step = STEP_MS[resolution];
        const today = berlinDayFloor(now);
        const tomorrow = nextIntervalStart(today, "day");
        const notes: string[] = [];
        let dayStart: number;
        if (date) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new InputError("date must be YYYY-MM-DD.");
          try {
            dayStart = parseTime(date);
          } catch (err) {
            throw new InputError((err as Error).message);
          }
        } else {
          const tomorrowPrices = await valuesByTime(client, "price_de_lu", "DE", "hour", tomorrow, nextIntervalStart(tomorrow, "day"));
          dayStart = tomorrowPrices && tomorrowPrices.size > 0 ? tomorrow : today;
          if (dayStart === today) {
            notes.push("Day-ahead prices for tomorrow are not published yet (the auction results come out around noon), so the rest of today is shown.");
          }
        }
        const dayEnd = nextIntervalStart(dayStart, "day");
        // Today: leave out intervals that have already started.
        const from = dayStart === today ? Math.max(dayStart, Math.floor(now / step) * step + step) : dayStart;
        if (from >= dayEnd) throw new InputError("No intervals left today. Ask for tomorrow (date) instead.");
        const length = (duration_hours * HOUR) / step;
        const available = (dayEnd - from) / step;
        if (available < length) {
          throw new InputError(`Only ${fmt1((dayEnd - from) / HOUR)} hours are left in this day; choose a shorter duration_hours.`);
        }

        const source: GreenSource = dayStart < today ? "actual" : dayStart === today ? "intraday" : "day_ahead";
        const { rows, intradayIntervals } = await loadRows(client, from, dayEnd, source, resolution, region);
        const missing: string[] = [];
        const unit = resolution === "hour" ? "hours" : "quarter-hours";
        const missingPrices = rows.filter((r) => r.price === null).length;
        const missingGreen = rows.filter((r) => r.green === null).length;
        const label = dayStart >= today ? "forecasts of wind/solar generation or consumption" : "wind/solar generation or consumption values";
        if (missingPrices === rows.length) missing.push("Day-ahead prices for this day are not available (yet); they are published after the auction around noon of the previous day.");
        else if (missingPrices > 0) missing.push(`Day-ahead prices are missing for ${missingPrices} of ${rows.length} ${unit}.`);
        if (missingGreen === rows.length) missing.push(`The ${label} for this day are not available (yet).`);
        else if (missingGreen > 0) missing.push(`The ${label} are missing for ${missingGreen} of ${rows.length} ${unit}.`);

        const ranked = Object.fromEntries(CRITERIA.map((c) => [c, rankWindows(rows, length, c, step)])) as Record<Criterion, ReturnType<typeof rankWindows>>;
        let chosen: Criterion = optimize;
        if (!ranked[optimize]) {
          const fallback = CRITERIA.find((c) => ranked[c]);
          if (!fallback) throw new InputError(`No window can be computed: ${missing.join(" ")}`);
          notes.push(`"${optimize}" cannot be computed with the available data, so "${fallback}" is recommended instead.`);
          chosen = fallback;
        }
        if (resolution === "quarterhour" && from < QUARTER_HOUR_AUCTION_START) {
          notes.push("Before 1 Oct 2025 the day-ahead auction was hourly; quarter-hour prices of that time repeat the hourly price.");
        }
        if (region !== "DE") notes.push(`The green share refers to ${region}; prices are those of the DE-LU bidding zone (there are no regional prices).`);
        if (source === "intraday") {
          notes.push(
            intradayIntervals > 0
              ? "Green share for today uses SMARD's intraday forecast (updated during the day), with the day-ahead forecast where it is missing."
              : "No intraday forecast is available yet, so the green share uses the day-ahead forecast.",
          );
        }
        notes.push(GREEN_DEFINITION, BALANCED_DEFINITION, WHOLESALE_NOTE);

        const result: Result = {
          date: formatBerlin(dayStart).slice(0, 10),
          region,
          bidding_zone: "DE-LU",
          resolution,
          from: formatBerlin(from),
          to: formatBerlin(dayEnd),
          duration_hours,
          optimize: chosen,
          recommended: windowOut(ranked[chosen]?.best),
          best: { price: windowOut(ranked.price?.best), green: windowOut(ranked.green?.best), balanced: windowOut(ranked.balanced?.best) },
          worst: windowOut(ranked[chosen]?.worst),
          intervals: rows.map((r) => ({
            time: formatBerlin(r.timestamp),
            price_eur_mwh: r.price === null ? null : round2(r.price) + 0,
            green_share_pct: r.green === null ? null : round1(r.green),
          })),
          missing,
          notes,
          source: ATTRIBUTION,
        };
        return toolResult(bestHoursText(result, rows), result);
      }),
  );
}

/** Hourly means of the rows, for a compact text table also at quarter-hour resolution. */
function hourlyTable(rows: readonly Row[]): Row[] {
  const byHour = new Map<number, Row[]>();
  for (const r of rows) {
    const h = Math.floor(r.timestamp / HOUR) * HOUR;
    const list = byHour.get(h);
    if (list) list.push(r);
    else byHour.set(h, [r]);
  }
  const avg = (vals: (number | null)[]) => (vals.includes(null) ? null : mean(vals as number[]));
  return [...byHour].map(([timestamp, rs]) => ({ timestamp, price: avg(rs.map((r) => r.price)), green: avg(rs.map((r) => r.green)) }));
}

function bestHoursText(r: Result, rows: readonly Row[]): string {
  const hhmm = (iso: string) => iso.slice(11, 16);
  // The window/day end at midnight of the next day reads better as 24:00.
  const end = (iso: string) => (iso.slice(0, 10) !== r.date && iso.slice(11, 16) === "00:00" ? "24:00" : hhmm(iso));
  const win = (w: Result["recommended"]) =>
    w
      ? `${hhmm(w.start)} to ${end(w.end)}: ${w.average_price_eur_mwh === null ? "price n/a" : `${w.average_price_eur_mwh.toFixed(2)} EUR/MWh`}, green ${w.average_green_share_pct === null ? "n/a" : `${fmt1(w.average_green_share_pct)} %`}`
      : "n/a";
  const lines = [
    `Best ${r.duration_hours}-hour window on ${r.date} (${r.resolution === "hour" ? "hourly" : "15-minute"} steps, ${hhmm(r.from)} to ${end(r.to)}, green share for ${r.region}, price DE-LU, optimized for ${r.optimize}):`,
    `Recommended: ${win(r.recommended)}.`,
    `Cheapest: ${win(r.best.price)}. Greenest: ${win(r.best.green)}. Balanced: ${win(r.best.balanced)}.`,
    `Worst window for comparison: ${win(r.worst)}.`,
    r.resolution === "hour" ? "Hour | EUR/MWh | green %" : "Hour (mean of the quarter-hours) | EUR/MWh | green %",
    ...hourlyTable(rows).map(
      (h) => `${formatBerlin(h.timestamp).slice(11, 16)} | ${h.price === null ? "n/a" : h.price.toFixed(2)} | ${h.green === null ? "n/a" : fmt1(h.green)}`,
    ),
  ];
  for (const m of r.missing) lines.push(`Missing: ${m}`);
  for (const n of r.notes) lines.push(`Note: ${n}`);
  lines.push(`Source: ${r.source}`);
  return lines.join("\n");
}
