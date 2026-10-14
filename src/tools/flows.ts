/** get_cross_border_flows: electricity exchanged with neighbouring countries. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { chooseResolution, fetchAligned, noDataText, sum, type AlignedData } from "../analysis.js";
import { borderSeriesKey, type Region } from "../catalog.js";
import type { DataPoint, SmardClient } from "../smard.js";
import { FLOW_KINDS, NET_EXPORT_KEYS, bordersOf, countryKeys, countryNetPoints, type FlowKind } from "../flows-data.js";
import { formatBerlin } from "../time.js";
import { InputError, READ_ONLY_REMOTE, fmt1, guarded, round1, toolResult, commonFields } from "./common.js";
import { MIX_REGIONS, coverageText, energyText, metaOf, metaShape } from "./generation-mix.js";
import { parseRange } from "./range.js";

export { FLOW_KINDS, type FlowKind } from "../flows-data.js";

const KIND_NOTE: Record<FlowKind, string> = {
  physical:
    "Physical flows are the electricity that actually crossed the borders (measured), including transit and loop flows.",
  commercial:
    "Commercial exchanges are the scheduled cross-border trades; they reach the end of the current day and can differ from the physical flows.",
};
const TSO_NOTE =
  "For a TSO zone only the borders of that zone to other countries count; exchanges between the German zones are not included, so the zones' net exports add up to Germany's.";

const countrySchema = z.object({
  code: z.string(),
  name: z.string(),
  export_gwh: z.number(),
  import_gwh: z.number().describe("Imports as a positive number"),
  net_export_gwh: z.number().describe("Exports minus imports; negative = net import"),
});
const peakSchema = z.object({ time: z.string(), gw: z.number() });
const intervalSchema = z.object({
  time: z.string(),
  export_gwh: z.number(),
  import_gwh: z.number().describe("Imports as a positive number"),
  net_export_gwh: z.number(),
});

/** Upper bound on rows in `intervals`. */
const MAX_INTERVALS = 2000;

const outputShape = {
  ...commonFields,
  ...metaShape,
  kind: z.enum(FLOW_KINDS),
  hours: z.number(),
  net_export_gwh: z.number().describe("Exports minus imports across all borders; negative = net import"),
  exports_gwh: z.number(),
  imports_gwh: z.number().describe("Imports as a positive number"),
  countries: z.array(countrySchema).describe("Per neighbouring country (or bidding zone), largest net flow first"),
  peak_net_import: peakSchema.nullable().describe("Hour with the largest net import (average GW, as a positive number); hourly resolution only"),
  peak_net_export: peakSchema.nullable().describe("Hour with the largest net export (average GW); hourly resolution only"),
  intervals_of: z.string().optional().describe("What intervals refer to: a country code, or all for all borders"),
  intervals: z.array(intervalSchema).optional().describe("Values per interval (hour or day), only on request"),
};

type Result = z.infer<z.ZodObject<typeof outputShape>>;

/** Series keys needed for one region and kind: the net series plus export/import per border. */
export function flowKeys(region: Region, kind: FlowKind): string[] {
  return [NET_EXPORT_KEYS[kind], ...countryKeys(region, kind)];
}

const pointsOf = (data: AlignedData, key: string): DataPoint[] => data.series.find((s) => s.info.key === key)?.points ?? [];

/**
 * Pure computation over aligned flow data. Net export and peak hours come
 * from the country series, which exist for the whole SMARD period; SMARD's
 * net series is only used to cross-check where it covers the range.
 */
