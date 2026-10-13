/** compare_periods: generation mix, consumption and price of two periods side by side. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { INTERVAL_MS, PRICE_KEY, mean, type AlignedData } from "../analysis.js";
import { ATTRIBUTION, findSeries } from "../catalog.js";
import type { SmardClient } from "../smard.js";
import { READ_ONLY_REMOTE, fmt1, guarded, round1, toolResult } from "./common.js";
import { MIX_REGIONS, loadMix, metaOf, mixShape, type Mix } from "./generation-mix.js";
import { parseRange } from "./range.js";

const periodShape = {
  from: z.string(),
  to: z.string(),
  resolution: z.enum(["quarterhour", "hour", "day"]),
  covered_until: z.string().nullable(),
  complete: z.boolean(),
  data_until: z.string().nullable(),
  ...mixShape,
  average_price_eur_mwh: z.number().nullable().optional().describe("Mean day-ahead price DE-LU (region DE only)"),
};

const sourceDiff = z.object({
  key: z.string(),
  name: z.string(),
  a_gwh: z.number(),
  b_gwh: z.number(),
  delta_gwh: z.number(),
  a_share_pct: z.number(),
  b_share_pct: z.number(),
  delta_share_pp: z.number().describe("Change of the share in percentage points"),
});

const outputShape = {
  region: z.string(),
  period_a: z.object(periodShape),
  period_b: z.object(periodShape),
  differences: z
    .object({
      total_generation_gwh: z.number(),
      renewable_gwh: z.number(),
      renewable_share_pp: z.number().nullable(),
      consumption_gwh: z.number().nullable(),
      consumption_pct: z.number().nullable().describe("Relative change of consumption in %"),
      generation_to_consumption_pp: z.number().nullable(),
      average_price_eur_mwh: z.number().nullable().optional(),
      average_price_pct: z.number().nullable().optional(),
      sources: z.array(sourceDiff).describe("Per source, largest absolute change first"),
    })
    .describe("Always period B minus period A"),
  notes: z.array(z.string()),
  source: z.string(),
};

/** Mean DE-LU day-ahead price over the interval the mix data covers. */
async function averagePrice(client: SmardClient, data: AlignedData): Promise<number | null> {
  if (data.dataUntil === null) return null;
  const info = findSeries(PRICE_KEY)!;
  const end = data.dataUntil + INTERVAL_MS[data.resolution];
  // Daily price values are the mean of the hourly prices of that day.
  const points = await client.getRange(info.filter, "DE", data.resolution, data.from, end, { maxBlocks: 12 });
  const avg = mean(points.map((p) => p.value));
  return avg === null ? null : avg;
}

/** Difference of unrounded values, rounded only at the end. */
function diff(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : round1(b - a);
}

function share(part: number, whole: number | null): number | null {
  return whole ? (100 * part) / whole : null;
}

function relative(a: number | null, b: number | null): number | null {
  return a === null || b === null || a === 0 ? null : round1((100 * (b - a)) / a);
}

function sourceDiffs(a: Mix, b: Mix): z.infer<typeof sourceDiff>[] {
  const keys = new Set([...a.raw.bySource.keys(), ...b.raw.bySource.keys()]);
  const rows: z.infer<typeof sourceDiff>[] = [];
  for (const key of keys) {
    const amwh = a.raw.bySource.get(key) ?? 0;
    const bmwh = b.raw.bySource.get(key) ?? 0;
    if (round1(amwh / 1000) === 0 && round1(bmwh / 1000) === 0) continue;
    const ashare = a.raw.totalMWh > 0 ? (100 * amwh) / a.raw.totalMWh : 0;
    const bshare = b.raw.totalMWh > 0 ? (100 * bmwh) / b.raw.totalMWh : 0;
    rows.push({
      key,
      name: findSeries(key)!.name.replace(/^Generation: /, ""),
      a_gwh: round1(amwh / 1000),
      b_gwh: round1(bmwh / 1000),
      delta_gwh: round1((bmwh - amwh) / 1000),
      a_share_pct: round1(ashare),
      b_share_pct: round1(bshare),
      delta_share_pp: round1(bshare - ashare),
    });
  }
  return rows.sort((x, y) => Math.abs(y.delta_gwh) - Math.abs(x.delta_gwh));
}

