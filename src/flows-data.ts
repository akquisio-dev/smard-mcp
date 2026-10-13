/**
 * Cross-border flow data shared by get_cross_border_flows and the mix:
 * which series belong to a region, and the net export per timestamp summed
 * from the per-country series. SMARD's own physical net series (4963) only
 * starts on 24 September 2020, the country series reach back to 2015.
 */

import type { AlignedData } from "./analysis.js";
import { BORDERS, type Border } from "./borders.js";
import { borderSeriesKey, type Region } from "./catalog.js";
import type { DataPoint } from "./smard.js";

export const FLOW_KINDS = ["physical", "commercial"] as const;
export type FlowKind = (typeof FLOW_KINDS)[number];

export const NET_EXPORT_KEYS: Record<FlowKind, string> = {
  physical: "flow_physical_net_export",
  commercial: "flow_commercial_net_export",
};

export function bordersOf(region: Region): Border[] {
  return BORDERS.filter((b) => b.region === region);
}

/** Export and import series keys of every border of a region. */
export function countryKeys(region: Region, kind: FlowKind): string[] {
  return bordersOf(region).flatMap((b) => [borderSeriesKey(region, b.code, kind, "export"), borderSeriesKey(region, b.code, kind, "import")]);
}

/** Net export per timestamp (exports positive, imports negative) from the country series. */
export function countryNetPoints(data: AlignedData, region: Region, kind: FlowKind): DataPoint[] {
  const keys = new Set(countryKeys(region, kind));
  const byTime = new Map<number, number>();
  for (const s of data.series) {
    if (!keys.has(s.info.key)) continue;
    for (const p of s.points) byTime.set(p.timestamp, (byTime.get(p.timestamp) ?? 0) + p.value);
  }
  return [...byTime].sort((a, b) => a[0] - b[0]).map(([timestamp, value]) => ({ timestamp, value }));
}
