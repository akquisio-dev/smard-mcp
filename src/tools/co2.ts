/** get_co2_intensity: estimated CO2 intensity of electricity generation over time. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GENERATION_KEYS, LOAD_KEY, chooseResolution, fetchAligned, noDataText, type AlignedData } from "../analysis.js";
import { CO2_DISCLAIMER, EMISSION_FACTORS, EMISSION_FACTORS_SOURCE, co2Intensity, co2Tonnes } from "../co2.js";
import type { Region } from "../catalog.js";
import type { SmardClient } from "../smard.js";
import { formatBerlin } from "../time.js";
import { InputError, READ_ONLY_REMOTE, fmt1, guarded, round1, toolResult, warningsField } from "./common.js";
import { MIX_REGIONS, coverageText, metaOf, metaShape, sourceName } from "./generation-mix.js";
import { parseRange } from "./range.js";

/** Up to this many intervals are returned one by one (a month of hours). */
const MAX_LISTED_INTERVALS = 744;

const intervalPoint = z.object({ time: z.string(), g_per_kwh: z.number() });

const outputShape = {
  ...warningsField,
  ...metaShape,
  co2_intensity_g_per_kwh: z.number().describe("Generation-weighted mean: total emissions / total generation"),
  total_emissions_t: z.number().describe("Estimated direct CO2 emissions in tonnes"),
  total_generation_gwh: z.number(),
  interval_unit: z.enum(["hour", "day"]),
  cleanest: z.array(intervalPoint).describe("Intervals with the lowest intensity, lowest first"),
  dirtiest: z.array(intervalPoint).describe("Intervals with the highest intensity, highest first"),
  intervals: z.array(intervalPoint).optional().describe(`Intensity per interval, chronological (only up to ${MAX_LISTED_INTERVALS} intervals)`),
  by_source: z
    .array(z.object({ key: z.string(), name: z.string(), emissions_t: z.number(), share_pct: z.number(), g_per_kwh: z.number() }))
    .describe("Emitting sources, largest first"),
  method: z.string(),
  emission_factors: z.array(z.object({ key: z.string(), g_per_kwh: z.number(), uncertain: z.boolean() })),
  disclaimer: z.string(),
};

type Result = z.infer<z.ZodObject<typeof outputShape>>;

/** Generation per series key for every timestamp of the aligned data. */
export function generationByTime(data: AlignedData): Map<number, Map<string, number>> {
  const byTime = new Map<number, Map<string, number>>();
  for (const s of data.series) {
    if (s.info.category !== "generation") continue;
    for (const p of s.points) {
      let slot = byTime.get(p.timestamp);
      if (!slot) byTime.set(p.timestamp, (slot = new Map()));
      slot.set(s.info.key, p.value);
    }
  }
  return new Map([...byTime].sort((a, b) => a[0] - b[0]));
}

export interface Co2Summary {
  meanGPerKwh: number;
  totalTonnes: number;
  totalMWh: number;
  perInterval: { timestamp: number; gPerKwh: number }[];
  bySource: { key: string; tonnes: number }[];
}

/** Pure computation over aligned generation data; null if nothing was generated. */
export function co2Summary(data: AlignedData): Co2Summary | null {
  const totals = new Map<string, number>();
  for (const s of data.series) {
    if (s.info.category !== "generation") continue;
    totals.set(s.info.key, s.points.reduce((a, p) => a + p.value, 0));
  }
  const mean = co2Intensity(totals);
  if (mean === null) return null;
  const perInterval: Co2Summary["perInterval"] = [];
  for (const [timestamp, mix] of generationByTime(data)) {
    const g = co2Intensity(mix);
    if (g !== null) perInterval.push({ timestamp, gPerKwh: g });
  }
  const bySource = [...totals]
    .map(([key, mwh]) => ({ key, tonnes: co2Tonnes(new Map([[key, mwh]])) }))
    .filter((s) => s.tonnes > 0)
    .sort((a, b) => b.tonnes - a.tonnes);
  return {
    meanGPerKwh: mean,
    totalTonnes: co2Tonnes(totals),
    totalMWh: [...totals.values()].reduce((a, b) => a + b, 0),
    perInterval,
    bySource,
  };
}

/** Fetches generation for a period; errors if SMARD has nothing there. */
export async function loadGeneration(client: SmardClient, region: Region, from: number, to: number) {
  const resolution = chooseResolution(from, to);
  const data = await fetchAligned(client, GENERATION_KEYS, region, from, to, resolution);
  if (data.dataUntil === null) throw new InputError(await noDataText(client, LOAD_KEY, region, resolution, { from, to }));
  return data;
}

