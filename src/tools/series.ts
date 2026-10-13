/** list_series and get_series: direct access to single SMARD series. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ATTRIBUTION, PRICE_REGIONS, REGIONS, RESOLUTIONS, SERIES, SERIES_KEYS, findSeries, type Region } from "../catalog.js";
import type { SmardClient } from "../smard.js";
import { formatBerlin, nextIntervalStart, parseTime } from "../time.js";
import { InputError, errorResult, guarded, round2, toolResult } from "./common.js";

/** Upper bound on points returned by one get_series call. */
export const MAX_POINTS = 2000;

const HOUR = 3_600_000;
const DEFAULT_WINDOW_MS = 24 * HOUR;

/** Interval length for resolutions where a gap at the end can be detected. */
const INTERVAL_MS: Partial<Record<string, number>> = { quarterhour: HOUR / 4, hour: HOUR, day: 24 * HOUR };

export function registerSeriesTools(server: McpServer, client: SmardClient): void {
  server.registerTool(
    "list_series",
    {
      title: "List SMARD series",
      description:
        "Lists the SMARD time series this server can fetch, with their key, unit and category, plus the supported regions and resolutions and the current server time (Europe/Berlin).",
      inputSchema: {
        category: z
          .enum(["generation", "consumption", "price", "forecast_generation", "forecast_consumption", "cross_border"])
          .optional()
          .describe("Only list series of this category."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ category }) => {
      const series = SERIES.filter((s) => !category || s.category === category).map(({ filter: _f, ...rest }) => rest);
      const result = {
        server_time: formatBerlin(Date.now()),
        series,
        regions: [...REGIONS],
        price_regions: [...PRICE_REGIONS],
        resolutions: [...RESOLUTIONS],
        source: ATTRIBUTION,
      };
      return toolResult(JSON.stringify(result, null, 2), result);
    },
  );

  server.registerTool(
    "get_series",
    {
      title: "Get SMARD time series",
      description:
        "Fetches values of one SMARD time series for a time range. " +
        "Generation and consumption values are energy per interval in MWh (e.g. per hour at hourly resolution); prices are in EUR/MWh. " +
        "Price series belong to a bidding zone given by the series key, not to a region, so they only accept region DE or DE-LU. " +
        "covered_until is the end of the last returned interval; complete tells whether the values reach the end of the range. " +
        "Times are Europe/Berlin. Without from/to, the last 24 hours plus the next 24 hours are returned (prices and forecasts reach into the future); with only from, 48 hours from that point. " +
        "With resolution week, month or year a value is only returned if the period starts inside the range, and the current, unfinished period is missing. " +
        `At most ${MAX_POINTS} points per call; use a coarser resolution for long ranges, or include_points=false for the summary only.`,
      inputSchema: {
        series: z.enum(SERIES_KEYS).describe("Series key from list_series, e.g. price_de_lu or generation_solar."),
        region: z
          .enum(REGIONS)
          .default("DE")
          .describe("Area. DE = Germany; DE-LU = DE/LU bidding zone; also AT, LU and the four German TSO zones. Price series: DE or DE-LU only."),
        resolution: z.enum(RESOLUTIONS).default("hour").describe("Interval length of the returned values."),
        from: z
          .string()
          .optional()
          .describe("Start (inclusive). YYYY-MM-DD (midnight Berlin) or ISO 8601 date-time; without offset it is Berlin time."),
        to: z
          .string()
          .optional()
          .describe("End (exclusive). YYYY-MM-DD includes that whole day. ISO 8601 date-time also accepted."),
        include_points: z
          .boolean()
          .default(true)
          .describe("Set to false to get only the summary without the individual values."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ series, region, resolution, from, to, include_points }) =>
      guarded(async () => {
        const info = findSeries(series);
        if (!info) return errorResult(`Unknown series "${series}". Call list_series for valid keys.`);
        if (info.zone && !PRICE_REGIONS.includes(region)) {
          throw new InputError(
            `${info.key} is the price of bidding zone ${info.zone} and does not vary by region. Use region DE or DE-LU; pick the zone via the series key (see list_series, category price).`,
          );
        }

        const now = Date.now();
        let fromMs: number;
        let toMs: number;
        try {
          fromMs = from ? parseTime(from) : now - DEFAULT_WINDOW_MS;
          toMs = to ? parseTime(to, true) : from ? fromMs + 2 * DEFAULT_WINDOW_MS : now + DEFAULT_WINDOW_MS;
        } catch (err) {
          throw new InputError((err as Error).message);
        }
        if (toMs <= fromMs) throw new InputError('"to" must be after "from".');

        // Price series are identical for every region; always ask SMARD for DE.
        const queryRegion: Region = info.zone ? "DE" : region;
        const points = await client.getRange(info.filter, queryRegion, resolution, fromMs, toMs);
        if (include_points && points.length > MAX_POINTS) {
          throw new InputError(
            `The range has ${points.length} values at resolution "${resolution}" (limit ${MAX_POINTS}). Use a shorter range, a coarser resolution or include_points=false.`,
          );
        }

        const values = points.map((p) => p.value);
        const last = points[points.length - 1];
        const summary =
          values.length === 0
            ? null
            : {
                count: values.length,
                min: round2(Math.min(...values)),
                max: round2(Math.max(...values)),
                mean: round2(values.reduce((a, b) => a + b, 0) / values.length),
                // A sum of prices has no meaning, so only energy series get one.
                ...(info.unit === "MWh" ? { sum: round2(values.reduce((a, b) => a + b, 0)) } : {}),
                first: formatBerlin(points[0]!.timestamp),
                last: formatBerlin(last!.timestamp),
              };

        const notes: string[] = [];
        const interval = INTERVAL_MS[resolution];
        const coveredUntil = last ? nextIntervalStart(last.timestamp, resolution) : null;
        const dataEnd = coveredUntil ?? fromMs;
        if (interval !== undefined && dataEnd < Math.min(toMs, now) - interval) {
          notes.push(`Data is incomplete: SMARD has values only up to ${last ? formatBerlin(last.timestamp) : "before the range"}.`);
        }
        if (info.category.startsWith("forecast") && toMs > now && dataEnd < toMs) {
          notes.push("SMARD publishes forecasts for the next day during the course of the current day; later values may not be available yet.");
        }

        const result = {
          series: info.key,
          name: info.name,
          unit: info.unit,
          ...(info.zone ? { bidding_zone: info.zone } : {}),
          region,
          resolution,
          from: formatBerlin(fromMs),
          to: formatBerlin(toMs),
          covered_until: coveredUntil === null ? null : formatBerlin(coveredUntil),
          complete: coveredUntil !== null && coveredUntil >= toMs,
          data_until: last ? formatBerlin(last.timestamp) : null,
          summary,
          ...(notes.length > 0 ? { notes } : {}),
          ...(include_points ? { points: points.map((p) => ({ time: formatBerlin(p.timestamp), value: p.value })) } : {}),
          source: ATTRIBUTION,
        };
        const json = JSON.stringify(result);
        const text =
          values.length === 0
            ? `No data for ${info.name} (${region}, ${resolution}) between ${result.from} and ${result.to}.${notes.length ? " " + notes.join(" ") : ""}\n\n${json}`
            : json;
        return toolResult(text, result);
      }),
  );
}
