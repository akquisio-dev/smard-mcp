/**
 * get_current_status: the newest quarter-hour that generation, consumption
 * and cross-border flows have in common, as power in GW, plus the current
 * price and an hourly outlook. Answers "what is happening right now" in one
 * call instead of several get_series calls with different data horizons.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GENERATION_KEYS, HOUR, LOAD_KEY, NET_EXPORT_KEY } from "../analysis.js";
import { ATTRIBUTION, findSeries, type Region } from "../catalog.js";
import { co2Intensity } from "../co2.js";
import { SmardError, type DataPoint, type SmardClient } from "../smard.js";
import { formatBerlin } from "../time.js";
import { preferIntraday, valuesByTime } from "./best-hours.js";
import { InputError, READ_ONLY_REMOTE, commonFields, fmt1, guarded, round1, round2, toolResult } from "./common.js";
import { MIX_REGIONS } from "./generation-mix.js";

const QUARTER = HOUR / 4;

/** How far back the newest common quarter-hour is searched. */
const LOOKBACK_MS = 6 * HOUR;

/**
 * A series this far behind the newest one is left out of the snapshot (and
 * named in the notes) instead of pulling every other value back with it.
 */
export const STRAGGLER_MS = HOUR;

/** GW from MWh per quarter-hour. */
const gw = (mwhPerQuarter: number) => (mwhPerQuarter * 4) / 1000;

const sourceSchema = z.object({
  key: z.string(),
  name: z.string(),
  renewable: z.boolean(),
  gw: z.number(),
  share_pct: z.number().describe("Share of total generation"),
});

const outlookSchema = z.object({
  time: z.string().describe("Start of the hour"),
  price_eur_mwh: z.number().nullable().describe("Day-ahead DE-LU, hourly mean"),
  wind_and_solar_gw: z.number().nullable().describe("Forecast; intraday where available, else day-ahead"),
  consumption_gw: z.number().nullable().describe("Forecast"),
  wind_and_solar_share_pct: z.number().nullable().describe("Forecast wind + solar in % of forecast consumption"),
});

const outputShape = {
  ...commonFields,
  region: z.string(),
  as_of: z.string().describe("Start of the newest quarter-hour that all reported values share"),
  interval_end: z.string().describe("End of that quarter-hour"),
  data_age_minutes: z.number().describe("Minutes between interval_end and the server time"),
  generation: z.object({
    total_gw: z.number(),
    renewable_gw: z.number(),
    renewable_share_pct: z.number().nullable().describe("Renewables in % of generation; pumped storage is not renewable"),
    sources: z.array(sourceSchema).describe("Sources with generation, largest first"),
  }),
  consumption_gw: z.number().nullable().describe("Total consumption (grid load)"),
  net_export_gw: z
    .number()
    .nullable()
    .describe("Measured physical cross-border net export (negative = net import); for TSO zones only borders to other countries"),
  co2_intensity_g_per_kwh: z
    .number()
    .nullable()
    .describe("Estimated average direct CO2 per kWh generated in this quarter-hour (not marginal emissions)"),
  price: z
    .object({
      interval_start: z.string(),
      interval_end: z.string(),
      eur_mwh: z.number(),
    })
    .nullable()
    .describe("Day-ahead price DE-LU of the quarter-hour containing the server time"),
  outlook: z.array(outlookSchema).describe("Hourly outlook from the current hour on"),
  lagging: z
    .array(z.object({ key: z.string(), data_until: z.string() }))
    .describe("Series left out of the snapshot (and of all totals and shares) because SMARD has published them only up to data_until"),
  notes: z.array(z.string()),
  source: z.string(),
};

type Result = z.infer<z.ZodObject<typeof outputShape>>;

/** Points of one series, or null if SMARD does not offer it for the region. */
async function quarterHours(client: SmardClient, key: string, region: Region, from: number, to: number): Promise<DataPoint[] | null> {
  const info = findSeries(key)!;
  try {
    return await client.getRange(info.filter, region, "quarterhour", from, to);
  } catch (err) {
    if (err instanceof SmardError && err.status === 404) return null;
    throw err;
  }
}

export interface Snapshot {
  asOf: number;
  values: Map<string, number>;
  lagging: { key: string; until: number }[];
}

/**
 * Picks the newest quarter-hour that every series reporting currently has a
 * value for. Series without any value in the lookback window (nuclear, or
 * not offered for the region) are ignored; series more than STRAGGLER_MS
 * behind the newest one are listed as lagging.
 */