export function summarizeFlows(data: AlignedData, region: Region, kind: FlowKind) {
  const countries = bordersOf(region)
    .map((b) => {
      const exp = sum(pointsOf(data, borderSeriesKey(region, b.code, kind, "export")));
      const imp = -sum(pointsOf(data, borderSeriesKey(region, b.code, kind, "import")));
      return { code: b.code, name: b.name, exportMWh: exp, importMWh: imp };
    })
    .sort((a, b) => Math.abs(b.exportMWh - b.importMWh) - Math.abs(a.exportMWh - a.importMWh));
  const net = countryNetPoints(data, region, kind);
  const netMWh = sum(net);
  const exportsMWh = countries.reduce((a, c) => a + c.exportMWh, 0);
  const importsMWh = countries.reduce((a, c) => a + c.importMWh, 0);
  let peakImport: DataPoint | null = null;
  let peakExport: DataPoint | null = null;
  if (data.resolution !== "day") {
    for (const p of net) {
      if (!peakImport || p.value < peakImport.value) peakImport = p;
      if (!peakExport || p.value > peakExport.value) peakExport = p;
    }
  }
  const official = pointsOf(data, NET_EXPORT_KEYS[kind]);
  const officialCovers = official.length > 0 && official.length >= net.length && official[0]!.timestamp <= (net[0]?.timestamp ?? Infinity);
  return { countries, netMWh, exportsMWh, importsMWh, peakImport, peakExport, officialNetMWh: officialCovers ? sum(official) : null, hasData: net.length > 0 };
}

/** Export, import and net per timestamp for the given borders (all borders of the region by default). */
export function flowIntervals(data: AlignedData, region: Region, kind: FlowKind, code?: string) {
  const byTime = new Map<number, { exp: number; imp: number }>();
  for (const b of bordersOf(region)) {
    if (code && b.code !== code) continue;
    for (const direction of ["export", "import"] as const) {
      for (const p of pointsOf(data, borderSeriesKey(region, b.code, kind, direction))) {
        const row = byTime.get(p.timestamp) ?? { exp: 0, imp: 0 };
        if (direction === "export") row.exp += p.value;
        else row.imp -= p.value;
        byTime.set(p.timestamp, row);
      }
    }
  }
  const r3 = (n: number) => Math.round(n) / 1000 + 0;
  return [...byTime]
    .sort((a, b) => a[0] - b[0])
    .map(([t, v]) => ({ time: formatBerlin(t), export_gwh: r3(v.exp), import_gwh: r3(v.imp), net_export_gwh: r3(v.exp - v.imp) }));
}

