/**
 * Load test (run on demand: LOAD_TEST=1 npx vitest run test/load.test.ts).
 * 20 simultaneous expensive calls against a fake SMARD with 80 ms latency
 * and an empty cache; reports duration, requests to SMARD, the highest
 * number of parallel requests and memory.
 */

import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { SmardClient } from "../src/smard.js";
import { createFakeSmard, type FakeSeries } from "./fake-smard.js";

const series: Record<number, FakeSeries> = {};
for (const f of [1223, 1224, 1225, 1226, 1227, 1228, 4066, 4067, 4068, 4069, 4070, 4071, 410, 4963, 5097, 411]) {
  series[f] = { value: (t) => 1_000 + (t % 7_000) };
}
series[4169] = { value: (t) => 50 + (t % 300), aggregate: "mean" };

const CALLS: [string, Record<string, unknown>][] = [
  ["compare_periods", { period_a_from: "2024-01-01", period_a_to: "2024-12-31", period_b_from: "2025-01-01", period_b_to: "2026-09-30" }],
  ["analyze_prices", { from: "2025-10-13", to: "2026-10-11" }],
  ["get_co2_intensity", { from: "2026-08-17", to: "2026-10-11" }],
  ["find_best_hours", { date: "2026-10-12", resolution: "quarterhour", duration_hours: 4 }],
  ["get_market_overview", { date: "2026-10-12" }],
];

describe.skipIf(!process.env.LOAD_TEST)("load", () => {
  it("handles 20 simultaneous expensive calls", async () => {
    const smard = createFakeSmard({ dataEnd: Date.parse("2026-10-13T00:00:00Z"), series });
    let active = 0;
    let peak = 0;
    const fetch = (async (url: string | URL | Request) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 80));
      active--;
      return smard.fetch(url);
    }) as typeof globalThis.fetch;
    const smardClient = new SmardClient({ fetch });

    const clients = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const server = createServer(smardClient);
        const client = new Client({ name: "load", version: "0" });
        const [a, b] = InMemoryTransport.createLinkedPair();
        await Promise.all([server.connect(a), client.connect(b)]);
        return client;
      }),
    );
    global.gc?.();
    const heapBefore = process.memoryUsage().heapUsed;
    const started = Date.now();
    const durations = await Promise.all(
      clients.map(async (client, i) => {
        const [name, args] = CALLS[i % CALLS.length]!;
        const t = Date.now();
        const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
        expect(res.isError, JSON.stringify(res.content).slice(0, 200)).toBeFalsy();
        return { name, ms: Date.now() - t };
      }),
    );
    const total = Date.now() - started;
    const heapAfter = process.memoryUsage().heapUsed;
    const slowest = Object.entries(
      durations.reduce<Record<string, number>>((acc, d) => ({ ...acc, [d.name]: Math.max(acc[d.name] ?? 0, d.ms) }), {}),
    );
    console.log(
      [
        `total ${total} ms for ${durations.length} calls`,
        `requests to SMARD: ${smard.calls.length}, max parallel: ${peak}`,
        `heap +${((heapAfter - heapBefore) / 1e6).toFixed(1)} MB, rss ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB`,
        ...slowest.map(([n, ms]) => `  slowest ${n}: ${ms} ms`),
      ].join("\n"),
    );
    expect(peak).toBeLessThanOrEqual(5);
  }, 300_000);
});
