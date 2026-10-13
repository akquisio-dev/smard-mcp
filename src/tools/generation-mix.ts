/** get_generation_mix: electricity generation by source for a period. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GENERATION_KEYS, INTERVAL_MS, LOAD_KEY, chooseResolution, fetchAligned, newestDataPoint, noDataMessage, sum, type AlignedData } from "../analysis.js";
import { ATTRIBUTION, type Region } from "../catalog.js";
import type { SmardClient } from "../smard.js";
import { formatBerlin } from "../time.js";
import { InputError, READ_ONLY_REMOTE, fmt1, guarded, round1, toolResult } from "./common.js";
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
  data_until: z.string().nullable().describe("Start of the last interval included (kept for compatibility; prefer covered_until)"),
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
  sources: z.infer<typeof sourceSchema>[];
  sources_without_data: string[];
  /** Unrounded values for further calculations (not part of the output). */
  raw: { totalMWh: number; renewableMWh: number; loadMWh: number | null; bySource: Map<string, number> };
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
  const hours = load && load.points.length > 0 ? (load.points.length * INTERVAL_MS[data.resolution]) / 3_600_000 : 0;

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
    sources,
    sources_without_data: withoutData,
    raw: { totalMWh, renewableMWh, loadMWh, bySource },
  };
}

/**
 * Fetches and computes the mix of one period. A period without any data is
 * an error instead of a mix full of zeros.
 */
export async function loadMix(client: SmardClient, region: Region, from: number, to: number, now = Date.now(), label = "") {
  const resolution = chooseResolution(from, to);
  const data = await fetchAligned(client, [...GENERATION_KEYS, LOAD_KEY], region, from, to, resolution, now);
  if (data.dataUntil === null) {
    const newest = await newestDataPoint(client, LOAD_KEY, region, resolution);
    throw new InputError(label + noDataMessage(newest, resolution));
  }
  return { data, mix: computeMix(data) };
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
    data_until: data.dataUntil === null ? null : formatBerlin(data.dataUntil),
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
        "total consumption (grid load) and generation in % of consumption as an import/export indicator. " +
        "Uses hourly values up to 8 weeks and daily values above. Without from/to: yesterday.",
      inputSchema: {
        from: z.string().optional().describe("Start (inclusive), YYYY-MM-DD or ISO 8601 date-time (Berlin time if no offset). Default: yesterday."),
        to: z.string().optional().describe("End (exclusive); a plain YYYY-MM-DD includes that day. Default: end of the from day."),
        region: z.enum(MIX_REGIONS).default("DE").describe("Germany or one of the four transmission system operator zones."),
      },
      outputSchema: { ...metaShape, ...mixShape },
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

function mixText(r: ReturnType<typeof metaOf> & Omit<Mix, "raw">): string {
  const lines = [
    `Generation mix ${r.region}, ${r.from} to ${r.to} (${r.resolution} values, ${coverageText(r)}):`,
    `Total generation ${fmt1(r.total_generation_gwh)} GWh, renewable ${r.renewable_share_pct === null ? "n/a" : fmt1(r.renewable_share_pct) + " %"} (${fmt1(r.renewable_gwh)} GWh).`,
  ];
  if (r.consumption_gwh !== null) {
    lines.push(
      `Consumption ${fmt1(r.consumption_gwh)} GWh (average load ${r.average_load_gw === null ? "n/a" : fmt1(r.average_load_gw) + " GW"}), generation = ${r.generation_to_consumption_pct === null ? "n/a" : fmt1(r.generation_to_consumption_pct) + " %"} of consumption.`,
    );
  }
  for (const s of r.sources) lines.push(`- ${s.name}: ${fmt1(s.energy_gwh)} GWh (${fmt1(s.share_pct)} %)${s.renewable ? ", renewable" : ""}`);
  for (const n of r.notes) lines.push(`Note: ${n}`);
  lines.push(`Source: ${r.source}`);
  return lines.join("\n");
}
