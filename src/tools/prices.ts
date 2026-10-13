/** analyze_prices: statistics of the DE-LU day-ahead price. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DAY, HOURLY_MAX_RANGE_MS, INTERVAL_MS, PRICE_KEY, fetchAligned, mean, median } from "../analysis.js";
import { ATTRIBUTION } from "../catalog.js";
import type { DataPoint, SmardClient } from "../smard.js";
import { formatBerlin } from "../time.js";
import { InputError, READ_ONLY_REMOTE, fmt1, guarded, round1, toolResult } from "./common.js";
import { parseRange } from "./range.js";

/** Hourly analysis covers up to a year: one series only, at most 54 weekly blocks. */
const HOURLY_PRICE_MAX_RANGE_MS = 366 * DAY;
const MAX_NEGATIVE_LISTED = 48;

/** Start of 15-minute day-ahead trading; before, quarter-hours repeat the hourly price. */
const QUARTER_HOUR_AUCTION_START = Date.parse("2025-09-30T22:00:00Z");

const pricePoint = z.object({ time: z.string(), price_eur_mwh: z.number() });

const outputShape = {
  bidding_zone: z.literal("DE-LU"),
  region: z.literal("DE-LU"),
  from: z.string(),
  to: z.string(),
  resolution: z.enum(["hour", "quarterhour"]),
  data_until: z.string().nullable().describe("Start of the newest interval included"),
  count: z.number().describe("Number of intervals with a price"),
  mean_eur_mwh: z.number().nullable(),
  median_eur_mwh: z.number().nullable(),
  min: pricePoint.nullable(),
  max: pricePoint.nullable(),
  negative_count: z.number().describe("Intervals with a price below 0"),
  negative_prices: z.array(pricePoint).describe(`Intervals with negative prices, chronological, at most ${MAX_NEGATIVE_LISTED}`),
  negative_list_truncated: z.boolean(),
  cheapest: z.array(pricePoint).describe("Cheapest intervals, cheapest first"),
  most_expensive: z.array(pricePoint).describe("Most expensive intervals, most expensive first"),
  daily_averages: z.array(z.object({ date: z.string(), mean_eur_mwh: z.number() })),
  notes: z.array(z.string()),
  source: z.string(),
};

function point(p: DataPoint) {
  return { time: formatBerlin(p.timestamp), price_eur_mwh: round1(p.value) + 0 };
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
  return {
    count: points.length,
    mean_eur_mwh: avg === null ? null : round1(avg) + 0,
    median_eur_mwh: med === null ? null : round1(med) + 0,
    min: ascending[0] ? point(ascending[0]) : null,
    max: descending[0] ? point(descending[0]) : null,
    negative_count: negatives.length,
    negative_prices: negatives.slice(0, MAX_NEGATIVE_LISTED).map(point),
    negative_list_truncated: negatives.length > MAX_NEGATIVE_LISTED,
    cheapest: ascending.slice(0, topN).map(point),
    most_expensive: descending.slice(0, topN).map(point),
    daily_averages: [...byDay].map(([date, v]) => ({ date, mean_eur_mwh: round1(mean(v)!) + 0 })),
  };
}

