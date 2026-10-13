import { describe, expect, it, vi } from "vitest";
import { createFakeSmard } from "./fake-smard.js";
import { connect, textOf } from "./helpers.js";
import { SERVER_VERSION } from "../src/version.js";

const HOUR = 3_600_000;
const B0 = Date.parse("2026-09-27T22:00:00Z");

const fetch = vi.fn(async (url: string | URL | Request) => {
  const u = String(url);
  if (u.endsWith("/4169/DE/index_hour.json")) return new Response(JSON.stringify({ timestamps: [B0] }));
  if (u.endsWith(`/4169_DE_hour_${B0}.json`)) {
    return new Response(JSON.stringify({ series: [[B0, 100], [B0 + HOUR, 50.5], [B0 + 2 * HOUR, null]] }));
  }
  return new Response("", { status: 404 });
}) as unknown as typeof globalThis.fetch;

describe("MCP server", () => {
  it("exposes all tools", async () => {
    const client = await connect(fetch);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["get_series", "list_series"]));
  });

  it("list_series filters by category and reports the server time", async () => {
    const client = await connect(fetch);
    const res = await client.callTool({ name: "list_series", arguments: { category: "price" } });
    const data = res.structuredContent as { server_time: string; series: { key: string; unit: string; zone: string }[] };
    expect(data.series.length).toBeGreaterThan(5);
    expect(data.series.every((s) => s.unit === "EUR/MWh" && s.zone)).toBe(true);
    expect((data as unknown as { server: { version: string } }).server.version).toBe(SERVER_VERSION);
    expect(data.server_time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+0[12]:00$/);
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
      bidding_zone: string;
      data_until: string;
      covered_until: string;
      complete: boolean;
      points: { time: string; value: number }[];
      summary: { mean: number; count: number; sum?: number };
    };
    expect(data.unit).toBe("EUR/MWh");
    expect(data.bidding_zone).toBe("DE-LU");
    expect(data.points).toEqual([
      { time: "2026-09-28T00:00:00+02:00", value: 100 },
      { time: "2026-09-28T01:00:00+02:00", value: 50.5 },
    ]);
    expect(data.summary).toMatchObject({ count: 2, mean: 75.25 });
    expect(data.summary.sum).toBeUndefined();
    expect(data.data_until).toBe("2026-09-28T01:00:00+02:00");
    expect(data.covered_until).toBe("2026-09-28T02:00:00+02:00");
    expect(data.complete).toBe(false);
  });

  it("get_series reports bad input as a tool error", async () => {
    const client = await connect(fetch);
    const res = await client.callTool({
      name: "get_series",
      arguments: { series: "price_de_lu", from: "2026-09-28", to: "2026-09-01" },
    });
    expect(res.isError).toBe(true);
  });

  it("get_series rejects regional price queries", async () => {
    const client = await connect(fetch);
    const res = await client.callTool({ name: "get_series", arguments: { series: "price_de_lu", region: "50Hertz" } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/bidding zone DE-LU/);
  });

  it("get_series reports missing data from SMARD as a tool error", async () => {
    const client = await connect(fetch);
    const res = await client.callTool({ name: "get_series", arguments: { series: "generation_solar", region: "LU" } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/no data for this combination/);
  });
});

describe("get_series with realistic data", () => {
  const dataEnd = Date.parse("2026-10-13T10:00:00Z");
  const smard = createFakeSmard({
    dataEnd,
    series: {
      4068: { value: () => 1000 },
      // Forecast: published only up to the end of today.
      125: { value: (t) => (t < Date.parse("2026-10-13T22:00:00Z") ? 500 : null) },
    },
  });

  it("adds a sum for energy series and can omit the points", async () => {
    const client = await connect(smard.fetch);
    const res = await client.callTool({
      name: "get_series",
      arguments: { series: "generation_solar", from: "2026-10-12", to: "2026-10-12", include_points: false },
    });
    const data = res.structuredContent as { summary: { sum: number; count: number }; points?: unknown };
    expect(data.summary).toMatchObject({ count: 24, sum: 24000 });
    expect(data.points).toBeUndefined();
  });

  it("flags incomplete data", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-13T20:00:00Z"));
    try {
      const client = await connect(smard.fetch);
      const res = await client.callTool({
        name: "get_series",
        arguments: { series: "generation_solar", from: "2026-10-13", to: "2026-10-13" },
      });
      const data = res.structuredContent as { data_until: string; notes?: string[] };
      expect(data.data_until).toBe("2026-10-13T11:00:00+02:00");
      expect(data.notes?.join(" ")).toMatch(/incomplete/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("explains missing forecasts for tomorrow", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-13T10:00:00Z"));
    try {
      const client = await connect(smard.fetch);
      const res = await client.callTool({
        name: "get_series",
        arguments: { series: "forecast_generation_solar", from: "2026-10-14", to: "2026-10-14" },
      });
      expect(textOf(res)).toMatch(/forecasts for the next day during the course of the current day/);
    } finally {
      vi.useRealTimers();
    }
  });
});