export function registerCo2Intensity(server: McpServer, client: SmardClient): void {
  server.registerTool(
    "get_co2_intensity",
    {
      title: "CO2 intensity of electricity",
      description:
        "Estimated CO2 intensity of electricity generation (g CO2 per kWh) per hour, its generation-weighted mean, the cleanest and dirtiest hours, " +
        "and the estimated total emissions in tonnes, with a breakdown by source. " +
        "Method: generation per source from SMARD x direct combustion emission factors (Umweltbundesamt). " +
        "An estimate: generation-based, without imports/exports, direct emissions only. " +
        "Hourly values up to 8 weeks, daily values above. Without from/to: yesterday.",
      inputSchema: {
        from: z.string().optional().describe("Start (inclusive), YYYY-MM-DD or ISO 8601 date-time (Berlin time if no offset). Default: yesterday."),
        to: z.string().optional().describe("End (exclusive); a plain YYYY-MM-DD includes that day. Default: end of the from day."),
        region: z.enum(MIX_REGIONS).default("DE").describe("Germany or one of the four transmission system operator zones."),
        top_n: z.number().int().min(1).max(24).default(5).describe("How many cleanest and dirtiest intervals to list."),
      },
      outputSchema: outputShape,
      annotations: { title: "CO2 intensity of electricity", ...READ_ONLY_REMOTE },
    },
    async ({ from, to, region, top_n }) =>
      guarded(async () => {
        const range = parseRange(from, to);
        const data = await loadGeneration(client, region, range.from, range.to);
        const summary = co2Summary(data);
        if (summary === null) throw new InputError("No generation in this period, so there is no CO2 intensity.");

        const point = (p: { timestamp: number; gPerKwh: number }) => ({ time: formatBerlin(p.timestamp), g_per_kwh: Math.round(p.gPerKwh) });
        const ascending = [...summary.perInterval].sort((a, b) => a.gPerKwh - b.gPerKwh);
        const descending = [...summary.perInterval].sort((a, b) => b.gPerKwh - a.gPerKwh);
        const notes = [...data.notes];
        const listAll = summary.perInterval.length <= MAX_LISTED_INTERVALS;
        if (!listAll) notes.push(`The ${summary.perInterval.length} single values are not listed; use a shorter range to get them.`);
        if (summary.bySource.some((s) => EMISSION_FACTORS[s.key]?.uncertain)) {
          notes.push(
            `The factor for other conventional generation (${EMISSION_FACTORS.generation_other_conventional!.gPerKwh} g/kWh) is uncertain: ${EMISSION_FACTORS.generation_other_conventional!.basis}`,
          );
        }
        notes.push("Pumped storage counts as 0: its electricity was generated, and counted, before it was stored.");

        const result: Result = {
          ...metaOf(data, region),
          notes,
          co2_intensity_g_per_kwh: Math.round(summary.meanGPerKwh),
          total_emissions_t: Math.round(summary.totalTonnes),
          total_generation_gwh: round1(summary.totalMWh / 1000),
          interval_unit: data.resolution === "day" ? "day" : "hour",
          cleanest: ascending.slice(0, top_n).map(point),
          dirtiest: descending.slice(0, top_n).map(point),
          ...(listAll ? { intervals: summary.perInterval.map(point) } : {}),
          by_source: summary.bySource.map((s) => ({
            key: s.key,
            name: sourceName(s.key),
            emissions_t: Math.round(s.tonnes),
            share_pct: round1((100 * s.tonnes) / summary.totalTonnes),
            g_per_kwh: EMISSION_FACTORS[s.key]!.gPerKwh,
          })),
          method: `Generation per source x emission factor. Factors: ${EMISSION_FACTORS_SOURCE}.`,
          emission_factors: Object.entries(EMISSION_FACTORS).map(([key, f]) => ({ key, g_per_kwh: f.gPerKwh, uncertain: f.uncertain === true })),
          disclaimer: CO2_DISCLAIMER,
        };
        return toolResult(co2Text(result), result);
      }),
  );
}

/** Tonnes as text, with kt / Mt for large values. */
function tonnesText(t: number): string {
  if (t >= 1_000_000) return `${fmt1(t / 1_000_000)} Mt`;
  if (t >= 10_000) return `${fmt1(t / 1000)} kt`;
  return `${t} t`;
}

function co2Text(r: Result): string {
  const unit = r.interval_unit === "day" ? "days" : "hours";
  const list = (ps: { time: string; g_per_kwh: number }[]) => ps.map((p) => `${p.time} (${p.g_per_kwh})`).join(", ");
  const lines = [
    `Estimated CO2 intensity ${r.region}, ${r.from} to ${r.to} (${r.resolution} values, ${coverageText(r)}):`,
    `Mean ${r.co2_intensity_g_per_kwh} g CO2/kWh; total about ${tonnesText(r.total_emissions_t)} CO2 for ${fmt1(r.total_generation_gwh)} GWh generated.`,
    `Cleanest ${unit} (g/kWh): ${list(r.cleanest)}.`,
    `Dirtiest ${unit} (g/kWh): ${list(r.dirtiest)}.`,
    `By source: ${r.by_source.map((s) => `${s.name} ${tonnesText(s.emissions_t)} (${fmt1(s.share_pct)} %, ${s.g_per_kwh} g/kWh)`).join(", ")}.`,
    `Important: ${r.disclaimer}`,
  ];
  for (const n of r.notes) lines.push(`Note: ${n}`);
  lines.push(`Method: ${r.method}`);
  lines.push(`Source: ${r.source}`);
  return lines.join("\n");
}
