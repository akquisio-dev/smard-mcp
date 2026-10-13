/**
 * Smoke test against the live SMARD API (`npm run smoke`).
 *
 * SMARD's chart_data API is unofficial and may change. This checks, for a
 * few core series, that index and newest block load through our client,
 * have the expected shape, contain plausible values and are recent.
 * Exits with code 1 on any failure, so a scheduled CI run turns red.
 */

import { SmardClient } from "./smard.js";
import type { Region, Resolution } from "./catalog.js";

const HOUR = 3_600_000;

interface Check {
  name: string;
  filter: number;
  region: Region;
  resolution: Resolution;
  /** Plausible range of single values. */
  min: number;
  max: number;
  /** The newest value must not be older than this. */
  maxAgeMs: number;
  /** Expected distance between consecutive timestamps. */
  stepMs: number;
}

const CHECKS: Check[] = [
  { name: "generation solar (4068)", filter: 4068, region: "DE", resolution: "hour", min: 0, max: 80_000, maxAgeMs: 48 * HOUR, stepMs: HOUR },
  { name: "consumption total (410)", filter: 410, region: "DE", resolution: "hour", min: 20_000, max: 100_000, maxAgeMs: 48 * HOUR, stepMs: HOUR },
  { name: "day-ahead price DE-LU (4169)", filter: 4169, region: "DE", resolution: "hour", min: -500, max: 4_000, maxAgeMs: 48 * HOUR, stepMs: HOUR },
  { name: "day-ahead price DE-LU, 15 min (4169)", filter: 4169, region: "DE", resolution: "quarterhour", min: -500, max: 4_000, maxAgeMs: 48 * HOUR, stepMs: HOUR / 4 },
  { name: "forecast solar (125)", filter: 125, region: "DE", resolution: "hour", min: 0, max: 80_000, maxAgeMs: 48 * HOUR, stepMs: HOUR },
  { name: "consumption total, daily (410)", filter: 410, region: "DE", resolution: "day", min: 500_000, max: 2_500_000, maxAgeMs: 72 * HOUR, stepMs: 0 },
];

async function run(check: Check, client: SmardClient, now: number): Promise<string[]> {
  const problems: string[] = [];
  const index = await client.getIndex(check.filter, check.region, check.resolution);
  if (index.length === 0) return ["index is empty"];
  if (index.some((t, i) => i > 0 && t <= index[i - 1]!)) problems.push("index timestamps are not increasing");

  // The newest block may still be empty (e.g. a new week), so look one further back as well.
  let points: { timestamp: number; value: number }[] = [];
  for (const start of index.slice(-2).reverse()) {
    points = await client.getBlock(check.filter, check.region, check.resolution, start);
    if (points.length > 0) break;
  }
  if (points.length === 0) return [...problems, "the two newest blocks contain no values"];

  const outside = points.filter((p) => p.value < check.min || p.value > check.max);
  if (outside.length > 0) problems.push(`${outside.length} values outside ${check.min}..${check.max}, e.g. ${outside[0]!.value}`);
  if (check.stepMs > 0) {
    // Null values are dropped, so gaps are fine as long as they stay on the grid.
    const gaps = points.filter((p, i) => {
      if (i === 0) return false;
      const d = p.timestamp - points[i - 1]!.timestamp;
      return d <= 0 || d % check.stepMs !== 0;
    });
    if (gaps.length > 0) problems.push(`${gaps.length} timestamps are not on a ${check.stepMs / 60_000}-minute grid`);
  }
  const newest = points[points.length - 1]!.timestamp;
  const ageH = (now - newest) / HOUR;
  if (now - newest > check.maxAgeMs) problems.push(`newest value is ${ageH.toFixed(1)} h old (limit ${check.maxAgeMs / HOUR} h)`);
  return problems;
}

async function main(): Promise<void> {
  // SMARD_BASE_URL allows pointing the check elsewhere, e.g. to prove that it fails.
  const client = new SmardClient({ cacheTtlMs: 0, archiveCacheTtlMs: 0, baseUrl: process.env.SMARD_BASE_URL || undefined });
  const now = Date.now();
  let failed = 0;
  for (const check of CHECKS) {
    let problems: string[];
    try {
      problems = await run(check, client, now);
    } catch (err) {
      problems = [err instanceof Error ? err.message : String(err)];
    }
    if (problems.length === 0) console.log(`ok    ${check.name}`);
    else {
      failed++;
      console.log(`FAIL  ${check.name}: ${problems.join("; ")}`);
    }
  }
  console.log(failed === 0 ? `All ${CHECKS.length} checks passed.` : `${failed} of ${CHECKS.length} checks failed.`);
  process.exitCode = failed === 0 ? 0 : 1;
}

await main();
