/** get_generation_mix: electricity generation by source for a period. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GENERATION_KEYS, INTERVAL_MS, LOAD_KEY, NET_EXPORT_KEY, chooseResolution, fetchAligned, noDataText, sum, type AlignedData } from "../analysis.js";
import { countryKeys, countryNetPoints } from "../flows-data.js";
import { ATTRIBUTION, GENERATION_SERIES, type Region } from "../catalog.js";
import { co2Intensity } from "../co2.js";
import type { SmardClient } from "../smard.js";
import { formatBerlin } from "../time.js";
import { InputError, READ_ONLY_REMOTE, fmt1, guarded, round1, toolResult, commonFields } from "./common.js";
import { parseRange } from "./range.js";

export const MIX_REGIONS = ["DE", "50Hertz", "Amprion", "TenneT", "TransnetBW"] as const;

const sourceSchema = z.object({
  key: z.string(),
  name: z.string(),
  renewable: z.boolean(),
  energy_gwh: z.number(),
  share_pct: z.number().describe("Share of total generation"),
});

/** Fields shared with compare_periods. */
export const mixShape = {
  total_generation_gwh: z.number(),
  renewable_gwh: z.number(),
  renewable_share_pct: z.number().nullable().describe("Renewables in % of generation; pumped storage is not renewable"),
  consumption_gwh: z.number().nullable().describe("Total consumption (grid load)"),
  average_load_gw: z.number().nullable(),
  generation_to_consumption_pct: z
    .number()
    .nullable()
    .describe("Generation in % of consumption; above 100 hints at net exports, below at net imports"),
  net_export_gwh: z
    .number()
    .nullable()
    .describe("Measured physical cross-border net export (negative = net import); for TSO zones only borders to other countries"),
  hours: z.number().describe("Hours covered by the data (23 or 25 on DST switch days)"),
  co2_intensity_g_per_kwh: z
    .number()
    .nullable()
    .describe("Estimated direct CO2 per kWh generated (generation-based, without imports/exports and upstream emissions)"),
  sources: z.array(sourceSchema).describe("Sources with generation, largest first"),
  sources_without_data: z.array(z.string()).describe("Series with no data or less than 0.05 GWh in the period; left out of sources"),
};

export const metaShape = {
  region: z.string(),
  from: z.string(),
  to: z.string(),
  resolution: z.enum(["quarterhour", "hour", "day"]),
  covered_until: z.string().nullable().describe("End of the last interval included"),
  complete: z.boolean().describe("True if the data covers the whole requested range"),
  notes: z.array(z.string()),
  source: z.string(),
};

export interface Mix {
  total_generation_gwh: number;
  renewable_gwh: number;
  renewable_share_pct: number | null;
  consumption_gwh: number | null;
  average_load_gw: number | null;
  generation_to_consumption_pct: number | null;
  net_export_gwh: number | null;
  hours: number;
  co2_intensity_g_per_kwh: number | null;
  sources: z.infer<typeof sourceSchema>[];
  sources_without_data: string[];
  /** Unrounded values for further calculations (not part of the output). */
  raw: {
    totalMWh: number;
    renewableMWh: number;
    loadMWh: number | null;
    netExportMWh: number | null;
    bySource: Map<string, number>;
    co2: number | null;
  };
}

