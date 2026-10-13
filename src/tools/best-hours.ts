/** find_best_hours: cheapest / greenest contiguous time window of a day. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HOUR, mean } from "../analysis.js";
import { ATTRIBUTION, findSeries } from "../catalog.js";
import { SmardError, type DataPoint, type SmardClient } from "../smard.js";
import { berlinDayFloor, formatBerlin, nextIntervalStart, parseTime } from "../time.js";
import { InputError, READ_ONLY_REMOTE, fmt1, guarded, round1, round2, toolResult } from "./common.js";

const WHOLESALE_NOTE =
  "Prices are day-ahead wholesale prices (DE-LU) without taxes, levies and grid fees; for households they matter directly only with a dynamic electricity tariff.";
const GREEN_DEFINITION = "Green share = wind + solar generation in % of consumption (forecasts for today and later, actual values for past days).";

export const CRITERIA = ["balanced", "price", "green"] as const;
type Criterion = (typeof CRITERIA)[number];

export interface HourRow {
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

/** All runs of `duration` consecutive hours (DST-safe: consecutive in real time). */
export function windowsOf(rows: readonly HourRow[], duration: number): HourRow[][] {
  const out: HourRow[][] = [];
  for (let i = 0; i + duration <= rows.length; i++) {
    const run = rows.slice(i, i + duration);
    if (run.every((r, j) => j === 0 || r.timestamp - run[j - 1]!.timestamp === HOUR)) out.push(run);
  }
  return out;
}

/**
 * Score per hour for a criterion, higher is better; null where data is
 * missing. "balanced" weighs price and green share equally after scaling
 * both to 0..1 over the hours of the day.
 */