export function registerCrossBorderFlows(server: McpServer, client: SmardClient): void {
  server.registerTool(
    "get_cross_border_flows",
    {
      title: "Cross-border electricity flows",
      description:
        "Electricity exchanged with neighbouring countries for a period: net export (negative = net import), total exports and imports, " +
        "and per country, plus the hours with the largest net import and export. " +
        "kind physical (default) = what actually flowed across the borders (measured, about 1 to 2 hours behind real time); " +
        "kind commercial = scheduled cross-border trades (available until the end of the current day). " +
        "For TSO zones only their borders to other countries count, not exchanges between the German zones. " +
        "Hourly values up to 8 weeks, daily values above. Without from/to: yesterday. " +
        "include_intervals=true adds the values per hour (or day), for all borders or, with country, for one neighbour, e.g. 'How much power came from France each hour last week?'.",
      inputSchema: {
        from: z.string().optional().describe("Start (inclusive), YYYY-MM-DD or ISO 8601 date-time (Berlin time if no offset). Default: yesterday."),
        to: z.string().optional().describe("End (exclusive); a plain YYYY-MM-DD includes that day. Default: end of the from day."),
        region: z.enum(MIX_REGIONS).default("DE").describe("Germany or one of the four transmission system operator zones."),
        kind: z.enum(FLOW_KINDS).default("physical").describe("physical = measured flows, commercial = scheduled trades."),
        country: z
          .string()
          .optional()
          .describe("Code of one neighbour as in the countries list (e.g. FR, AT, NL; TSO zones: e.g. DK1, SE4); its values per interval."),
        include_intervals: z.boolean().default(false).describe("Add values per interval (hour or day). Implied by country."),
      },
      outputSchema: outputShape,
      annotations: { title: "Cross-border electricity flows", ...READ_ONLY_REMOTE },
    },
    async ({ from, to, region, kind, country, include_intervals }) =>
      guarded(async () => {
        const code = country?.trim().toUpperCase();
        if (code && !bordersOf(region).some((b) => b.code === code)) {
          throw new InputError(`${region} has no border "${country}". Codes: ${bordersOf(region).map((b) => b.code).join(", ")}.`);
        }
        const range = parseRange(from, to);
        const resolution = chooseResolution(range.from, range.to);
        const data = await fetchAligned(client, flowKeys(region, kind), region, range.from, range.to, resolution);
        if (data.dataUntil === null) {
          throw new InputError(await noDataText(client, countryKeys(region, kind)[0]!, region, resolution, range));
        }
        const s = summarizeFlows(data, region, kind);
        const notes = [...data.notes, KIND_NOTE[kind]];
        if (region !== "DE") notes.push(TSO_NOTE);
        // SMARD's net series should equal the sum of the country series; say so if they disagree noticeably.
        const gap = s.officialNetMWh === null ? 0 : Math.abs(s.officialNetMWh - s.netMWh);
        if (gap > Math.max(1000, 0.02 * (s.exportsMWh + s.importsMWh))) {
          notes.push(`SMARD's net series differs from the sum of the country series by ${fmt1(gap / 1000)} GWh.`);
        }
        // MWh per hour = average MW; reported as GW magnitude.
        const peak = (p: DataPoint | null) => (p ? { time: formatBerlin(p.timestamp), gw: round1(Math.abs(p.value) / 1000) + 0 } : null);
        const hours = data.coveredUntil === null ? 0 : (data.coveredUntil - data.from) / 3_600_000;
        let intervals: Result["intervals"];
        if (code || include_intervals) {
          const rows = flowIntervals(data, region, kind, code);
          if (rows.length > MAX_INTERVALS) {
            notes.push(`The ${rows.length} single values are not listed (limit ${MAX_INTERVALS}); use a shorter range.`);
          } else intervals = rows;
        }
        const result: Result = {
          ...metaOf(data, region),
          notes,
          kind,
          hours: round1(hours),
          net_export_gwh: round1(s.netMWh / 1000) + 0,
          exports_gwh: round1(s.exportsMWh / 1000) + 0,
          imports_gwh: round1(s.importsMWh / 1000) + 0,
          countries: s.countries.map((c) => ({
            code: c.code,
            name: c.name,
            export_gwh: round1(c.exportMWh / 1000) + 0,
            import_gwh: round1(c.importMWh / 1000) + 0,
            net_export_gwh: round1((c.exportMWh - c.importMWh) / 1000) + 0,
          })),
          peak_net_import: s.peakImport && s.peakImport.value < 0 ? peak(s.peakImport) : null,
          peak_net_export: s.peakExport && s.peakExport.value > 0 ? peak(s.peakExport) : null,
          ...(intervals ? { intervals_of: code ?? "all", intervals } : {}),
        };
        return toolResult(flowsText(result), result);
      }),
  );
}

function flowsText(r: Result): string {
  const dir = (net: number) => (net < 0 ? `net import ${energyText(-net)}` : `net export ${energyText(net)}`);
  const lines = [
    `Cross-border ${r.kind} flows ${r.region}, ${r.from} to ${r.to} (${r.resolution} values, ${fmt1(r.hours)} hours, ${coverageText(r)}):`,
    `${dir(r.net_export_gwh)[0]!.toUpperCase()}${dir(r.net_export_gwh).slice(1)}; exports ${energyText(r.exports_gwh)}, imports ${energyText(r.imports_gwh)}.`,
    ...r.countries.map((c) => `- ${c.name}: export ${fmt1(c.export_gwh)}, import ${fmt1(c.import_gwh)}, ${dir(c.net_export_gwh)}`),
  ];
  if (r.peak_net_import) lines.push(`Largest net import: ${fmt1(r.peak_net_import.gw)} GW at ${r.peak_net_import.time}.`);
  if (r.peak_net_export) lines.push(`Largest net export: ${fmt1(r.peak_net_export.gw)} GW at ${r.peak_net_export.time}.`);
  if (r.intervals) {
    const name = r.intervals_of === "all" ? "all borders" : (r.countries.find((c) => c.code === r.intervals_of)?.name ?? r.intervals_of);
    lines.push(`Per ${r.resolution === "day" ? "day" : "hour"}, ${name} (time: export, import, net export in GWh):`);
    for (const i of r.intervals) lines.push(`${i.time}: ${i.export_gwh}, ${i.import_gwh}, ${i.net_export_gwh}`);
  }
  for (const n of r.notes) lines.push(`Note: ${n}`);
  lines.push(`Source: ${r.source}`);
  return lines.join("\n");
}