export function pickSnapshot(series: ReadonlyMap<string, readonly DataPoint[]>): Snapshot | null {
  const lasts = new Map<string, number>();
  for (const [key, points] of series) {
    const last = points[points.length - 1];
    if (last) lasts.set(key, last.timestamp);
  }
  if (lasts.size === 0) return null;
  const newest = Math.max(...lasts.values());
  const lagging: Snapshot["lagging"] = [];
  let asOf = newest;
  for (const [key, last] of lasts) {
    if (last < newest - STRAGGLER_MS) lagging.push({ key, until: last + QUARTER });
    else asOf = Math.min(asOf, last);
  }
  const values = new Map<string, number>();
  for (const [key, points] of series) {
    if (lagging.some((l) => l.key === key)) continue;
    const p = points.find((x) => x.timestamp === asOf);
    if (p) values.set(key, p.value);
  }
  return { asOf, values, lagging };
}

export function registerCurrentStatus(server: McpServer, client: SmardClient): void {
  server.registerTool(
    "get_current_status",
    {
      title: "Current electricity status",
      description:
        "What is happening right now, in one call: power per source in GW, total generation, renewable share, consumption, " +
        "cross-border net export, estimated CO2 intensity and the current day-ahead price, all for the newest quarter-hour " +
        "that SMARD has published for every series (as_of; usually 30 to 60 minutes old, see data_age_minutes), " +
        "plus an hourly outlook (price, wind and solar forecast, consumption forecast). " +
        "Use it for questions like 'How much solar/wind is being produced right now?' or 'What does power cost at the moment?'. " +
        "Values are average power over the quarter-hour, not energy.",
      inputSchema: {
        region: z.enum(MIX_REGIONS).default("DE").describe("Germany or one of the four transmission system operator zones."),
        hours_ahead: z.number().int().min(0).max(24).default(6).describe("Hours of outlook from the current hour on."),
      },
      outputSchema: outputShape,
      annotations: { title: "Current electricity status", ...READ_ONLY_REMOTE },
    },
    async ({ region, hours_ahead }) =>
      guarded(async () => {
        const now = Date.now();
        const from = Math.floor((now - LOOKBACK_MS) / QUARTER) * QUARTER;
        const keys = [...GENERATION_KEYS, LOAD_KEY, NET_EXPORT_KEY];
        const fetched = await Promise.all(keys.map((k) => quarterHours(client, k, region, from, now + QUARTER)));
        const series = new Map<string, DataPoint[]>();
        keys.forEach((k, i) => {
          const points = fetched[i];
          if (points) series.set(k, points);
        });
        const snap = pickSnapshot(series);
        if (!snap) throw new SmardError(`SMARD has no values for ${region} in the last ${LOOKBACK_MS / HOUR} hours.`);

        const notes: string[] = [];
        const hourStart = Math.floor(now / HOUR) * HOUR;
        const quarterStart = Math.floor(now / QUARTER) * QUARTER;
        const outlookEnd = hourStart + hours_ahead * HOUR;
        const [quarterPrice, prices, intraday, dayAhead, load] = await Promise.all([
          valuesByTime(client, "price_de_lu", "DE", "quarterhour", quarterStart, quarterStart + QUARTER),
          hours_ahead > 0 ? valuesByTime(client, "price_de_lu", "DE", "hour", hourStart, outlookEnd) : null,
          hours_ahead > 0 ? valuesByTime(client, "forecast_intraday_wind_and_solar", region, "hour", hourStart, outlookEnd) : null,
          hours_ahead > 0 ? valuesByTime(client, "forecast_generation_wind_and_solar", region, "hour", hourStart, outlookEnd) : null,
          hours_ahead > 0 ? valuesByTime(client, "forecast_consumption_total", region, "hour", hourStart, outlookEnd) : null,
        ]);

        // Generation
        const bySource = new Map<string, number>();
        for (const key of GENERATION_KEYS) {
          const v = snap.values.get(key);
          if (v !== undefined) bySource.set(key, v);
        }
        const totalMWh = [...bySource.values()].reduce((a, b) => a + b, 0);
        const renewableMWh = [...bySource].filter(([k]) => findSeries(k)!.renewable).reduce((a, [, v]) => a + v, 0);
        if (totalMWh <= 0) throw new InputError("SMARD reports no generation for this quarter-hour.");
        const sources = [...bySource]
          .filter(([, v]) => round1(gw(v)) > 0)
          .map(([key, v]) => {
            const info = findSeries(key)!;
            return {
              key,
              name: info.name.replace(/^Generation: /, ""),
              renewable: info.renewable === true,
              gw: round2(gw(v)),
              share_pct: round1((100 * v) / totalMWh),
            };
          })
          .sort((a, b) => b.gw - a.gw);

        const loadMWh = snap.values.get(LOAD_KEY);
        const netMWh = snap.values.get(NET_EXPORT_KEY);
        const co2 = co2Intensity(bySource);
        const price = quarterPrice?.get(quarterStart);
        if (price === undefined) notes.push("The day-ahead price of the current quarter-hour is not available.");
        if (region !== "DE") {
          notes.push("Prices are those of the DE-LU bidding zone; there are no regional prices.");
          notes.push("The net export of a TSO zone counts only its borders to other countries, not exchanges with the other German zones.");
        }
        for (const l of snap.lagging) {
          notes.push(`${l.key} is left out: SMARD has published it only up to ${formatBerlin(l.until)}.`);
        }

        const forecastWs = preferIntraday(intraday, dayAhead).values;
        const outlook: Result["outlook"] = [];
        for (let t = hourStart; t < outlookEnd; t += HOUR) {
          const ws = forecastWs.get(t);
          const l = load?.get(t);
          const p = prices?.get(t);
          outlook.push({
            time: formatBerlin(t),
            price_eur_mwh: p === undefined ? null : round2(p),
            wind_and_solar_gw: ws === undefined ? null : round2(ws / 1000),
            consumption_gw: l === undefined ? null : round2(l / 1000),
            wind_and_solar_share_pct: ws !== undefined && l ? round1((100 * ws) / l) : null,
          });
        }
        if (outlook.some((o) => o.price_eur_mwh === null)) {
          notes.push("Some outlook hours have no price yet: day-ahead prices for the next day are published after the auction around noon.");
        }

        const intervalEnd = snap.asOf + QUARTER;
        const result: Result = {
          region,
          as_of: formatBerlin(snap.asOf),
          interval_end: formatBerlin(intervalEnd),
          data_age_minutes: Math.max(0, Math.round((now - intervalEnd) / 60_000)),
          generation: {
            total_gw: round2(gw(totalMWh)),
            renewable_gw: round2(gw(renewableMWh)),
            renewable_share_pct: totalMWh > 0 ? round1((100 * renewableMWh) / totalMWh) : null,
            sources,
          },
          consumption_gw: loadMWh === undefined ? null : round2(gw(loadMWh)),
          net_export_gw: netMWh === undefined ? null : round2(gw(netMWh)) + 0,
          co2_intensity_g_per_kwh: co2 === null ? null : Math.round(co2),
          price:
            price === undefined
              ? null
              : { interval_start: formatBerlin(quarterStart), interval_end: formatBerlin(quarterStart + QUARTER), eur_mwh: round2(price) },
          outlook,
          lagging: snap.lagging.map((l) => ({ key: l.key, data_until: formatBerlin(l.until) })),
          notes,
          source: ATTRIBUTION,
        };
        return toolResult(statusText(result), result);
      }),
  );
}