export function hourScores(rows: readonly HourRow[], criterion: Criterion): (number | null)[] {
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

/** Best and worst window for a criterion; earliest wins on ties. */
export function rankWindows(rows: readonly HourRow[], duration: number, criterion: Criterion): { best: Window; worst: Window } | null {
  const scores = hourScores(rows, criterion);
  const indexOf = new Map(rows.map((r, i) => [r.timestamp, i]));
  let best: { score: number; run: HourRow[] } | null = null;
  let worst: { score: number; run: HourRow[] } | null = null;
  for (const run of windowsOf(rows, duration)) {
    const s = run.map((r) => scores[indexOf.get(r.timestamp)!]!);
    if (s.some((v) => v === null)) continue;
    const score = mean(s as number[])!;
    if (!best || score > best.score) best = { score, run };
    if (!worst || score < worst.score) worst = { score, run };
  }
  if (!best || !worst) return null;
  return { best: describe(best.run), worst: describe(worst.run) };
}

function describe(run: HourRow[]): Window {
  const prices = run.map((r) => r.price);
  const greens = run.map((r) => r.green);
  return {
    start: run[0]!.timestamp,
    end: run[run.length - 1]!.timestamp + HOUR,
    price: prices.includes(null) ? null : mean(prices as number[]),
    green: greens.includes(null) ? null : mean(greens as number[]),
  };
}

async function series(client: SmardClient, key: string, from: number, to: number): Promise<Map<number, number>> {
  const info = findSeries(key)!;
  try {
    const points: DataPoint[] = await client.getRange(info.filter, "DE", "hour", from, to);
    return new Map(points.map((p) => [p.timestamp, p.value]));
  } catch (err) {
    if (err instanceof SmardError && err.status === 404) return new Map();
    throw err;
  }
}

/** Adds up several series per timestamp; only timestamps present in all of them. */
function addUp(parts: Map<number, number>[]): Map<number, number> {
  const [first, ...rest] = parts;
  const out = new Map<number, number>();
  for (const [t, v] of first ?? []) {
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

/** Hourly rows (price, green share) for [from, to). Forecasts for today and later, actuals before. */
export async function loadHours(client: SmardClient, from: number, to: number, useForecast: boolean): Promise<HourRow[]> {
  // SMARD's hourly price is already the mean of the four quarter-hour prices.
  const [price, windSolar, load] = await Promise.all([
    series(client, "price_de_lu", from, to),
    useForecast
      ? series(client, "forecast_generation_wind_and_solar", from, to)
      : Promise.all(["generation_wind_onshore", "generation_wind_offshore", "generation_solar"].map((k) => series(client, k, from, to))).then(addUp),
    series(client, useForecast ? "forecast_consumption_total" : "consumption_total", from, to),
  ]);
  const rows: HourRow[] = [];
  for (let t = from; t < to; t += HOUR) {
    const ws = windSolar.get(t);
    const l = load.get(t);
    rows.push({ timestamp: t, price: price.get(t) ?? null, green: ws !== undefined && l ? (100 * ws) / l : null });
  }
  return rows;
}

const windowSchema = z.object({
  start: z.string(),
  end: z.string().describe("Exclusive"),
  average_price_eur_mwh: z.number().nullable(),
  average_green_share_pct: z.number().nullable(),
});

const outputShape = {
  date: z.string(),
  from: z.string().describe("First hour considered"),
  to: z.string().describe("End of the hours considered (exclusive)"),
  duration_hours: z.number(),
  optimize: z.enum(CRITERIA),
  recommended: windowSchema.nullable().describe("Best window for the chosen criterion"),
  best: z.object({ price: windowSchema.nullable(), green: windowSchema.nullable(), balanced: windowSchema.nullable() }),
  worst: windowSchema.nullable().describe("Worst window for the chosen criterion, for comparison"),
  hours: z.array(z.object({ time: z.string(), price_eur_mwh: z.number().nullable(), green_share_pct: z.number().nullable() })),
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
        "Use it for questions like 'When should I charge my electric car tomorrow?', 'When is power cheapest today?', 'When should I run the washing machine or heat pump?'. " +
        "Returns the best window per criterion with average price and green share, the worst window for comparison and a compact hourly table. " +
        "Without date: tomorrow if the day-ahead prices are already published (after the auction around noon), else the rest of today. " +
        "Wholesale prices: for households directly relevant only with a dynamic tariff.",
      inputSchema: {
        date: z.string().optional().describe("Day as YYYY-MM-DD. Default: tomorrow if prices are published, else the rest of today."),
        duration_hours: z.number().int().min(1).max(12).default(3).describe("Length of the window in hours."),
        optimize: z.enum(CRITERIA).default("balanced").describe("price = cheapest, green = most wind and solar, balanced = both equally."),
      },
      outputSchema: outputShape,
      annotations: { title: "Best hours to use electricity", ...READ_ONLY_REMOTE },
    },
    async ({ date, duration_hours, optimize }) =>
      guarded(async () => {
        const now = Date.now();
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
          const tomorrowPrices = await series(client, "price_de_lu", tomorrow, nextIntervalStart(tomorrow, "day"));
          dayStart = tomorrowPrices.size > 0 ? tomorrow : today;
          if (dayStart === today) {
            notes.push("Day-ahead prices for tomorrow are not published yet (the auction results come out around noon), so the rest of today is shown.");
          }
        }
        const dayEnd = nextIntervalStart(dayStart, "day");
        // Today: only hours that have not started yet.
        const from = dayStart === today ? Math.max(dayStart, Math.floor(now / HOUR) * HOUR + HOUR) : dayStart;
        if (from >= dayEnd) throw new InputError("No hours left today. Ask for tomorrow (date) instead.");
        if ((dayEnd - from) / HOUR < duration_hours) {
          throw new InputError(`Only ${(dayEnd - from) / HOUR} hours are left in this day; choose a shorter duration_hours.`);
        }

        const rows = await loadHours(client, from, dayEnd, dayStart >= today);
        const missing: string[] = [];
        const missingPrices = rows.filter((r) => r.price === null).length;
        const missingGreen = rows.filter((r) => r.green === null).length;
        const label = dayStart >= today ? "forecasts of wind/solar generation or consumption" : "wind/solar generation or consumption values";
        if (missingPrices === rows.length) missing.push("Day-ahead prices for this day are not available (yet); they are published after the auction around noon of the previous day.");
        else if (missingPrices > 0) missing.push(`Day-ahead prices are missing for ${missingPrices} of ${rows.length} hours.`);
        if (missingGreen === rows.length) missing.push(`The ${label} for this day are not available (yet).`);
        else if (missingGreen > 0) missing.push(`The ${label} are missing for ${missingGreen} of ${rows.length} hours.`);

        const ranked = Object.fromEntries(CRITERIA.map((c) => [c, rankWindows(rows, duration_hours, c)])) as Record<Criterion, ReturnType<typeof rankWindows>>;
        let chosen: Criterion = optimize;
        if (!ranked[optimize]) {
          const fallback = CRITERIA.find((c) => ranked[c]);
          if (!fallback) throw new InputError(`No window can be computed: ${missing.join(" ")}`);
          notes.push(`"${optimize}" cannot be computed with the available data, so "${fallback}" is recommended instead.`);
          chosen = fallback;
        }
        notes.push(GREEN_DEFINITION, WHOLESALE_NOTE);

        const result: Result = {
          date: formatBerlin(dayStart).slice(0, 10),
          from: formatBerlin(from),
          to: formatBerlin(dayEnd),
          duration_hours,
          optimize: chosen,
          recommended: windowOut(ranked[chosen]?.best),
          best: { price: windowOut(ranked.price?.best), green: windowOut(ranked.green?.best), balanced: windowOut(ranked.balanced?.best) },
          worst: windowOut(ranked[chosen]?.worst),
          hours: rows.map((r) => ({
            time: formatBerlin(r.timestamp),
            price_eur_mwh: r.price === null ? null : round2(r.price) + 0,
            green_share_pct: r.green === null ? null : round1(r.green),
          })),
          missing,
          notes,
          source: ATTRIBUTION,
        };
        return toolResult(bestHoursText(result), result);
      }),
  );
}