/** Computes the mix from aligned generation series plus the load series. */
export function computeMix(data: AlignedData): Mix {
  const bySource = new Map<string, number>();
  let totalMWh = 0;
  let renewableMWh = 0;
  const withoutData: string[] = [];
  for (const s of data.series) {
    if (s.info.category !== "generation") continue;
    const mwh = sum(s.points);
    if (round1(mwh / 1000) === 0) withoutData.push(s.info.key);
    bySource.set(s.info.key, mwh);
    totalMWh += mwh;
    if (s.info.renewable) renewableMWh += mwh;
  }

  const load = data.series.find((s) => s.info.key === LOAD_KEY);
  const loadMWh = load && load.points.length > 0 ? sum(load.points) : null;
  const hours = data.coveredUntil === null ? 0 : (data.coveredUntil - data.from) / 3_600_000;
  const co2 = co2Intensity(bySource);
  const flows = data.series.find((s) => s.info.key === NET_EXPORT_KEY);
  const netExportMWh = flows && flows.points.length > 0 ? sum(flows.points) : null;

  const sources = data.series
    .filter((s) => s.info.category === "generation" && !withoutData.includes(s.info.key))
    .map((s) => {
      const mwh = bySource.get(s.info.key)!;
      return {
        key: s.info.key,
        name: s.info.name.replace(/^Generation: /, ""),
        renewable: s.info.renewable === true,
        energy_gwh: round1(mwh / 1000),
        share_pct: round1((100 * mwh) / totalMWh),
      };
    })
    .sort((a, b) => b.energy_gwh - a.energy_gwh);

  return {
    total_generation_gwh: round1(totalMWh / 1000),
    renewable_gwh: round1(renewableMWh / 1000),
    renewable_share_pct: totalMWh > 0 ? round1((100 * renewableMWh) / totalMWh) : null,
    consumption_gwh: loadMWh === null ? null : round1(loadMWh / 1000),
    average_load_gw: loadMWh === null || hours === 0 ? null : round1(loadMWh / 1000 / hours),
    generation_to_consumption_pct: loadMWh ? round1((100 * totalMWh) / loadMWh) : null,
    net_export_gwh: netExportMWh === null ? null : round1(netExportMWh / 1000) + 0,
    hours: round1(hours),
    co2_intensity_g_per_kwh: co2 === null ? null : Math.round(co2),
    sources,
    sources_without_data: withoutData,
    raw: { totalMWh, renewableMWh, loadMWh, netExportMWh, bySource, co2 },
  };
}

/**
 * Fetches and computes the mix of one period. A period without any data is
 * an error instead of a mix full of zeros.
 */
export async function loadMix(client: SmardClient, region: Region, from: number, to: number, now = Date.now(), label = "") {
  const resolution = chooseResolution(from, to);
  const data = await fetchAligned(client, [...GENERATION_KEYS, LOAD_KEY, NET_EXPORT_KEY], region, from, to, resolution, now);
  if (data.dataUntil === null) {
    throw new InputError(label + (await noDataText(client, LOAD_KEY, region, resolution, { from, to }, now)));
  }
  await completeNetExport(client, data, region);
  if (region !== "DE" && data.series.some((s) => s.info.key === NET_EXPORT_KEY && s.points.length > 0)) {
    data.notes.push("The net export of a TSO zone counts only its borders to other countries, not exchanges with the other German zones.");
  }
  return { data, mix: computeMix(data) };
}

/**
 * SMARD's physical net series starts on 24 September 2020. If it is missing
 * or starts inside the range, the net export is summed from the per-country
 * series instead (only then, to keep the usual call light).
 */
async function completeNetExport(client: SmardClient, data: AlignedData, region: Region): Promise<void> {
  const net = data.series.find((s) => s.info.key === NET_EXPORT_KEY);
  if (!net || data.dataUntil === null) return;
  const step = INTERVAL_MS[data.resolution];
  if (net.points.length > 0 && net.points[0]!.timestamp < data.from + step) return;
  const countries = await fetchAligned(client, countryKeys(region, "physical"), region, data.from, data.to, data.resolution);
  const until = data.dataUntil;
  net.points = countryNetPoints(countries, region, "physical").filter((p) => p.timestamp <= until);
  if (net.points.length > 0) data.notes.push("The net export is computed from the per-country series (SMARD's net series starts in September 2020).");
}

/** "complete" or "incomplete, data until ..." for text summaries. */
export function coverageText(meta: { complete: boolean; covered_until: string | null }): string {
  return meta.complete ? "complete" : `incomplete, data until ${meta.covered_until ?? "n/a"}`;
}

export function metaOf(data: AlignedData, region: string) {
  return {
    region,
    from: formatBerlin(data.from),
    to: formatBerlin(data.to),
    resolution: data.resolution,
    covered_until: data.coveredUntil === null ? null : formatBerlin(data.coveredUntil),
    complete: data.complete,
    notes: data.notes,
    source: ATTRIBUTION,
  };
}

