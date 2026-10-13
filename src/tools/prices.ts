/** analyze_prices: statistics of the DE-LU day-ahead price. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DAY, HOURLY_MAX_RANGE_MS, INTERVAL_MS, PRICE_KEY, fetchAligned, mean, median, newestDataPoint, noDataMessage } from "../analysis.js";
import { ATTRIBUTION, findSeries } from "../catalog.js";
import type { DataPoint, SmardClient } from "../smard.js";
import { formatBerlin } from "../time.js";
import { InputError, READ_ONLY_REMOTE, guarded, round1, round2, toolResult, warningsField } from "./common.js";
import { coverageText } from "./generation-mix.js";
import { parseRange } from "./range.js";

/** Hourly analysis covers up to a year: one series only, at most 54 weekly blocks. */
const HOURLY_PRICE_MAX_RANGE_MS = 366 * DAY;
const MAX_NEGATIVE_LISTED = 48;
/** Length of the reference period before the analysed range. */
const CONTEXT_DAYS = 30;

/** Start of 15-minute day-ahead trading; before, quarter-hours repeat the hourly price. */
const QUARTER_HOUR_AUCTION_START = Date.parse("2025-09-30T22:00:00Z");

const pricePoint = z.object({ time: z.string(), price_eur_mwh: z.number() });
const extremum = pricePoint.extend({
  time: z.string().describe("First interval with this price"),
  count: z.number().describe("Number of intervals with exactly this price"),
});

const outputShape = {
  ...warningsField,
  bidding_zone: z.literal("DE-LU"),
  region: z.literal("DE-LU"),
  from: z.string(),
  to: z.string(),
  resolution: z.enum(["hour", "quarterhour"]),
  covered_until: z.string().nullable().describe("End of the last interval included"),
  complete: z.boolean().describe("True if the data covers the whole requested range"),
  data_until: z.string().nullable().describe("Start of the last interval included (kept for compatibility; prefer covered_until)"),
  count: z.number().describe("Number of intervals with a price"),
  mean_eur_mwh: z.number().nullable(),
  median_eur_mwh: z.number().nullable(),
  min: extremum.nullable(),
  max: extremum.nullable(),
  negative_count: z.number().describe("Intervals with a price below 0"),
  negative_prices: z.array(pricePoint).describe(`Intervals with negative prices, chronological, at most ${MAX_NEGATIVE_LISTED}`),
  negative_list_truncated: z.boolean(),
  all_prices: z.array(pricePoint).optional().describe("All prices, chronological; given instead of cheapest/most_expensive when count <= 2 * top_n"),
  cheapest: z.array(pricePoint).optional().describe("Cheapest intervals, cheapest first"),
  most_expensive: z.array(pricePoint).optional().describe("Most expensive intervals, most expensive first"),
  daily_averages: z.array(z.object({ date: z.string(), mean_eur_mwh: z.number() })),
  context: z
    .object({
      reference_from: z.string(),
      reference_to: z.string(),
      reference_mean_eur_mwh: z.number().describe("Mean over all hours of the reference period"),
      deviation_pct: z.number().nullable().describe("Mean of the period relative to reference_mean_eur_mwh, in %"),
      hours_compared: z.string().describe('Berlin clock hours the period covers, e.g. "17:00 to 20:00" or "all hours"'),
      same_hours_mean_eur_mwh: z.number().nullable().describe("Mean over the same clock hours of the reference period"),
      same_hours_deviation_pct: z
        .number()
        .nullable()
        .describe("Mean of the period relative to same_hours_mean_eur_mwh, in %; the fairer comparison for parts of a day"),
    })
    .nullable()
    .optional()
    .describe(
      `Prices of the ${CONTEXT_DAYS} days before the period, overall and at the same clock hours, to judge whether prices were high or low`,
    ),
  notes: z.array(z.string()),
  source: z.string(),
};

type Result = z.infer<z.ZodObject<typeof outputShape>>;