export function registerAnalyzePrices(server: McpServer, client: SmardClient): void {
  server.registerTool(
    "analyze_prices",
    {
      title: "Analyze day-ahead prices",
      description:
        "Statistics of the day-ahead price of the DE-LU bidding zone for a period: mean, median, min/max with time, " +
        `count and list of intervals with negative prices (at most ${MAX_NEGATIVE_LISTED} listed), the N cheapest and most expensive intervals and daily averages. ` +
        "Resolution hour (up to 1 year) or quarterhour (up to 8 weeks; 15-minute prices exist since 1 Oct 2025). " +
        "Prices for tomorrow are available after the day-ahead auction around noon. Without from/to: yesterday.",
      inputSchema: {
        from: z.string().optional().describe("Start (inclusive), YYYY-MM-DD or ISO 8601 date-time (Berlin time if no offset). Default: yesterday."),
        to: z.string().optional().describe("End (exclusive); a plain YYYY-MM-DD includes that day. Default: end of the from day."),
        resolution: z.enum(["hour", "quarterhour"]).default("hour"),
        top_n: z.number().int().min(1).max(48).default(5).describe("How many cheapest and most expensive intervals to list."),
      },
      outputSchema: outputShape,
      annotations: { title: "Analyze day-ahead prices", ...READ_ONLY_REMOTE },
    },
    async ({ from, to, resolution, top_n }) =>
      guarded(async () => {
        const range = parseRange(from, to);
        const limit = resolution === "hour" ? HOURLY_PRICE_MAX_RANGE_MS : HOURLY_MAX_RANGE_MS;
        if (range.to - range.from > limit) {
          throw new InputError(
            resolution === "hour"
              ? "analyze_prices covers at most 366 days with hourly prices. Split the range or use compare_periods for long-term averages."
              : "Quarter-hour prices are limited to 8 weeks. Use resolution hour for longer ranges.",
          );
        }
        const data = await fetchAligned(client, [PRICE_KEY], "DE", range.from, range.to, resolution, Date.now(), 56);
        const points = data.series[0]?.points ?? [];
        const notes = [...data.notes];
        if (resolution === "quarterhour" && range.from < QUARTER_HOUR_AUCTION_START) {
          notes.push("Before 1 Oct 2025 the day-ahead auction was hourly; quarter-hour values in that part repeat the hourly price.");
        }

        const result = {
          bidding_zone: "DE-LU" as const,
          region: "DE-LU" as const,
          from: formatBerlin(data.from),
          to: formatBerlin(data.to),
          resolution,
          data_until: data.dataUntil === null ? null : formatBerlin(data.dataUntil),
          ...priceStats(points, top_n),
          notes,
          source: ATTRIBUTION,
        };
        return toolResult(pricesText(result, INTERVAL_MS[resolution] === 3_600_000 ? "hours" : "quarter-hours"), result);
      }),
  );
}

function pricesText(r: ReturnType<typeof priceStats> & { from: string; to: string; resolution: string; data_until: string | null; notes: string[]; source: string }, unit: string): string {
  const eur = (n: number | null) => (n === null ? "n/a" : `${fmt1(n)} EUR/MWh`);
  const at = (p: { time: string; price_eur_mwh: number } | null) => (p ? `${fmt1(p.price_eur_mwh)} EUR/MWh at ${p.time}` : "n/a");
  const lines = [
    `Day-ahead prices DE-LU, ${r.from} to ${r.to} (${r.resolution} values, data until ${r.data_until ?? "n/a"}):`,
    `Mean ${eur(r.mean_eur_mwh)}, median ${eur(r.median_eur_mwh)}, ${r.count} ${unit}.`,
    `Min ${at(r.min)}; max ${at(r.max)}.`,
    `Negative prices in ${r.negative_count} ${unit}.`,
    `Cheapest: ${r.cheapest.map((p) => `${p.time} (${fmt1(p.price_eur_mwh)})`).join(", ") || "n/a"}.`,
    `Most expensive: ${r.most_expensive.map((p) => `${p.time} (${fmt1(p.price_eur_mwh)})`).join(", ") || "n/a"}.`,
  ];
  if (r.daily_averages.length > 1 && r.daily_averages.length <= 31) {
    lines.push(`Daily means: ${r.daily_averages.map((d) => `${d.date} ${fmt1(d.mean_eur_mwh)}`).join(", ")}.`);
  } else if (r.daily_averages.length > 31) {
    lines.push(`Daily means for ${r.daily_averages.length} days are in the structured result.`);
  }
  for (const n of r.notes) lines.push(`Note: ${n}`);
  lines.push(`Source: ${r.source}`);
  return lines.join("\n");
}
