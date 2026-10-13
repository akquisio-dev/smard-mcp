/** compare_periods: generation mix, consumption and price of two periods side by side. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { INTERVAL_MS, PRICE_KEY, mean, type AlignedData } from "../analysis.js";
import { ATTRIBUTION, findSeries } from "../catalog.js";
import type { SmardClient } from "../smard.js";
import { berlinDayFloor, formatBerlin } from "../time.js";
import { READ_ONLY_REMOTE, fmt1, guarded, round1, round2, toolResult } from "./common.js";
import { MIX_REGIONS, coverageText, energyText, loadMix, metaOf, mixShape, signed, sourceName, type Mix } from "./generation-mix.js";
import { parseRange } from "./range.js";

const NO_REGIONAL_PRICE =
  "There is no regional price: day-ahead prices exist only for the DE-LU bidding zone. Use region DE (or analyze_prices) for prices.";

const periodShape = {
  label: z.string().describe("Human-readable period, e.g. 2025-10-01 to 2025-10-31"),
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
      average_load_gw: z.number().nullable(),
      generation_to_consumption_pp: z.number().nullable(),
      balance_gwh: z.number().nullable(),
      hours: z.number(),
      average_price_eur_mwh: z.number().nullable().optional(),
      average_price_pct: z.number().nullable().optional(),
      sources: z.array(sourceDiff).describe("Every source with generation in at least one period, largest absolute change first"),
    })
    .describe("Change from period A to period B (B minus A)"),
  notes: z.array(z.string()),
  source: z.string(),
};

type Period = z.infer<z.ZodObject<typeof periodShape>>;
type Result = z.infer<z.ZodObject<typeof outputShape>>;

/** Mean DE-LU day-ahead price over the interval the mix data covers. */
async function averagePrice(client: SmardClient, data: AlignedData): Promise<number | null> {
  if (data.coveredUntil === null) return null;
  const info = findSeries(PRICE_KEY)!;
  // Daily price values are the mean of the hourly prices of that day.
  const points = await client.getRange(info.filter, "DE", data.resolution, data.from, data.coveredUntil, { maxBlocks: 12 });
  return mean(points.map((p) => p.value));
}

/** "2025-10-12", "2025-10-01 to 2025-10-31" or exact times if not whole days. */
export function periodLabel(from: number, to: number): string {
  const date = (ms: number) => formatBerlin(ms).slice(0, 10);
  if (berlinDayFloor(from) !== from || berlinDayFloor(to) !== to) return `${formatBerlin(from)} to ${formatBerlin(to)}`;
  const lastDay = date(to - 1);
  return date(from) === lastDay ? date(from) : `${date(from)} to ${lastDay}`;
}

/** Difference of unrounded values, rounded only at the end. */
function diff(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : round1(b - a) + 0;
}

function relative(a: number | null, b: number | null): number | null {
  return a === null || b === null || a === 0 ? null : round1((100 * (b - a)) / a) + 0;
}

function share(part: number, whole: number | null): number | null {
  return whole ? (100 * part) / whole : null;
}