export function registerComparePeriods(server: McpServer, client: SmardClient): void {
  server.registerTool(
    "compare_periods",
    {
      title: "Compare two periods",
      description:
        "Compares two periods: generation mix, renewable share, consumption and, for region DE, the mean day-ahead price (DE-LU). " +
        "Differences are period B minus period A, in GWh, percentage points (pp) and EUR/MWh. " +
        "Each period uses hourly values up to 8 weeks and daily values above. " +
        "For periods of different length compare shares and average load rather than GWh.",
      inputSchema: {
        period_a_from: z.string().describe("Start of period A (inclusive), YYYY-MM-DD or ISO 8601 date-time."),
        period_a_to: z.string().optional().describe("End of period A (exclusive; a plain date includes that day). Default: end of the start day."),
        period_b_from: z.string().describe("Start of period B (inclusive)."),
        period_b_to: z.string().optional().describe("End of period B (exclusive; a plain date includes that day)."),
        region: z.enum(MIX_REGIONS).default("DE").describe("Germany or one of the four transmission system operator zones."),
      },
      outputSchema: outputShape,
      annotations: { title: "Compare two periods", ...READ_ONLY_REMOTE },
    },
    async ({ period_a_from, period_a_to, period_b_from, period_b_to, region }) =>
      guarded(async () => {
        const rangeA = parseRange(period_a_from, period_a_to);
        const rangeB = parseRange(period_b_from, period_b_to);
        const [a, b] = await Promise.all([
          loadMix(client, region, rangeA.from, rangeA.to, Date.now(), "Period A: "),
          loadMix(client, region, rangeB.from, rangeB.to, Date.now(), "Period B: "),
        ]);
        const withPrice = region === "DE";
        const [priceA, priceB] = withPrice ? await Promise.all([averagePrice(client, a.data), averagePrice(client, b.data)]) : [null, null];

        const period = (p: typeof a, price: number | null) => {
          const meta = metaOf(p.data, region);
          const { raw: _raw, ...mix } = p.mix;
          return {
            from: meta.from,
            to: meta.to,
            resolution: meta.resolution,
            covered_until: meta.covered_until,
            complete: meta.complete,
            data_until: meta.data_until,
            ...mix,
            ...(withPrice ? { average_price_eur_mwh: price === null ? null : round1(price) } : {}),
          };
        };

        const notes = [...a.data.notes.map((n) => `Period A: ${n}`), ...b.data.notes.map((n) => `Period B: ${n}`)];
        const lenA = a.data.to - a.data.from;
        const lenB = b.data.to - b.data.from;
        if (Math.abs(lenA - lenB) > 0.01 * Math.max(lenA, lenB)) {
          notes.push(
            `The periods differ in length (${fmt1(lenA / 86_400_000)} vs ${fmt1(lenB / 86_400_000)} days); compare shares and average load rather than GWh.`,
          );
        }

        const ma = a.mix;
        const mb = b.mix;
        const result = {
          region,
          period_a: period(a, priceA),
          period_b: period(b, priceB),
          differences: {
            total_generation_gwh: round1((mb.raw.totalMWh - ma.raw.totalMWh) / 1000),
            renewable_gwh: round1((mb.raw.renewableMWh - ma.raw.renewableMWh) / 1000),
            renewable_share_pp: diff(share(ma.raw.renewableMWh, ma.raw.totalMWh), share(mb.raw.renewableMWh, mb.raw.totalMWh)),
            consumption_gwh: ma.raw.loadMWh === null || mb.raw.loadMWh === null ? null : round1((mb.raw.loadMWh - ma.raw.loadMWh) / 1000),
            consumption_pct: relative(ma.raw.loadMWh, mb.raw.loadMWh),
            generation_to_consumption_pp: diff(share(ma.raw.totalMWh, ma.raw.loadMWh), share(mb.raw.totalMWh, mb.raw.loadMWh)),
            ...(withPrice
              ? {
                  average_price_eur_mwh: priceA === null || priceB === null ? null : round1(priceB - priceA),
                  average_price_pct: relative(priceA, priceB),
                }
              : {}),
            sources: sourceDiffs(ma, mb),
          },
          notes,
          source: ATTRIBUTION,
        };
        return toolResult(compareText(result), result);
      }),
  );
}

type CompareResult = {
  region: string;
  period_a: { from: string; to: string; renewable_share_pct: number | null; total_generation_gwh: number; consumption_gwh: number | null; average_price_eur_mwh?: number | null };
  period_b: { from: string; to: string; renewable_share_pct: number | null; total_generation_gwh: number; consumption_gwh: number | null; average_price_eur_mwh?: number | null };
  differences: { renewable_share_pp: number | null; consumption_pct: number | null; average_price_eur_mwh?: number | null; sources: z.infer<typeof sourceDiff>[] };
  notes: string[];
  source: string;
};

function compareText(r: CompareResult): string {
  const signed = (n: number | null | undefined, unit: string) => (n === null || n === undefined ? "n/a" : `${n > 0 ? "+" : ""}${fmt1(n)}${unit}`);
  const pct = (n: number | null) => (n === null ? "n/a" : `${fmt1(n)} %`);
  const lines = [
    `Comparison ${r.region}: A = ${r.period_a.from} to ${r.period_a.to}, B = ${r.period_b.from} to ${r.period_b.to} (differences B minus A).`,
    `Renewable share: A ${pct(r.period_a.renewable_share_pct)}, B ${pct(r.period_b.renewable_share_pct)} (${signed(r.differences.renewable_share_pp, " pp")}).`,
    `Generation: A ${fmt1(r.period_a.total_generation_gwh)} GWh, B ${fmt1(r.period_b.total_generation_gwh)} GWh.`,
    `Consumption: A ${r.period_a.consumption_gwh === null ? "n/a" : fmt1(r.period_a.consumption_gwh) + " GWh"}, B ${r.period_b.consumption_gwh === null ? "n/a" : fmt1(r.period_b.consumption_gwh) + " GWh"} (${signed(r.differences.consumption_pct, " %")}).`,
  ];
  if (r.period_a.average_price_eur_mwh !== undefined) {
    const p = (n: number | null | undefined) => (n === null || n === undefined ? "n/a" : `${fmt1(n)} EUR/MWh`);
    lines.push(
      `Mean day-ahead price DE-LU: A ${p(r.period_a.average_price_eur_mwh)}, B ${p(r.period_b.average_price_eur_mwh)} (${signed(r.differences.average_price_eur_mwh, " EUR/MWh")}).`,
    );
  }
  lines.push("Largest changes by source:");
  for (const s of r.differences.sources.slice(0, 6)) {
    lines.push(`- ${s.name}: ${fmt1(s.a_gwh)} -> ${fmt1(s.b_gwh)} GWh (${signed(s.delta_gwh, " GWh")}, share ${signed(s.delta_share_pp, " pp")})`);
  }
  for (const n of r.notes) lines.push(`Note: ${n}`);
  lines.push(`Source: ${r.source}`);
  return lines.join("\n");
}
