import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeSmard, type FakeSeries } from "./fake-smard.js";
import { connect, textOf } from "./helpers.js";

const OCT13 = Date.parse("2026-10-12T22:00:00Z"); // 2026-10-13 00:00 Berlin

function backend(opts: { nextDayUntil?: number } = {}) {
  const cut = (f: (t: number) => number | null) => (t: number) => (opts.nextDayUntil !== undefined && t >= opts.nextDayUntil ? null : f(t));
  const series: Record<number, FakeSeries> = {
    1223: { value: () => 1_000 },
    4068: { value: () => 1_000 },
    4067: { value: () => 2_000 },
    1224: { value: () => null },
    410: { value: () => 5_000 },
    4169: { value: cut(() => 80), aggregate: "mean" },
    123: { value: cut(() => 2_000) },
    3791: { value: cut(() => 500), regions: ["DE", "TenneT", "50Hertz"] },
    125: { value: cut(() => 1_000) },
    5097: { value: cut(() => 3_500) },
    411: { value: cut(() => 5_000) },
  };
  for (const f of [1225, 1226, 1227, 1228, 4066, 4069, 4070, 4071]) series[f] = { value: () => 0 };
  return createFakeSmard({ dataEnd: Date.parse("2026-10-16T00:00:00Z"), series });
}

interface Result {
  date: string;
  weekday: string;
  region: string;
  complete: boolean;
  mix: { renewable_share_pct: number; hours: number; co2_intensity_g_per_kwh: number };
  co2: { intensity_g_per_kwh: number; total_emissions_t: number; cleanest_hour: unknown };
  prices: { mean_eur_mwh: number; negative_count: number; reference_mean_30d_eur_mwh: number; deviation_from_30d_pct: number } | null;
  outlook: {
    date: string;
    forecast: { wind_and_solar_gwh: number; consumption_gwh: number; wind_and_solar_share_pct: number; wind_offshore_gwh: number | null } | null;
    prices: { mean_eur_mwh: number } | null;
    notes: string[];
  };
  notes: string[];
}

async function overview(args: Record<string, unknown>, smard = backend(), now = "2026-10-14T08:00:00Z") {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(now));
  const client = await connect(smard.fetch);
  const res = await client.callTool({ name: "get_market_overview", arguments: args });
  return { res, data: res.structuredContent as unknown as Result, text: textOf(res) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("get_market_overview", () => {
  it("combines mix, CO2, prices and the outlook for yesterday", async () => {
    const { res, data, text } = await overview({});
    expect(res.isError, text).toBeFalsy();
    expect(data.date).toBe("2026-10-13");
    expect(data.weekday).toBe("Tuesday");
    expect(data.complete).toBe(true);
    expect(data.mix.renewable_share_pct).toBe(75);
    expect(data.co2.intensity_g_per_kwh).toBe(248); // 992 x 1/4
    expect(data.co2.intensity_g_per_kwh).toBe(data.mix.co2_intensity_g_per_kwh);
    expect(data.co2.total_emissions_t).toBe(24 * 992);
    expect(data.prices).toMatchObject({ mean_eur_mwh: 80, negative_count: 0, reference_mean_30d_eur_mwh: 80, deviation_from_30d_pct: 0 });
    expect(data.outlook.date).toBe("2026-10-14");
    expect(data.outlook.forecast).toMatchObject({ wind_and_solar_gwh: 84, consumption_gwh: 120, wind_and_solar_share_pct: 70, wind_offshore_gwh: 12 });
    expect(data.outlook.prices?.mean_eur_mwh).toBe(80);
    expect(text).toMatch(/Electricity market DE, Tuesday 2026-10-13 \(complete\)/);
    expect(text).toMatch(/Outlook 2026-10-14: wind and solar forecast 84\.0 GWh/);
  });

  it("leaves out prices for TSO zones and handles missing offshore forecasts", async () => {
    const { data } = await overview({ date: "2026-10-13", region: "Amprion" });
    expect(data.prices).toBeNull();
    expect(data.outlook.prices).toBeNull();
    expect(data.outlook.forecast?.wind_offshore_gwh).toBeNull();
    expect(data.notes.join(" ")).toMatch(/no regional price/);
  });

  it("says when the next day's forecasts and prices are not published yet", async () => {
    const { data, text } = await overview({ date: "2026-10-13" }, backend({ nextDayUntil: OCT13 + 24 * 3_600_000 }));
    expect(data.outlook.forecast).toBeNull();
    expect(data.outlook.prices).toBeNull();
    expect(data.outlook.notes.join(" ")).toMatch(/Forecasts for the next day are not published yet/);
    expect(data.outlook.notes.join(" ")).toMatch(/prices for the next day are not available/);
    expect(text).toMatch(/no forecasts yet/);
  });

  it("counts 25 hours on the day the clocks go back", async () => {
    const { data } = await overview({ date: "2025-10-26" });
    expect(data.weekday).toBe("Sunday");
    expect(data.mix.hours).toBe(25);
  });

  it("returns an error for a day without data", async () => {
    const { res, text } = await overview({ date: "2026-10-20" });
    expect(res.isError).toBe(true);
    expect(text).toMatch(/No data for this period/);
  });
});
