/**
 * Smoke test against the live SMARD API (`npm run smoke`).
 *
 * SMARD's chart_data API is unofficial and may change. This checks, for a
 * few core series, that index and newest block load through our client,
 * have the expected shape, contain plausible values and are recent.
 * It also checks that every series id of our catalog still exists in
 * SMARD's own module configuration, and, if SMOKE_ENDPOINT is set (e.g.
 * https://energie.akquisio.eu), that our public server answers: deep
 * health, MCP handshake, tool list and one tool call.
 * Exits with code 1 on any failure, so a scheduled CI run turns red.
 */

const CONFIG_URL = "https://www.smard.de/app/chart_configuration/market_data_configuration.json";

const EXPECTED_TOOLS = [
  "analyze_prices",
  "compare_periods",
  "find_best_hours",
  "get_co2_intensity",
  "get_cross_border_flows",
  "get_current_status",
  "get_generation_mix",
  "get_market_overview",
  "get_series",
  "list_series",
];

interface ModuleConfig {
  main: { sub?: { module: Record<string, { data_id: number; region: string[] }[]> }[] }[];
}

/** Every catalog id must exist in SMARD's module configuration for the region we use it with. */
async function checkCatalog(): Promise<string[]> {
  const res = await fetch(CONFIG_URL, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return [`module configuration: HTTP ${res.status}`];
  const config = (await res.json()) as ModuleConfig;
  const regions = new Map<number, Set<string>>();
  for (const cat of config.main) {
    for (const sub of cat.sub ?? []) {
      for (const modules of Object.values(sub.module)) {
        for (const m of modules) regions.set(m.data_id, new Set([...(regions.get(m.data_id) ?? []), ...m.region]));
      }
    }
  }
  if (regions.size < 100) return [`module configuration lists only ${regions.size} ids; format changed?`];
  const problems: string[] = [];
  for (const s of SERIES) {
    if (!regions.get(s.filter)?.has("DE")) problems.push(`${s.key} (${s.filter}) not offered for DE`);
  }
  const borderRegion = new Map(BORDERS.flatMap((b) => [b.physical.export, b.physical.import, b.commercial.export, b.commercial.import].map((id) => [id, b.region])));
  for (const s of BORDER_SERIES) {
    const region = borderRegion.get(s.filter)!;
    if (!regions.get(s.filter)?.has(region)) problems.push(`${s.key} (${s.filter}) not offered for ${region}`);
  }
  return problems;
}

/** Our own public endpoint: deep health, MCP handshake, tools, one call. */
async function checkEndpoint(base: string): Promise<string[]> {
  const problems: string[] = [];
  const health = await fetch(`${base}/health?deep=1`, { signal: AbortSignal.timeout(15_000) });
  const body = (await health.json().catch(() => ({}))) as { status?: string; version?: string };
  if (health.status !== 200 || body.status !== "ok") problems.push(`/health?deep=1 answered ${health.status} ${JSON.stringify(body)}`);
  const client = new Client({ name: "smard-mcp-smoke", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const version = client.getServerVersion()?.version;
    if (body.version && version !== body.version) problems.push(`MCP reports version ${version}, /health ${body.version}`);
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    const missing = EXPECTED_TOOLS.filter((t) => !tools.includes(t));
    if (missing.length > 0) problems.push(`tools missing: ${missing.join(", ")}`);
    const res = await client.callTool({ name: "get_generation_mix", arguments: {} });
    if (res.isError) problems.push(`get_generation_mix failed: ${JSON.stringify(res.content).slice(0, 200)}`);
  } finally {
    await client.close().catch(() => undefined);
  }
  return problems;
}

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { BORDER_SERIES, SERIES, type Region, type Resolution } from "./catalog.js";
import { BORDERS } from "./borders.js";
import { SmardClient } from "./smard.js";

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
  // get_current_status looks back 6 hours for quarter-hour values.
  { name: "generation solar, 15 min (4068)", filter: 4068, region: "DE", resolution: "quarterhour", min: 0, max: 20_000, maxAgeMs: 6 * HOUR, stepMs: HOUR / 4 },
  { name: "consumption total, 15 min (410)", filter: 410, region: "DE", resolution: "quarterhour", min: 5_000, max: 25_000, maxAgeMs: 6 * HOUR, stepMs: HOUR / 4 },
  { name: "consumption total (410)", filter: 410, region: "DE", resolution: "hour", min: 20_000, max: 100_000, maxAgeMs: 48 * HOUR, stepMs: HOUR },
  { name: "day-ahead price DE-LU (4169)", filter: 4169, region: "DE", resolution: "hour", min: -500, max: 4_000, maxAgeMs: 48 * HOUR, stepMs: HOUR },
  { name: "day-ahead price DE-LU, 15 min (4169)", filter: 4169, region: "DE", resolution: "quarterhour", min: -500, max: 4_000, maxAgeMs: 48 * HOUR, stepMs: HOUR / 4 },
  { name: "forecast solar (125)", filter: 125, region: "DE", resolution: "hour", min: 0, max: 80_000, maxAgeMs: 48 * HOUR, stepMs: HOUR },
  { name: "physical net export (4963)", filter: 4963, region: "DE", resolution: "hour", min: -30_000, max: 30_000, maxAgeMs: 48 * HOUR, stepMs: HOUR },
  { name: "intraday forecast wind and solar (5129)", filter: 5129, region: "DE", resolution: "quarterhour", min: 0, max: 40_000, maxAgeMs: 48 * HOUR, stepMs: HOUR / 4 },
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
  const extra: [string, () => Promise<string[]>][] = [["catalog ids in SMARD's module configuration", checkCatalog]];
  const endpoint = process.env.SMOKE_ENDPOINT?.replace(/\/+$/, "");
  if (endpoint) extra.push([`endpoint ${endpoint}`, () => checkEndpoint(endpoint)]);
  for (const [name, check] of extra) {
    let problems: string[];
    try {
      problems = await check();
    } catch (err) {
      problems = [err instanceof Error ? err.message : String(err)];
    }
    if (problems.length === 0) console.log(`ok    ${name}`);
    else {
      failed++;
      console.log(`FAIL  ${name}: ${problems.join("; ")}`);
    }
  }
  const total = CHECKS.length + extra.length;
  console.log(failed === 0 ? `All ${total} checks passed.` : `${failed} of ${total} checks failed.`);
  process.exitCode = failed === 0 ? 0 : 1;
}

await main();