/** Prices have a resolution of 0.01 EUR/MWh, so they keep two decimals. */
function price(n: number): number {
  return round2(n) + 0;
}

function point(p: DataPoint) {
  return { time: formatBerlin(p.timestamp), price_eur_mwh: price(p.value) };
}

/** First interval with the given extreme value plus how often it occurs. */
function extremeOf(points: readonly DataPoint[], value: number | undefined) {
  if (value === undefined) return null;
  const hits = points.filter((p) => p.value === value);
  return { ...point(hits[0]!), count: hits.length };
}

/** Pure statistics over price points (ascending by time). */
export function priceStats(points: readonly DataPoint[], topN: number) {
  const values = points.map((p) => p.value);
  // Stable sorts keep chronological order among equal prices.
  const ascending = [...points].sort((a, b) => a.value - b.value);
  const descending = [...points].sort((a, b) => b.value - a.value);
  const negatives = points.filter((p) => p.value < 0);

  const byDay = new Map<string, number[]>();
  for (const p of points) {
    const date = formatBerlin(p.timestamp).slice(0, 10);
    const list = byDay.get(date);
    if (list) list.push(p.value);
    else byDay.set(date, [p.value]);
  }

  const avg = mean(values);
  const med = median(values);
  // With few values, top and bottom lists would overlap; list everything instead.
  const listAll = points.length <= 2 * topN;
  return {
    count: points.length,
    mean_eur_mwh: avg === null ? null : price(avg),
    median_eur_mwh: med === null ? null : price(med),
    min: extremeOf(points, ascending[0]?.value),
    max: extremeOf(points, descending[0]?.value),
    negative_count: negatives.length,
    negative_prices: negatives.slice(0, MAX_NEGATIVE_LISTED).map(point),
    negative_list_truncated: negatives.length > MAX_NEGATIVE_LISTED,
    ...(listAll
      ? { all_prices: points.map(point) }
      : { cheapest: ascending.slice(0, topN).map(point), most_expensive: descending.slice(0, topN).map(point) }),
    daily_averages: [...byDay].map(([date, v]) => ({ date, mean_eur_mwh: price(mean(v)!) })),
  };
}

/** Berlin clock hour ("00" to "23") of a timestamp. */
function clockHour(timestamp: number): string {
  return formatBerlin(timestamp).slice(11, 13);
}

/** "17:00 to 20:00", "06:00 to 08:00, 17:00 to 19:00" or "all hours". */
export function hoursLabel(hours: ReadonlySet<string>): string {
  if (hours.size >= 24) return "all hours";
  const sorted = [...hours].map(Number).sort((a, b) => a - b);
  const runs: [number, number][] = [];
  for (const h of sorted) {
    const last = runs[runs.length - 1];
    if (last && h === last[1] + 1) last[1] = h;
    else runs.push([h, h]);
  }
  const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;
  return runs.map(([a, b]) => `${hh(a)} to ${hh(b + 1)}`).join(", ");
}

/**
 * Mean hourly price of the CONTEXT_DAYS days before `from`, overall and at
 * the given clock hours only. A period of a few evening hours is thereby
 * compared with evenings, not with the whole day.
 */
async function referenceMean(
  client: SmardClient,
  from: number,
  hours: ReadonlySet<string>,
): Promise<{ from: number; to: number; mean: number; sameHoursMean: number | null } | null> {
  const info = findSeries(PRICE_KEY)!;
  const refFrom = from - CONTEXT_DAYS * DAY;
  const points = await client.getRange(info.filter, "DE", "hour", refFrom, from, { maxBlocks: 8 });
  const avg = mean(points.map((p) => p.value));
  if (avg === null) return null;
  const same = mean(points.filter((p) => hours.has(clockHour(p.timestamp))).map((p) => p.value));
  return { from: refFrom, to: from, mean: avg, sameHoursMean: same };
}

