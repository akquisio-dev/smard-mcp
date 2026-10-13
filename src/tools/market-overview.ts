/** get_market_overview: one day at a glance, built from the other tools' logic. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fetchAligned, sum } from "../analysis.js";
import { ATTRIBUTION } from "../catalog.js";
import { CO2_DISCLAIMER } from "../co2.js";
import type { SmardClient } from "../smard.js";
import { berlinDayFloor, formatBerlin, nextIntervalStart, parseTime } from "../time.js";
import { InputError, READ_ONLY_REMOTE, fmt1, guarded, round1, toolResult } from "./common.js";
import { co2Summary } from "./co2.js";
import { MIX_REGIONS, coverageText, energyText, loadMix, metaOf, mixShape, signed } from "./generation-mix.js";
import { analyzePrices, type PriceAnalysis } from "./prices.js";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Weekday of a Berlin calendar date given as YYYY-MM-DD. */
export function weekdayOf(date: string): string {
  return WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()]!;
}

const FORECAST_KEYS = {
  wind_onshore: "forecast_generation_wind_onshore",
  wind_offshore: "forecast_generation_wind_offshore",
  solar: "forecast_generation_solar",
  wind_and_solar: "forecast_generation_wind_and_solar",
  consumption: "forecast_consumption_total",
} as const;

const hourPoint = z.object({ time: z.string(), g_per_kwh: z.number() });
const priceSummary = z.object({
  mean_eur_mwh: z.number().nullable(),
  median_eur_mwh: z.number().nullable(),
  min: z.object({ time: z.string(), price_eur_mwh: z.number(), count: z.number() }).nullable(),
  max: z.object({ time: z.string(), price_eur_mwh: z.number(), count: z.number() }).nullable(),
  negative_count: z.number(),
  reference_mean_30d_eur_mwh: z.number().nullable().optional(),
  deviation_from_30d_pct: z.number().nullable().optional(),
});

const outputShape = {
  date: z.string(),
  weekday: z.string(),
  region: z.string(),
  from: z.string(),
  to: z.string(),
  covered_until: z.string().nullable(),
  complete: z.boolean(),
  mix: z.object(mixShape),
  co2: z.object({
    intensity_g_per_kwh: z.number().nullable(),
    total_emissions_t: z.number().nullable(),
    cleanest_hour: hourPoint.nullable(),
    dirtiest_hour: hourPoint.nullable(),
    disclaimer: z.string(),
  }),
  prices: priceSummary.nullable().describe("Day-ahead DE-LU; null for TSO regions (no regional prices)"),
  outlook: z.object({
    date: z.string(),
    forecast: z
      .object({
        wind_onshore_gwh: z.number().nullable(),
        wind_offshore_gwh: z.number().nullable(),
        solar_gwh: z.number().nullable(),
        wind_and_solar_gwh: z.number().nullable(),
        consumption_gwh: z.number().nullable(),
        wind_and_solar_share_pct: z.number().nullable().describe("Forecast wind + solar in % of forecast consumption"),
        complete: z.boolean(),
      })
      .nullable(),
    prices: priceSummary.nullable(),
    notes: z.array(z.string()),
  }),
  notes: z.array(z.string()),
  source: z.string(),
};

type Result = z.infer<z.ZodObject<typeof outputShape>>;

function summarizePrices(p: PriceAnalysis): z.infer<typeof priceSummary> {
  return {
    mean_eur_mwh: p.mean_eur_mwh,
    median_eur_mwh: p.median_eur_mwh,
    min: p.min,
    max: p.max,
    negative_count: p.negative_count,
    ...(p.context !== undefined
      ? { reference_mean_30d_eur_mwh: p.context?.reference_mean_eur_mwh ?? null, deviation_from_30d_pct: p.context?.deviation_pct ?? null }
      : {}),
  };
}

/** Prices or null with a note when they are not available (yet). */
async function pricesOrNull(client: SmardClient, from: number, to: number, context: boolean, notes: string[], what: string) {
  try {
    return summarizePrices(await analyzePrices(client, from, to, "hour", 3, context));
  } catch (err) {
    if (err instanceof InputError) {
      notes.push(`${what} are not available (yet).`);
      return null;
    }
    throw err;
  }
}