function statusText(r: Result): string {
  const g = r.generation;
  const hhmm = (s: string) => s.slice(11, 16);
  const lines = [
    `Electricity ${r.region} at ${hhmm(r.as_of)} to ${hhmm(r.interval_end)} (${r.as_of.slice(0, 10)}; data ${r.data_age_minutes} minutes old):`,
    ...(r.lagging.length > 0
      ? [`Incomplete: ${r.lagging.map((l) => l.key).join(", ")} not yet published for this quarter-hour, so totals and shares leave them out.`]
      : []),
    `Generation ${fmt1(g.total_gw)} GW, renewable ${g.renewable_share_pct === null ? "n/a" : fmt1(g.renewable_share_pct) + " %"} (${fmt1(g.renewable_gw)} GW); ` +
      `consumption ${r.consumption_gw === null ? "n/a" : fmt1(r.consumption_gw) + " GW"}; ` +
      `cross-border ${r.net_export_gw === null ? "n/a" : r.net_export_gw < 0 ? `net import ${fmt1(-r.net_export_gw)} GW` : `net export ${fmt1(r.net_export_gw)} GW`}; ` +
      `estimated CO2 ${r.co2_intensity_g_per_kwh ?? "n/a"} g/kWh.`,
    `Sources: ${g.sources.map((s) => `${s.name} ${s.gw.toFixed(2)} GW (${fmt1(s.share_pct)} %)`).join(", ")}.`,
    r.price
      ? `Day-ahead price DE-LU ${hhmm(r.price.interval_start)} to ${hhmm(r.price.interval_end)}: ${r.price.eur_mwh.toFixed(2)} EUR/MWh.`
      : "Day-ahead price of the current quarter-hour: n/a.",
  ];
  if (r.outlook.length > 0) {
    const cell = (n: number | null, digits = 1) => (n === null ? "n/a" : n.toFixed(digits));
    lines.push("Outlook (hour: price EUR/MWh, wind+solar GW, consumption GW, wind+solar share %):");
    for (const o of r.outlook) {
      lines.push(`${hhmm(o.time)}: ${cell(o.price_eur_mwh, 2)}, ${cell(o.wind_and_solar_gw)}, ${cell(o.consumption_gw)}, ${cell(o.wind_and_solar_share_pct)}`);
    }
  }
  for (const n of r.notes) lines.push(`Note: ${n}`);
  lines.push(`Source: ${r.source}`);
  return lines.join("\n");
}