export function registerAnalyzePrices(server: McpServer, client: SmardClient): void {
  server.registerTool(
    "analyze_prices",
    {
      title: "Analyze day-ahead prices",
      description:
        "Statistics of the day-ahead price of the DE-LU bidding zone for a period: mean, median, min/max with time and number of ties, " +
        `count and list of intervals with negative prices (at most ${MAX_NEGATIVE_LISTED} listed), the N cheapest and most expensive intervals ` +
        "(or all prices if there are at most 2N), daily averages, and as context the mean of the 30 days before with the deviation in %, " +
        "also at the same clock hours (for parts of a day, e.g. evenings, compare with same_hours_deviation_pct). " +
        "Prices in EUR/MWh with two decimals. " +
        "Resolution hour (up to 1 year) or quarterhour (up to 8 weeks; 15-minute prices exist since 1 Oct 2025). " +
        "Prices for tomorrow are available after the day-ahead auction around noon. Without from/to: yesterday.",
      inputSchema: {
        from: z.string().optional().describe("Start (inclusive), YYYY-MM-DD or ISO 8601 date-time (Berlin time if no offset). Default: yesterday."),
        to: z.string().optional().describe("End (exclusive); a plain YYYY-MM-DD includes that day. Default: end of the from day."),
        resolution: z.enum(["hour", "quarterhour"]).default("hour"),
        top_n: z.number().int().min(1).max(48).default(5).describe("How many cheapest and most expensive intervals to list."),
        context: z.boolean().default(true).describe(`Compare with the mean of the ${CONTEXT_DAYS} days before the period.`),
      },
      outputSchema: outputShape,
      annotations: { title: "Analyze day-ahead prices", ...READ_ONLY_REMOTE },
    },
    async ({ from, to, resolution, top_n, context }) =>
      guarded(async () => {
        const range = parseRange(from, to);
        const result = await analyzePrices(client, range.from, range.to, resolution, top_n, context);
        return toolResult(pricesText(result, INTERVAL_MS[resolution] === 3_600_000 ? "hours" : "quarter-hours"), result);
      }),
  );
}

export type PriceAnalysis = Result;

/**
 * The whole analysis behind analyze_prices, reusable by other tools.
 * Throws InputError for ranges that are too long or without data.
 */
export async function analyzePrices(
  client: SmardClient,
  from: number,
  to: number,
  resolution: "hour" | "quarterhour",
  topN: number,
  context: boolean,
): Promise<PriceAnalysis> {
  const limit = resolution === "hour" ? HOURLY_PRICE_MAX_RANGE_MS : HOURLY_MAX_RANGE_MS;
  if (to - from > limit) {
    throw new InputError(
      resolution === "hour"
        ? "analyze_prices covers at most 366 days with hourly prices. Split the range or use compare_periods for long-term averages."
        : "Quarter-hour prices are limited to 8 weeks. Use resolution hour for longer ranges.",
    );
  }
  const data = await fetchAligned(client, [PRICE_KEY], "DE", from, to, resolution, Date.now(), 56);
  const points = data.series[0]?.points ?? [];
  if (points.length === 0) {
    throw new InputError(noDataMessage(await newestDataPoint(client, PRICE_KEY, "DE", resolution), resolution));
  }
  const notes = [...data.notes];
  if (resolution === "quarterhour" && from < QUARTER_HOUR_AUCTION_START) {
    notes.push("Before 1 Oct 2025 the day-ahead auction was hourly; quarter-hour values in that part repeat the hourly price.");
  }

  const stats = priceStats(points, topN);
  let contextResult: Result["context"];
  if (context) {
    const hours = new Set(points.map((p) => clockHour(p.timestamp)));
    const ref = await referenceMean(client, data.from, hours);
    if (ref === null) notes.push(`No prices for the ${CONTEXT_DAYS} days before the period, so there is no comparison.`);
    const periodMean = mean(points.map((p) => p.value))!;
    const deviation = (reference: number | null) =>
      reference === null || reference === 0 ? null : round1((100 * (periodMean - reference)) / Math.abs(reference)) + 0;
    contextResult =
      ref === null
        ? null
        : {
            reference_from: formatBerlin(ref.from),
            reference_to: formatBerlin(ref.to),
            reference_mean_eur_mwh: price(ref.mean),
            deviation_pct: deviation(ref.mean),
            hours_compared: hoursLabel(hours),
            same_hours_mean_eur_mwh: ref.sameHoursMean === null ? null : price(ref.sameHoursMean),
            same_hours_deviation_pct: deviation(ref.sameHoursMean),
          };
  }

  return {
    bidding_zone: "DE-LU",
    region: "DE-LU",
    from: formatBerlin(data.from),
    to: formatBerlin(data.to),
    resolution,
    covered_until: data.coveredUntil === null ? null : formatBerlin(data.coveredUntil),
    complete: data.complete,
    data_until: data.dataUntil === null ? null : formatBerlin(data.dataUntil),
    ...stats,
    ...(context ? { context: contextResult } : {}),
    notes,
    source: ATTRIBUTION,
  };
}