function bestHoursText(r: Result): string {
  const hhmm = (iso: string) => iso.slice(11, 16);
  // The window/day end at midnight of the next day reads better as 24:00.
  const end = (iso: string) => (iso.slice(0, 10) !== r.date && iso.slice(11, 16) === "00:00" ? "24:00" : hhmm(iso));
  const win = (w: Result["recommended"]) =>
    w
      ? `${hhmm(w.start)} to ${end(w.end)}: ${w.average_price_eur_mwh === null ? "price n/a" : `${w.average_price_eur_mwh.toFixed(2)} EUR/MWh`}, green ${w.average_green_share_pct === null ? "n/a" : `${fmt1(w.average_green_share_pct)} %`}`
      : "n/a";
  const lines = [
    `Best ${r.duration_hours}-hour window on ${r.date} (hours ${hhmm(r.from)} to ${end(r.to)}, optimized for ${r.optimize}):`,
    `Recommended: ${win(r.recommended)}.`,
    `Cheapest: ${win(r.best.price)}. Greenest: ${win(r.best.green)}. Balanced: ${win(r.best.balanced)}.`,
    `Worst window for comparison: ${win(r.worst)}.`,
    "Hour | EUR/MWh | green %",
    ...r.hours.map((h) => `${hhmm(h.time)} | ${h.price_eur_mwh === null ? "n/a" : h.price_eur_mwh.toFixed(2)} | ${h.green_share_pct === null ? "n/a" : fmt1(h.green_share_pct)}`),
  ];
  for (const m of r.missing) lines.push(`Missing: ${m}`);
  for (const n of r.notes) lines.push(`Note: ${n}`);
  lines.push(`Source: ${r.source}`);
  return lines.join("\n");
}
