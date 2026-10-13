import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { createServer } from "../src/server.js";
import { SmardClient } from "../src/smard.js";

const HOUR = 3_600_000;
const B0 = Date.parse("2026-09-27T22:00:00Z");

async function connect(fetch: typeof globalThis.fetch) {
  const server = createServer(new SmardClient({ fetch }));
  const client = new Client({ name: "test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const fetch = vi.fn(async (url: string | URL | Request) => {
  const u = String(url);
  if (u.endsWith("/4169/DE/index_hour.json")) return new Response(JSON.stringify({ timestamps: [B0] }));
  if (u.endsWith(`/4169_DE_hour_${B0}.json`)) {
    return new Response(JSON.stringify({ series: [[B0, 100], [B0 + HOUR, 50.5], [B0 + 2 * HOUR, null]] }));
  }
  return new Response("", { status: 404 });
}) as unknown as typeof globalThis.fetch;

describe("MCP server", () => {
  it("exposes the two tools", async () => {
    const client = await connect(fetch);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["get_series", "list_series"]);
  });

  it("list_series filters by category", async () => {
    const client = await connect(fetch);
    const res = await client.callTool({ name: "list_series", arguments: { category: "price" } });
    const data = res.structuredContent as { series: { key: string; unit: string }[] };
    expect(data.series.length).toBeGreaterThan(5);
    expect(data.series.every((s) => s.unit === "EUR/MWh")).toBe(true);
  });

  it("get_series returns points and a summary", async () => {
    const client = await connect(fetch);
    const res = await client.callTool({
      name: "get_series",
      arguments: { series: "price_de_lu", from: "2026-09-28", to: "2026-09-28" },
    });
    expect(res.isError).toBeFalsy();
    const data = res.structuredContent as {
      unit: string;
      points: { time: string; value: number }[];
      summary: { mean: number; count: number };
    };
    expect(data.unit).toBe("EUR/MWh");
    expect(data.points).toEqual([
      { time: "2026-09-28T00:00:00+02:00", value: 100 },
      { time: "2026-09-28T01:00:00+02:00", value: 50.5 },
    ]);
    expect(data.summary).toMatchObject({ count: 2, mean: 75.25 });
  });

  it("get_series reports bad input as a tool error", async () => {
    const client = await connect(fetch);
    const res = await client.callTool({
      name: "get_series",
      arguments: { series: "price_de_lu", from: "2026-09-28", to: "2026-09-01" },
    });
    expect(res.isError).toBe(true);
  });

  it("get_series reports missing data from SMARD as a tool error", async () => {
    const client = await connect(fetch);
    const res = await client.callTool({ name: "get_series", arguments: { series: "price_de_lu", region: "AT" } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/no data for this combination/);
  });
});