export function registerMarketOverview(server: McpServer, client: SmardClient): void {
  server.registerTool(
    "get_market_overview",
    {
      title: "Electricity market overview",
      description:
        "Overview of one day in a single call: generation mix, renewable share, estimated CO2 intensity, consumption, " +
        "day-ahead price statistics with the comparison to the 30 days before (region DE only) and, if available, " +
        "an outlook on the next day (wind and solar forecast, consumption forecast, prices). " +
        "Use it for questions like 'How was the electricity market yesterday?' or 'Give me an overview of today'. Default: yesterday. " +
        "For a formatted report, the prompt strom_uebersicht provides a fixed template.",
      inputSchema: {
        date: z.string().optional().describe("Day as YYYY-MM-DD. Default: yesterday."),
        region: z.enum(MIX_REGIONS).default("DE").describe("Germany or one of the four transmission system operator zones."),
      },
      outputSchema: outputShape,
      annotations: { title: "Electricity market overview", ...READ_ONLY_REMOTE },
    },
    async ({ date, region }) =>
      guarded(async () => {
        let dayStart: number;
        if (date) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new InputError("date must be YYYY-MM-DD.");
          try {
            dayStart = parseTime(date);
          } catch (err) {
            throw new InputError((err as Error).message);
          }
        } else {
          const today = berlinDayFloor(Date.now());
          dayStart = berlinDayFloor(today - 12 * 3_600_000);
        }
        const dayEnd = nextIntervalStart(dayStart, "day");
        const nextEnd = nextIntervalStart(dayEnd, "day");
        const day = formatBerlin(dayStart).slice(0, 10);
        const notes: string[] = [];
        const outlookNotes: string[] = [];

        const { data, mix } = await loadMix(client, region, dayStart, dayEnd);
        const co2 = co2Summary(data);
        const byHour = co2 ? [...co2.perInterval].sort((a, b) => a.gPerKwh - b.gPerKwh) : [];
        const hour = (p: { timestamp: number; gPerKwh: number } | undefined) =>
          p ? { time: formatBerlin(p.timestamp), g_per_kwh: Math.round(p.gPerKwh) } : null;

        const isDE = region === "DE";
        const [prices, nextPrices, forecast] = await Promise.all([
          isDE ? pricesOrNull(client, dayStart, dayEnd, true, notes, "Day-ahead prices for this day") : Promise.resolve(null),
          isDE ? pricesOrNull(client, dayEnd, nextEnd, false, outlookNotes, "Day-ahead prices for the next day") : Promise.resolve(null),
          fetchAligned(client, Object.values(FORECAST_KEYS), region, dayEnd, nextEnd, "hour"),
        ]);
        if (!isDE) notes.push("There is no regional price: day-ahead prices exist only for the DE-LU bidding zone. Use region DE for prices.");

        const total = (key: string) => {
          const s = forecast.series.find((x) => x.info.key === key);
          return s && s.points.length > 0 ? sum(s.points) / 1000 : null;
        };
        let forecastOut: Result["outlook"]["forecast"] = null;
        if (forecast.dataUntil === null) {
          outlookNotes.push("Forecasts for the next day are not published yet; SMARD publishes them during the current day.");
        } else {
          const ws = total(FORECAST_KEYS.wind_and_solar);
          const cons = total(FORECAST_KEYS.consumption);
          const r1 = (n: number | null) => (n === null ? null : round1(n));
          forecastOut = {
            wind_onshore_gwh: r1(total(FORECAST_KEYS.wind_onshore)),
            wind_offshore_gwh: r1(total(FORECAST_KEYS.wind_offshore)),
            solar_gwh: r1(total(FORECAST_KEYS.solar)),
            wind_and_solar_gwh: r1(ws),
            consumption_gwh: r1(cons),
            wind_and_solar_share_pct: ws !== null && cons ? round1((100 * ws) / cons) : null,
            complete: forecast.complete,
          };
          if (!forecast.complete) outlookNotes.push(...forecast.notes);
        }

        const meta = metaOf(data, region);
        const { raw: _raw, ...mixOut } = mix;
        const result: Result = {
          date: day,
          weekday: weekdayOf(day),
          region,
          from: meta.from,
          to: meta.to,
          covered_until: meta.covered_until,
          complete: meta.complete,
          mix: mixOut,
          co2: {
            intensity_g_per_kwh: mix.co2_intensity_g_per_kwh,
            total_emissions_t: co2 ? Math.round(co2.totalTonnes) : null,
            cleanest_hour: hour(byHour[0]),
            dirtiest_hour: hour(byHour[byHour.length - 1]),
            disclaimer: CO2_DISCLAIMER,
          },
          prices,
          outlook: { date: formatBerlin(dayEnd).slice(0, 10), forecast: forecastOut, prices: nextPrices, notes: outlookNotes },
          notes: [...data.notes, ...notes],
          source: ATTRIBUTION,
        };
        return toolResult(overviewText(result), result);
      }),
  );
}

