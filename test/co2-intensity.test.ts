import { describe, expect, it, vi } from "vitest";
import { createFakeSmard, type FakeSeries } from "./fake-smard.js";
import { connect, textOf } from "./helpers.js";

const HOUR = 3_600_000;
const hourOf = (t: number) => new Date(t + 2 * HOUR).getUTCHours(); // Berlin summer time is enough for these days

/**
 * Lignite 1 000 MWh every hour; solar 3 000 MWh from 10:00 to 15:59 Berlin,
 * else 0; nuclear without data. So the intensity is 992 at night and 248 at noon.
 */
function backend(dataEnd = "2026-10-13T08:00:00Z", extra: Record<number, FakeSeries> = {}) {
  const series: Record<number, FakeSeries> = {
    1223: { value: (_t, region) => (region === "TenneT" ? 500 : 1_000) },
    4068: { value: (t) => (hourOf(t) >= 10 && hourOf(t) < 16 ? 3_000 : 0) },
    1224: { value: () => null },
    410: { value: () => 5_000 },
    ...extra,
  };
  for (const f of [1225, 1226, 1227, 1228, 4066, 4067, 4069, 4070, 4071]) series[f] ??= { value: () => 0 };
  return createFakeSmard({ dataEnd: Date.parse(dataEnd), series });
}

interface Result {
  co2_intensity_g_per_kwh: number;
  total_emissions_t: number;
  total_generation_gwh: number;
  interval_unit: string;
  cleanest: { time: string; g_per_kwh: number }[];
  dirtiest: { time: string; g_per_kwh: number }[];
  intervals?: { time: string; g_per_kwh: number }[];
  by_source: { key: string; emissions_t: number; share_pct: number }[];
  complete: boolean;
  disclaimer: string;
  notes: string[];
}

async function co2(args: Record<string, unknown>, fetch = backend().fetch) {
  const client = await connect(fetch);
  const res = await client.callTool({ name: "get_co2_intensity", arguments: args });
  return { res, data: res.structuredContent as unknown as Result, text: textOf(res) };
}

describe("get_co2_intensity", () => {
  it("computes hourly intensities, the weighted mean and total emissions", async () => {
    const { res, data, text } = await co2({ from: "2026-10-12", top_n: 2 });
    expect(res.isError, text).toBeFalsy();
    expect(data.interval_unit).toBe("hour");
    expect(data.intervals).toHaveLength(24);
    // 24 h lignite = 24 000 MWh x 992 g/kWh = 23 808 t; generation 24 000 + 6 x 3 000 = 42 000 MWh
    expect(data.total_emissions_t).toBe(23_808);
    expect(data.total_generation_gwh).toBe(42);
    expect(data.co2_intensity_g_per_kwh).toBe(Math.round(23_808_000 / 42_000));
    expect(data.cleanest).toEqual([
      { time: "2026-10-12T10:00:00+02:00", g_per_kwh: 248 },
      { time: "2026-10-12T11:00:00+02:00", g_per_kwh: 248 },
    ]);
    expect(data.dirtiest[0]).toEqual({ time: "2026-10-12T00:00:00+02:00", g_per_kwh: 992 });
    expect(data.by_source).toEqual([{ key: "generation_lignite", name: "lignite", emissions_t: 23_808, share_pct: 100, g_per_kwh: 992 }]);
    expect(data.complete).toBe(true);
    expect(data.disclaimer).toMatch(/imports, exports and upstream emissions are not included/);
    expect(text).toMatch(/Mean 567 g CO2\/kWh; total about 23\.8 kt CO2/);
    expect(text).toMatch(/Important: Estimate based on generation/);
    expect(data.notes.join(" ")).toMatch(/Pumped storage counts as 0/);
  });

  it("covers 25 hours on the day the clocks go back", async () => {
    const { data } = await co2({ from: "2025-10-26" }, backend("2025-11-01T00:00:00Z").fetch);
    expect(data.intervals).toHaveLength(25);
    expect(data.total_emissions_t).toBe(25 * 992);
  });

  it("uses daily values for long ranges and does not list them all", async () => {
    const { data } = await co2({ from: "2024-01-01", to: "2026-09-30" }, backend("2026-10-13T08:00:00Z").fetch);
    expect(data.interval_unit).toBe("day");
    expect(data.intervals).toBeUndefined();
    expect(data.notes.join(" ")).toMatch(/single values are not listed/);
  });

  it("works for TSO zones", async () => {
    const { data } = await co2({ from: "2026-10-12", region: "TenneT" });
    expect(data.total_emissions_t).toBe(24 * 496);
  });

  it("names the uncertain factor when other conventional generation emits", async () => {
    const { data } = await co2({ from: "2026-10-12" }, backend("2026-10-13T08:00:00Z", { 1227: { value: () => 100 } }).fetch);
    expect(data.notes.join(" ")).toMatch(/other conventional generation \(707 g\/kWh\) is uncertain/);
    expect(data.by_source.map((s) => s.key)).toEqual(["generation_lignite", "generation_other_conventional"]);
  });

  it("returns an error for periods without data", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-13T09:00:00Z"));
    try {
      const { res, text } = await co2({ from: "2026-10-20" });
      expect(res.isError).toBe(true);
      expect(text).toMatch(/No data for this period/);
    } finally {
      vi.useRealTimers();
    }
  });
});
