import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ATTRIBUTION, REGIONS, RESOLUTIONS, SERIES, SERIES_KEYS, findSeries } from "./catalog.js";
import { SmardClient, SmardError } from "./smard.js";
import { formatBerlin, parseTime } from "./time.js";

export const SERVER_NAME = "smard-mcp";
export const SERVER_VERSION = "0.1.0";

/** Upper bound on points returned by one get_series call. */
export const MAX_POINTS = 2000;

const DEFAULT_WINDOW_MS = 24 * 3_600_000;

export function createServer(client: SmardClient = new SmardClient()): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "German electricity market data from SMARD (Bundesnetzagentur): generation by source, consumption, day-ahead prices and forecasts. " +
        "Call list_series to see what is available, then get_series for the values. " +
        `Cite the source as "${ATTRIBUTION}" when presenting the data.`,
    },
  );

  server.registerTool(
    "list_series",
    {
      title: "List SMARD series",
      description:
        "Lists the SMARD time series this server can fetch, with their key, unit and category, plus the supported regions and resolutions.",
      inputSchema: {
        category: z
          .enum(["generation", "consumption", "price", "forecast_generation", "forecast_consumption"])
          .optional()
          .describe("Only list series of this category."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ category }) => {
      const series = SERIES.filter((s) => !category || s.category === category).map(({ filter: _f, ...rest }) => rest);
      const result = { series, regions: [...REGIONS], resolutions: [...RESOLUTIONS], source: ATTRIBUTION };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
    },
  );

  server.registerTool(
    "get_series",
    {
      title: "Get SMARD time series",
      description:
        "Fetches values of one SMARD time series for a time range. " +
        "Generation and consumption values are energy per interval in MWh (e.g. per hour at hourly resolution); prices are in EUR/MWh. " +
        "Times are Europe/Berlin. Without from/to, the last 24 hours plus the next 24 hours are returned (prices and forecasts reach into the future); with only from, 48 hours from that point. " +
        `At most ${MAX_POINTS} points per call; use a coarser resolution for long ranges.`,
      inputSchema: {
        series: z.enum(SERIES_KEYS).describe("Series key from list_series, e.g. price_de_lu or generation_solar."),
        region: z
          .enum(REGIONS)
          .default("DE")
          .describe("Area. DE = Germany; DE-LU = DE/LU bidding zone; also AT, LU and the four German TSO zones."),
        resolution: z.enum(RESOLUTIONS).default("hour").describe("Interval length of the returned values."),
        from: z
          .string()
          .optional()
          .describe("Start (inclusive). YYYY-MM-DD (midnight Berlin) or ISO 8601 date-time with offset."),
        to: z
          .string()
          .optional()
          .describe("End (exclusive). YYYY-MM-DD includes that whole day. ISO 8601 date-time with offset also accepted."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ series, region, resolution, from, to }) => {
      const info = findSeries(series);
      if (!info) return errorResult(`Unknown series "${series}". Call list_series for valid keys.`);

      let fromMs: number;
      let toMs: number;
      try {
        const now = Date.now();
        fromMs = from ? parseTime(from) : now - DEFAULT_WINDOW_MS;
        toMs = to ? parseTime(to, true) : from ? fromMs + 2 * DEFAULT_WINDOW_MS : now + DEFAULT_WINDOW_MS;
      } catch (err) {
        return errorResult((err as Error).message);
      }
      if (toMs <= fromMs) return errorResult('"to" must be after "from".');

      let points;
      try {
        points = await client.getRange(info.filter, region, resolution, fromMs, toMs);
      } catch (err) {
        if (err instanceof SmardError) return errorResult(err.message);
        throw err;
      }
      if (points.length > MAX_POINTS) {
        return errorResult(
          `The range has ${points.length} values at resolution "${resolution}" (limit ${MAX_POINTS}). Use a shorter range or a coarser resolution.`,
        );
      }

      const values = points.map((p) => p.value);
      const summary =
        values.length === 0
          ? null
          : {
              count: values.length,
              min: round(Math.min(...values)),
              max: round(Math.max(...values)),
              mean: round(values.reduce((a, b) => a + b, 0) / values.length),
              first: formatBerlin(points[0]!.timestamp),
              last: formatBerlin(points[points.length - 1]!.timestamp),
            };

      const result = {
        series: info.key,
        name: info.name,
        unit: info.unit,
        ...(info.note ? { note: info.note } : {}),
        region,
        resolution,
        from: formatBerlin(fromMs),
        to: formatBerlin(toMs),
        summary,
        points: points.map((p) => ({ time: formatBerlin(p.timestamp), value: p.value })),
        source: ATTRIBUTION,
      };
      const json = JSON.stringify(result);
      const text =
        values.length === 0
          ? `No data for ${info.name} (${region}, ${resolution}) between ${result.from} and ${result.to}.\n\n${json}`
          : json;
      return { content: [{ type: "text", text }], structuredContent: result };
    },
  );

  return server;
}

function errorResult(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