export function registerGenerationMix(server: McpServer, client: SmardClient): void {
  server.registerTool(
    "get_generation_mix",
    {
      title: "Electricity generation mix",
      description:
        "Electricity generation by source for a period: energy per source in GWh and share in %, largest first, " +
        "the renewable share (wind, solar, biomass, hydro, other renewables; pumped storage is not renewable, as on SMARD), " +
        "total consumption (grid load), average load in GW, the number of hours covered, the measured cross-border net export (negative = net import) " +
        "and generation in % of consumption. " +
        "Uses hourly values up to 8 weeks and daily values above. Without from/to: yesterday.",
      inputSchema: {
        from: z.string().optional().describe("Start (inclusive), YYYY-MM-DD or ISO 8601 date-time (Berlin time if no offset). Default: yesterday."),
        to: z.string().optional().describe("End (exclusive); a plain YYYY-MM-DD includes that day. Default: end of the from day."),
        region: z.enum(MIX_REGIONS).default("DE").describe("Germany or one of the four transmission system operator zones."),
      },
      outputSchema: { ...metaShape, ...mixShape, ...commonFields },
      annotations: { title: "Electricity generation mix", ...READ_ONLY_REMOTE },
    },
    async ({ from, to, region }) =>
      guarded(async () => {
        const range = parseRange(from, to);
        const { data, mix } = await loadMix(client, region, range.from, range.to);
        const { raw: _raw, ...mixOut } = mix;
        const result = { ...metaOf(data, region), ...mixOut };
        return toolResult(mixText(result), result);
      }),
  );
}

/** GWh with one decimal, plus "= x TWh" from 10,000 GWh on. */
export function energyText(gwh: number): string {
  return Math.abs(gwh) >= 10_000 ? `${fmt1(gwh)} GWh = ${fmt1(gwh / 1000)} TWh` : `${fmt1(gwh)} GWh`;
}

export function signed(n: number, unit: string): string {
  return `${n > 0 ? "+" : ""}${fmt1(n)}${unit}`;
}

/** "net import 37.6 GWh" or "net export 12.0 GWh". */
export function netFlowText(netExportGwh: number): string {
  return netExportGwh < 0 ? `net import ${energyText(-netExportGwh)}` : `net export ${energyText(netExportGwh)}`;
}

/** Display name of a generation series key, e.g. "nuclear". */
export function sourceName(key: string): string {
  return GENERATION_SERIES.find((s) => s.key === key)?.name.replace(/^Generation: /, "") ?? key;
}

function mixText(r: ReturnType<typeof metaOf> & Omit<Mix, "raw">): string {
  const lines = [
    `Generation mix ${r.region}, ${r.from} to ${r.to} (${r.resolution} values, ${fmt1(r.hours)} hours, ${coverageText(r)}):`,
    `Total generation ${energyText(r.total_generation_gwh)}, renewable ${r.renewable_share_pct === null ? "n/a" : fmt1(r.renewable_share_pct) + " %"} (${energyText(r.renewable_gwh)}).`,
  ];
  if (r.consumption_gwh !== null) {
    lines.push(
      `Consumption ${energyText(r.consumption_gwh)} (average load ${r.average_load_gw === null ? "n/a" : fmt1(r.average_load_gw) + " GW"}), generation = ${r.generation_to_consumption_pct === null ? "n/a" : fmt1(r.generation_to_consumption_pct) + " %"} of consumption.`,
    );
  }
  if (r.co2_intensity_g_per_kwh !== null) {
    lines.push(`Estimated CO2 intensity: ${r.co2_intensity_g_per_kwh} g/kWh (generation-based, direct emissions only, without imports/exports).`);
  }
  if (r.net_export_gwh !== null) {
    lines.push(`Cross-border physical flows: ${netFlowText(r.net_export_gwh)} (measured; see get_cross_border_flows for countries).`);
  }
  for (const s of r.sources) lines.push(`- ${s.name}: ${energyText(s.energy_gwh)} (${fmt1(s.share_pct)} %)${s.renewable ? ", renewable" : ""}`);
  if (r.sources_without_data.length > 0) {
    lines.push(`No generation in the period: ${r.sources_without_data.map((k) => `${sourceName(k)} (0 GWh)`).join(", ")}.`);
  }
  for (const n of r.notes) lines.push(`Note: ${n}`);
  lines.push(`Source: ${r.source}`);
  return lines.join("\n");
}