function overviewText(r: Result): string {
  const eur = (n: number | null | undefined) => (n === null || n === undefined ? "n/a" : `${n.toFixed(2)} EUR/MWh`);
  const m = r.mix;
  const lines = [
    `Electricity market ${r.region}, ${r.weekday} ${r.date} (${coverageText(r)}):`,
    `Renewable share ${m.renewable_share_pct === null ? "n/a" : fmt1(m.renewable_share_pct) + " %"}; generation ${energyText(m.total_generation_gwh)}; consumption ${m.consumption_gwh === null ? "n/a" : energyText(m.consumption_gwh)} (average load ${m.average_load_gw === null ? "n/a" : fmt1(m.average_load_gw) + " GW"}); generation minus consumption ${m.balance_gwh === null ? "n/a" : signed(m.balance_gwh, " GWh")}.`,
    `Estimated CO2 intensity ${r.co2.intensity_g_per_kwh ?? "n/a"} g/kWh (cleanest hour ${r.co2.cleanest_hour ? `${r.co2.cleanest_hour.time.slice(11, 16)} ${r.co2.cleanest_hour.g_per_kwh}` : "n/a"}, dirtiest ${r.co2.dirtiest_hour ? `${r.co2.dirtiest_hour.time.slice(11, 16)} ${r.co2.dirtiest_hour.g_per_kwh}` : "n/a"} g/kWh).`,
    `Mix: ${m.sources.map((s) => `${s.name} ${fmt1(s.energy_gwh)} GWh (${fmt1(s.share_pct)} %)`).join(", ")}.`,
  ];
  if (r.prices) {
    const p = r.prices;
    const dev = p.deviation_from_30d_pct;
    lines.push(
      `Day-ahead price DE-LU: mean ${eur(p.mean_eur_mwh)} (${dev === null || dev === undefined ? "no 30-day comparison" : `${dev > 0 ? "+" : ""}${dev.toFixed(1)} % vs. the 30-day mean of ${eur(p.reference_mean_30d_eur_mwh)}`}), min ${p.min ? `${eur(p.min.price_eur_mwh)} at ${p.min.time.slice(11, 16)}` : "n/a"}, max ${p.max ? `${eur(p.max.price_eur_mwh)} at ${p.max.time.slice(11, 16)}` : "n/a"}, ${p.negative_count} hours with negative prices.`,
    );
  }
  const o = r.outlook;
  const f = o.forecast;
  lines.push(
    `Outlook ${o.date}: ${
      f
        ? `wind and solar forecast ${f.wind_and_solar_gwh === null ? "n/a" : fmt1(f.wind_and_solar_gwh) + " GWh"} (onshore ${f.wind_onshore_gwh ?? "n/a"}, offshore ${f.wind_offshore_gwh ?? "n/a"}, solar ${f.solar_gwh ?? "n/a"} GWh), consumption forecast ${f.consumption_gwh === null ? "n/a" : fmt1(f.consumption_gwh) + " GWh"}, wind+solar share ${f.wind_and_solar_share_pct === null ? "n/a" : fmt1(f.wind_and_solar_share_pct) + " %"}`
        : "no forecasts yet"
    }${o.prices ? `; prices mean ${eur(o.prices.mean_eur_mwh)}, min ${eur(o.prices.min?.price_eur_mwh)}, max ${eur(o.prices.max?.price_eur_mwh)}` : ""}.`,
  );
  for (const n of o.notes) lines.push(`Outlook note: ${n}`);
  for (const n of r.notes) lines.push(`Note: ${n}`);
  lines.push(`CO2: ${r.co2.disclaimer}`);
  lines.push(`Source: ${r.source}`);
  return lines.join("\n");
}