function sourceDiffs(a: Mix, b: Mix): z.infer<typeof sourceDiff>[] {
  const keys = new Set([...a.raw.bySource.keys(), ...b.raw.bySource.keys()]);
  const rows: z.infer<typeof sourceDiff>[] = [];
  for (const key of keys) {
    const amwh = a.raw.bySource.get(key) ?? 0;
    const bmwh = b.raw.bySource.get(key) ?? 0;
    if (round1(amwh / 1000) === 0 && round1(bmwh / 1000) === 0) continue;
    const ashare = share(amwh, a.raw.totalMWh) ?? 0;
    const bshare = share(bmwh, b.raw.totalMWh) ?? 0;
    rows.push({
      key,
      name: findSeries(key)!.name.replace(/^Generation: /, ""),
      a_gwh: round1(amwh / 1000),
      b_gwh: round1(bmwh / 1000),
      delta_gwh: round1((bmwh - amwh) / 1000) + 0,
      a_share_pct: round1(ashare),
      b_share_pct: round1(bshare),
      delta_share_pp: round1(bshare - ashare) + 0,
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
        "Compares two periods: generation per source, total generation, renewable share, consumption, average load, " +
        "generation in % of / minus consumption, hours covered and, for region DE, the mean day-ahead price (DE-LU). " +
        "Differences describe the change from period A to period B (B minus A) in GWh, percentage points (pp), GW and EUR/MWh; " +
        "use A for the baseline, usually the older period. " +
        "Each period uses hourly values up to 8 weeks and daily values above. " +
        "For periods of different length compare shares and average load rather than GWh.",
      inputSchema: {
        period_a_from: z.string().describe("Start of period A, the baseline (inclusive), YYYY-MM-DD or ISO 8601 date-time."),
        period_a_to: z.string().optional().describe("End of period A (exclusive; a plain date includes that day). Default: end of the start day."),
        period_b_from: z.string().describe("Start of period B, compared against A (inclusive)."),
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

        const period = (p: typeof a, price: number | null): Period => {
          const meta = metaOf(p.data, region);
          const { raw: _raw, ...mix } = p.mix;
          return {
            label: periodLabel(p.data.from, p.data.to),
            from: meta.from,
            to: meta.to,
            resolution: meta.resolution,
            covered_until: meta.covered_until,
            complete: meta.complete,
            data_until: meta.data_until,
            ...mix,
            ...(withPrice ? { average_price_eur_mwh: price === null ? null : round2(price) } : {}),
          };
        };

        const notes = [...a.data.notes.map((n) => `Period A: ${n}`), ...b.data.notes.map((n) => `Period B: ${n}`)];
        if (Math.abs(a.mix.hours - b.mix.hours) > 0.01 * Math.max(a.mix.hours, b.mix.hours)) {
          notes.push(`The periods differ in length (${fmt1(a.mix.hours)} vs ${fmt1(b.mix.hours)} hours); compare shares and average load rather than GWh.`);
        }
        if (!withPrice) notes.push(NO_REGIONAL_PRICE);

        const ma = a.mix;
        const mb = b.mix;
        const result: Result = {
          region,
          period_a: period(a, priceA),
          period_b: period(b, priceB),
          differences: {
            total_generation_gwh: round1((mb.raw.totalMWh - ma.raw.totalMWh) / 1000) + 0,
            renewable_gwh: round1((mb.raw.renewableMWh - ma.raw.renewableMWh) / 1000) + 0,
            renewable_share_pp: diff(share(ma.raw.renewableMWh, ma.raw.totalMWh), share(mb.raw.renewableMWh, mb.raw.totalMWh)),
            consumption_gwh: ma.raw.loadMWh === null || mb.raw.loadMWh === null ? null : round1((mb.raw.loadMWh - ma.raw.loadMWh) / 1000) + 0,
            consumption_pct: relative(ma.raw.loadMWh, mb.raw.loadMWh),
            average_load_gw:
              ma.raw.loadMWh === null || mb.raw.loadMWh === null || ma.hours === 0 || mb.hours === 0
                ? null
                : diff(ma.raw.loadMWh / 1000 / ma.hours, mb.raw.loadMWh / 1000 / mb.hours),
            generation_to_consumption_pp: diff(share(ma.raw.totalMWh, ma.raw.loadMWh), share(mb.raw.totalMWh, mb.raw.loadMWh)),
            balance_gwh:
              ma.raw.loadMWh === null || mb.raw.loadMWh === null
                ? null
                : diff((ma.raw.totalMWh - ma.raw.loadMWh) / 1000, (mb.raw.totalMWh - mb.raw.loadMWh) / 1000),
            hours: round1(mb.hours - ma.hours) + 0,
            ...(withPrice
              ? {
                  average_price_eur_mwh: priceA === null || priceB === null ? null : round2(priceB - priceA) + 0,
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

function compareText(r: Result): string {
  const { period_a: a, period_b: b, differences: d } = r;
  const pct = (n: number | null) => (n === null ? "n/a" : `${fmt1(n)} %`);
  const opt = (n: number | null, unit: string) => (n === null ? "n/a" : signed(n, unit));
  const gw = (n: number | null) => (n === null ? "n/a" : `${fmt1(n)} GW`);
  const gwh = (n: number | null) => (n === null ? "n/a" : energyText(n));
  const eur = (n: number | null | undefined) => (n === null || n === undefined ? "n/a" : `${n.toFixed(2)} EUR/MWh`);

  const lines = [
    `Comparison ${r.region}. A = ${a.label} (${fmt1(a.hours)} hours, ${coverageText(a)}), B = ${b.label} (${fmt1(b.hours)} hours, ${coverageText(b)}).`,
    `Changes are from A to B (B minus A).`,
    `Total generation: A ${energyText(a.total_generation_gwh)}, B ${energyText(b.total_generation_gwh)} (${signed(d.total_generation_gwh, " GWh")}).`,
    `Renewable share: A ${pct(a.renewable_share_pct)}, B ${pct(b.renewable_share_pct)} (${opt(d.renewable_share_pp, " pp")}).`,
    `Consumption: A ${gwh(a.consumption_gwh)}, B ${gwh(b.consumption_gwh)} (${opt(d.consumption_pct, " %")}).`,
    `Average load: A ${gw(a.average_load_gw)}, B ${gw(b.average_load_gw)} (${opt(d.average_load_gw, " GW")}).`,
    `Generation in % of consumption: A ${pct(a.generation_to_consumption_pct)}, B ${pct(b.generation_to_consumption_pct)} (${opt(d.generation_to_consumption_pp, " pp")}).`,
    `Generation minus consumption (indicator, not the physical export): A ${opt(a.balance_gwh, " GWh")}, B ${opt(b.balance_gwh, " GWh")}.`,
  ];
  if (a.average_price_eur_mwh !== undefined) {
    const delta = d.average_price_eur_mwh;
    lines.push(
      `Mean day-ahead price DE-LU: A ${eur(a.average_price_eur_mwh)}, B ${eur(b.average_price_eur_mwh)} (${delta === null || delta === undefined ? "n/a" : `${delta > 0 ? "+" : ""}${delta.toFixed(2)} EUR/MWh`}, ${opt(d.average_price_pct ?? null, " %")}).`,
    );
  }
  lines.push("Generation by source, A -> B:");
  for (const s of d.sources) {
    lines.push(`- ${s.name}: ${energyText(s.a_gwh)} -> ${energyText(s.b_gwh)} (${signed(s.delta_gwh, " GWh")}; share ${fmt1(s.a_share_pct)} % -> ${fmt1(s.b_share_pct)} %, ${signed(s.delta_share_pp, " pp")})`);
  }
  const without = a.sources_without_data.filter((k) => b.sources_without_data.includes(k));
  if (without.length > 0) lines.push(`No generation in either period: ${without.map(sourceName).join(", ")}.`);
  for (const n of r.notes) lines.push(`Note: ${n}`);
  lines.push(`Source: ${r.source}`);
  return lines.join("\n");
}