function pricesText(r: Result, unit: string): string {
  const eur = (n: number | null) => (n === null ? "n/a" : `${n.toFixed(2)} EUR/MWh`);
  const list = (ps: { time: string; price_eur_mwh: number }[]) => ps.map((p) => `${p.time} (${p.price_eur_mwh.toFixed(2)})`).join(", ");
  const ext = (e: Result["min"]) => {
    if (!e) return "n/a";
    return e.count > 1 ? `${eur(e.price_eur_mwh)} (${e.count} ${unit}, first at ${e.time})` : `${eur(e.price_eur_mwh)} at ${e.time}`;
  };
  const lines = [
    `Day-ahead prices DE-LU, ${r.from} to ${r.to} (${r.resolution} values, ${coverageText(r)}):`,
    `Mean ${eur(r.mean_eur_mwh)}, median ${eur(r.median_eur_mwh)}, ${r.count} ${unit}.`,
    `Min ${ext(r.min)}; max ${ext(r.max)}.`,
    `Negative prices in ${r.negative_count} ${unit}.`,
  ];
  if (r.context) {
    const c = r.context;
    const pct = (d: number | null) => (d === null ? "n/a" : `${d > 0 ? "+" : ""}${d.toFixed(1)} %`);
    lines.push(
      c.hours_compared === "all hours"
        ? `Context: mean of the ${CONTEXT_DAYS} days before was ${eur(c.reference_mean_eur_mwh)}; this period is ${pct(c.deviation_pct)} compared with it.`
        : `Context: at the same hours (${c.hours_compared}) the ${CONTEXT_DAYS} days before averaged ${eur(c.same_hours_mean_eur_mwh)}; this period is ${pct(c.same_hours_deviation_pct)} compared with it (all hours: ${eur(c.reference_mean_eur_mwh)}, ${pct(c.deviation_pct)}).`,
    );
  }
  if (r.all_prices) {
    lines.push(`All prices: ${list(r.all_prices)}.`);
  } else {
    lines.push(`Cheapest: ${list(r.cheapest ?? [])}.`);
    lines.push(`Most expensive: ${list(r.most_expensive ?? [])}.`);
  }
  if (r.daily_averages.length > 1 && r.daily_averages.length <= 31) {
    lines.push(`Daily means: ${r.daily_averages.map((d) => `${d.date} ${d.mean_eur_mwh.toFixed(2)}`).join(", ")}.`);
  } else if (r.daily_averages.length > 31) {
    lines.push(`Daily means for ${r.daily_averages.length} days are in the structured result.`);
  }
  for (const n of r.notes) lines.push(`Note: ${n}`);
  lines.push(`Source: ${r.source}`);
  return lines.join("\n");
}
