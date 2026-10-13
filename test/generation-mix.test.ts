import { describe, expect, it, vi } from "vitest";
import { createFakeSmard, type FakeSeries } from "./fake-smard.js";
import { connect, textOf } from "./helpers.js";

/** Constant hourly MWh per generation filter; nuclear has no data at all. */
const HOURLY: Record<number, number> = {
  1223: 12_000, // lignite
  1225: 2_000, // wind offshore
  1226: 1_000, // hydro
  1227: 1_500, // other conventional
  1228: 100, // other renewables
  4066: 4_000, // biomass
  4067: 6_000, // wind onshore
  4068: 10_000, // solar
  4069: 4_000, // hard coal
  4070: 1_500, // pumped storage
  4071: 8_000, // gas
};
const TOTAL_PER_HOUR = Object.values(HOURLY).reduce((a, b) => a + b, 0); // 50 100
const RENEWABLE_PER_HOUR = 2_000 + 1_000 + 100 + 4_000 + 6_000 + 10_000; // 23 100
const LOAD_PER_HOUR = 55_000;

function backend(dataEnd: string, overrides: Record<number, FakeSeries> = {}) {
  const series: Record<number, FakeSeries> = {
    1224: { value: () => null },
    410: { value: () => LOAD_PER_HOUR },
  };
  for (const [f, v] of Object.entries(HOURLY)) {
    series[Number(f)] = { value: (_t, region) => (region === "TenneT" ? v / 2 : v) };
  }
  return createFakeSmard({ dataEnd: Date.parse(dataEnd), series: { ...series, ...overrides } });
}

interface MixResult {
  region: string;
  covered_until: string | null;
  complete: boolean;
  resolution: string;
  from: string;
  to: string;
  data_until: string | null;
  notes: string[];
  total_generation_gwh: number;
  renewable_gwh: number;
  renewable_share_pct: number;
  consumption_gwh: number;
  average_load_gw: number;
  generation_to_consumption_pct: number;
  balance_gwh: number;
  hours: number;
  sources: { key: string; energy_gwh: number; share_pct: number; renewable: boolean }[];
  sources_without_data: string[];
}

async function mix(fetch: typeof globalThis.fetch, args: Record<string, unknown>) {
  const client = await connect(fetch);
  const res = await client.callTool({ name: "get_generation_mix", arguments: args });
  expect(res.isError, textOf(res)).toBeFalsy();
  return { data: res.structuredContent as unknown as MixResult, text: textOf(res) };
}

describe("get_generation_mix", () => {
  it("computes shares, renewables and the load ratio for one day", async () => {
    const { data, text } = await mix(backend("2026-10-13T08:00:00Z").fetch, { from: "2026-10-12", to: "2026-10-12" });
    expect(data.resolution).toBe("hour");
    expect(data.from).toBe("2026-10-12T00:00:00+02:00");
    expect(data.to).toBe("2026-10-13T00:00:00+02:00");
    expect(data.data_until).toBe("2026-10-12T23:00:00+02:00");
    expect(data.covered_until).toBe("2026-10-13T00:00:00+02:00");
    expect(data.complete).toBe(true);
    expect(data.notes).toEqual([]);
    expect(data.total_generation_gwh).toBe((24 * TOTAL_PER_HOUR) / 1000);
    expect(data.renewable_share_pct).toBe(Math.round((1000 * RENEWABLE_PER_HOUR) / TOTAL_PER_HOUR) / 10);
    expect(data.consumption_gwh).toBe((24 * LOAD_PER_HOUR) / 1000);
    expect(data.average_load_gw).toBe(55);
    expect(data.generation_to_consumption_pct).toBe(91.1);
    expect(data.sources[0]).toMatchObject({ key: "generation_lignite", energy_gwh: 288, share_pct: 24 });
    expect(data.sources.find((s) => s.key === "generation_pumped_storage")?.renewable).toBe(false);
    const gwh = data.sources.map((s) => s.energy_gwh);
    expect([...gwh].sort((a, b) => b - a)).toEqual(gwh);
    expect(data.sources.some((s) => s.key === "generation_nuclear")).toBe(false);
    expect(data.sources_without_data).toEqual(["generation_nuclear"]);
    expect(data.hours).toBe(24);
    // lignite 12 000 x 992 + hard coal 4 000 x 775 + gas 8 000 x 362 + other conv. 1 500 x 707, per 50 100 MWh
    expect((data as unknown as { co2_intensity_g_per_kwh: number }).co2_intensity_g_per_kwh).toBe(
      Math.round((12_000 * 992 + 4_000 * 775 + 8_000 * 362 + 1_500 * 707) / TOTAL_PER_HOUR),
    );
    expect(text).toMatch(/Estimated CO2 intensity: \d+ g\/kWh \(generation-based/);
    expect(data.balance_gwh).toBe((24 * (TOTAL_PER_HOUR - LOAD_PER_HOUR)) / 1000);
    expect(text).toMatch(/Total generation 1202\.4 GWh,/);
    expect(text).toMatch(/24\.0 hours, complete/);
    expect(text).toMatch(/Generation minus consumption: -117\.6 GWh \(indicator only/);
    expect(text).toMatch(/No generation in the period: nuclear \(0 GWh\)/);
    expect(text).toMatch(/Source: Bundesnetzagentur \| SMARD\.de/);
  });

  it("counts 25 hours on the day the clocks go back", async () => {
    const { data } = await mix(backend("2025-11-01T00:00:00Z").fetch, { from: "2025-10-26" });
    expect(data.total_generation_gwh).toBe((25 * TOTAL_PER_HOUR) / 1000);
    expect(data.consumption_gwh).toBe((25 * LOAD_PER_HOUR) / 1000);
    expect(data.average_load_gw).toBe(55);
    expect(data.hours).toBe(25);
  });

  it("switches to daily values above 8 weeks with identical totals", async () => {
    const smard = backend("2026-10-13T08:00:00Z");
    const { data } = await mix(smard.fetch, { from: "2026-01-01", to: "2026-03-31" });
    expect(data.resolution).toBe("day");
    const hours = (Date.parse("2026-03-31T22:00:00Z") - Date.parse("2025-12-31T23:00:00Z")) / 3_600_000;
    expect(data.total_generation_gwh).toBeCloseTo((hours * TOTAL_PER_HOUR) / 1000, 1);
    expect(smard.calls.some((c) => c.includes("_week_") || c.includes("_month_"))).toBe(false);
    expect(data.hours).toBe(hours);
    const client = await connect(smard.fetch);
    const text = textOf(await client.callTool({ name: "get_generation_mix", arguments: { from: "2026-01-01", to: "2026-03-31" } }));
    expect(text).toMatch(/Total generation 108\d{3}\.\d GWh = 108\.\d TWh,/);
  });

  it("cuts all series at the newest common data point and says so", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-13T12:00:00Z"));
    try {
      // Load lags behind generation by two hours.
      const smard = backend("2026-10-13T10:00:00Z", {
        410: { value: (t) => (t < Date.parse("2026-10-13T08:00:00Z") ? LOAD_PER_HOUR : null) },
      });
      const { data } = await mix(smard.fetch, { from: "2026-10-13" });
      expect(data.data_until).toBe("2026-10-13T09:00:00+02:00");
      expect(data.covered_until).toBe("2026-10-13T10:00:00+02:00");
      expect(data.complete).toBe(false);
      expect(data.total_generation_gwh).toBe((10 * TOTAL_PER_HOUR) / 1000);
      expect(data.consumption_gwh).toBe((10 * LOAD_PER_HOUR) / 1000);
      expect(data.notes.join(" ")).toMatch(/incomplete/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats null values as missing, not as zero", async () => {
    const smard = backend("2026-10-13T08:00:00Z", {
      // Solar is 0 at night (as on SMARD) and missing for 3 hours; hydro for 2.
      4068: {
        value: (t) => {
          const h = new Date(t).getUTCHours();
          if (h >= 10 && h < 13) return null;
          return h >= 5 && h < 17 ? 10_000 : 0;
        },
      },
      1226: { value: (t) => (t === Date.parse("2026-10-12T03:00:00Z") || t === Date.parse("2026-10-12T04:00:00Z") ? null : 1_000) },
    });
    const { data } = await mix(smard.fetch, { from: "2026-10-12" });
    expect(data.sources.find((s) => s.key === "generation_solar")?.energy_gwh).toBe(90);
    expect(data.sources.find((s) => s.key === "generation_hydro")?.energy_gwh).toBe(22);
    expect(data.data_until).toBe("2026-10-12T23:00:00+02:00");
  });

  it("handles series SMARD does not offer for a region", async () => {
    const smard = backend("2026-10-13T08:00:00Z", { 1223: { value: () => 1, regions: ["DE"] } });
    const { data } = await mix(smard.fetch, { from: "2026-10-12", region: "TenneT" });
    expect(data.region).toBe("TenneT");
    expect(data.sources_without_data).toContain("generation_lignite");
    expect(data.total_generation_gwh).toBe((24 * (TOTAL_PER_HOUR - 12_000)) / 2 / 1000);
  });

  it("defaults to yesterday", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-13T12:00:00Z"));
    try {
      const { data } = await mix(backend("2026-10-13T10:00:00Z").fetch, {});
      expect(data.from).toBe("2026-10-12T00:00:00+02:00");
      expect(data.to).toBe("2026-10-13T00:00:00+02:00");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects invalid ranges", async () => {
    const client = await connect(backend("2026-10-13T08:00:00Z").fetch);
    const res = await client.callTool({ name: "get_generation_mix", arguments: { from: "2026-10-12", to: "2026-10-01" } });
    expect(res.isError).toBe(true);
  });
});

describe("get_generation_mix with a series that ends inside the range", () => {
  it("does not cut the other series at the end of the ended one", async () => {
    // Nuclear reports until 2025-12-15 only, everything else until the data end.
    const end = Date.parse("2025-12-14T23:00:00Z");
    const smard = backend("2026-10-13T08:00:00Z", { 1224: { value: (t) => (t < end ? 3_000 : null) } });
    const { data } = await mix(smard.fetch, { from: "2025-12-01", to: "2025-12-31" });
    expect(data.resolution).toBe("hour");
    expect(data.data_until).toBe("2025-12-31T23:00:00+01:00");
    expect(data.sources.find((s) => s.key === "generation_nuclear")?.energy_gwh).toBe(14 * 24 * 3);
    expect(data.total_generation_gwh).toBe((31 * 24 * TOTAL_PER_HOUR + 14 * 24 * 3_000) / 1000);
    expect(data.notes.join(" ")).toMatch(/generation_nuclear has no data after 2025-12-14T23:00:00\+01:00/);
    expect(data.notes.join(" ")).not.toMatch(/incomplete/);
  });

  it("does the same with daily values", async () => {
    const end = Date.parse("2026-02-01T00:00:00Z");
    const smard = backend("2026-10-13T08:00:00Z", { 1224: { value: (t) => (t < end ? 3_000 : null) } });
    const { data } = await mix(smard.fetch, { from: "2026-01-01", to: "2026-06-30" });
    expect(data.resolution).toBe("day");
    expect(data.data_until).toBe("2026-06-30T00:00:00+02:00");
    expect(data.notes.join(" ")).toMatch(/generation_nuclear has no data after/);
  });
});

describe("get_generation_mix without data", () => {
  it("returns an error instead of zeros for a future period", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-13T09:00:00Z"));
    const client = await connect(backend("2026-10-13T08:00:00Z").fetch);
    const res = await client.callTool({ name: "get_generation_mix", arguments: { from: "2026-10-20" } }).finally(() => vi.useRealTimers());
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toMatch(/No data for this period; the newest data reaches until 2026-10-13T10:00:00\+02:00/);
    expect(text).toMatch(/forecast_generation_/);
    expect(text).not.toMatch(/0\.0 GWh/);
  });
});
