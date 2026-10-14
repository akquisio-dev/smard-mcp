import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeSmard, type FakeSeries } from "./fake-smard.js";
import { connect, textOf } from "./helpers.js";
import { pickSnapshot, STRAGGLER_MS } from "../src/tools/current-status.js";

const HOUR = 3_600_000;
const Q = HOUR / 4;
const NOW = Date.parse("2026-10-14T09:50:00Z"); // 11:50 Berlin
const GEN_UNTIL = Date.parse("2026-10-14T09:15:00Z"); // last generation quarter-hour starts 09:00 UTC
const LOAD_UNTIL = GEN_UNTIL - Q; // consumption one quarter-hour behind
const BIOMASS_UNTIL = Date.parse("2026-10-14T07:15:00Z"); // two hours behind: lagging

/** Quarter-hour values up to `until` (exclusive); hourly values are four quarter-hours. */
function actual(perQuarter: number, until: number): FakeSeries {
  return {
    value: (t) => (t + HOUR <= until ? perQuarter * 4 : null),
    quarterValue: (t) => (t < until ? perQuarter : null),
  };
}

function backend() {
  const series: Record<number, FakeSeries> = {
    1223: actual(500, GEN_UNTIL), // lignite 2 GW
    4068: actual(1_000, GEN_UNTIL), // solar 4 GW
    4067: actual(750, GEN_UNTIL), // wind onshore 3 GW
    4066: actual(250, BIOMASS_UNTIL),
    1224: { value: () => null }, // nuclear: no values
    410: actual(2_500, LOAD_UNTIL), // consumption 10 GW
    4963: actual(-250, GEN_UNTIL), // net import 1 GW
    4169: { value: () => 90, quarterValue: (t) => (t === Date.parse("2026-10-14T09:45:00Z") ? 80 : 95), aggregate: "mean" },
    5129: { value: (t) => (t < Date.parse("2026-10-14T11:00:00Z") ? 30_000 : null) },
    5097: { value: () => 20_000 },
    411: { value: () => 40_000 },
  };
  for (const f of [1225, 1226, 1227, 1228, 4069, 4070, 4071]) series[f] = actual(0, GEN_UNTIL);
  // Installed capacity: solar 16 GW, lignite 1.5 GW (below the 2 GW generated: no utilization).
  series[188] = { value: () => 16_000 };
  series[4072] = { value: () => 1_500 };
  return createFakeSmard({ dataEnd: Date.parse("2026-10-20T00:00:00Z"), series });
}

interface Result {
  server_time: string;
  as_of: string;
  interval_end: string;
  data_age_minutes: number;
  generation: {
    total_gw: number;
    renewable_gw: number;
    renewable_share_pct: number;
    sources: { key: string; gw: number; capacity_gw: number | null; utilization_pct: number | null }[];
  };
  consumption_gw: number;
  net_export_gw: number;
  co2_intensity_g_per_kwh: number;
  price: { interval_start: string; eur_mwh: number } | null;
  outlook: { time: string; price_eur_mwh: number | null; wind_and_solar_gw: number | null; consumption_gw: number | null; wind_and_solar_share_pct: number | null }[];
  lagging: { key: string; data_until: string }[];
  notes: string[];
}

async function status(args: Record<string, unknown> = {}) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  const client = await connect(backend().fetch);
  const res = await client.callTool({ name: "get_current_status", arguments: args });
  return { res, data: res.structuredContent as unknown as Result, text: textOf(res) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("pickSnapshot", () => {
  const pts = (until: number, n = 8) => Array.from({ length: n }, (_, i) => ({ timestamp: until - (n - i) * Q, value: 1 }));

  it("takes the newest quarter-hour all current series share", () => {
    const snap = pickSnapshot(new Map([["a", pts(GEN_UNTIL)], ["b", pts(LOAD_UNTIL)]]))!;
    expect(snap.asOf).toBe(LOAD_UNTIL - Q);
    expect(snap.values.get("a")).toBe(1);
    expect(snap.lagging).toEqual([]);
  });

  it("leaves out series too far behind and ignores series without values", () => {
    const late = GEN_UNTIL - STRAGGLER_MS - Q;
    const snap = pickSnapshot(new Map([["a", pts(GEN_UNTIL)], ["late", pts(late)], ["none", []]]))!;
    expect(snap.asOf).toBe(GEN_UNTIL - Q);
    expect(snap.lagging).toEqual([{ key: "late", until: late }]);
    expect(snap.values.has("late")).toBe(false);
  });

  it("is null without any values", () => {
    expect(pickSnapshot(new Map([["a", []]]))).toBeNull();
  });
});

describe("get_current_status", () => {
  it("reports the newest common quarter-hour as power in GW", async () => {
    const { data, text } = await status();
    expect(data.as_of).toBe("2026-10-14T10:45:00+02:00");
    expect(data.interval_end).toBe("2026-10-14T11:00:00+02:00");
    expect(data.data_age_minutes).toBe(50);
    expect(data.server_time).toBe("2026-10-14T11:50:00+02:00");
    expect(data.generation.total_gw).toBe(9);
    expect(data.generation.renewable_gw).toBe(7);
    expect(data.generation.sources.map((s) => [s.key, s.gw])).toEqual([
      ["generation_solar", 4],
      ["generation_wind_onshore", 3],
      ["generation_lignite", 2],
    ]);
    expect(data.consumption_gw).toBe(10);
    expect(data.net_export_gw).toBe(-1);
    expect(data.co2_intensity_g_per_kwh).toBe(Math.round((2 * 992) / 9));
    expect(text).toMatch(/net import 1\.0 GW/);
    expect(text).toMatch(/data 50 minutes old/);
  });

  it("puts power in relation to installed capacity, but never above 100 %", async () => {
    const { data, text } = await status();
    const by = (k: string) => data.generation.sources.find((s) => s.key === k)!;
    expect(by("generation_solar")).toMatchObject({ capacity_gw: 16, utilization_pct: 25 });
    expect(by("generation_lignite")).toMatchObject({ capacity_gw: 1.5, utilization_pct: null });
    expect(by("generation_wind_onshore")).toMatchObject({ capacity_gw: null, utilization_pct: null });
    expect(text).toMatch(/photovoltaics 4\.00 GW \(44\.4 %, 25\.0 % of 16\.0 GW installed\)/);
    expect(data.notes.join(" ")).toMatch(/No utilization for generation_lignite/);
  });

  it("still answers without utilization when capacity cannot be loaded", async () => {
    const smard = backend();
    const broken: typeof globalThis.fetch = async (input) =>
      /\/188\/DE\/188_DE_year_/.test(String(input)) ? new Response("not json", { status: 200 }) : smard.fetch(input);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    const client = await connect(broken);
    const res = await client.callTool({ name: "get_current_status", arguments: {} });
    const data = res.structuredContent as unknown as Result;
    expect(res.isError).toBeFalsy();
    expect(data.generation.sources.every((s) => s.utilization_pct === null)).toBe(true);
    expect(data.notes.join(" ")).toMatch(/could not be loaded/);
  });

  it("names series that lag behind instead of waiting for them", async () => {
    const { data, text } = await status();
    expect(data.lagging).toEqual([{ key: "generation_biomass", data_until: "2026-10-14T09:15:00+02:00" }]);
    expect(data.notes.join(" ")).toMatch(/generation_biomass is left out/);
    expect(text.split("\n")[1]).toMatch(/^Incomplete: generation_biomass not yet published/);
  });

  it("gives the price of the current quarter-hour and an hourly outlook", async () => {
    const { data } = await status({ hours_ahead: 3 });
    expect(data.price).toEqual({ interval_start: "2026-10-14T11:45:00+02:00", interval_end: "2026-10-14T12:00:00+02:00", eur_mwh: 80 });
    expect(data.outlook.map((o) => o.time)).toEqual(["2026-10-14T11:00:00+02:00", "2026-10-14T12:00:00+02:00", "2026-10-14T13:00:00+02:00"]);
    // Intraday where available, day-ahead after it.
    expect(data.outlook.map((o) => o.wind_and_solar_gw)).toEqual([30, 30, 20]);
    expect(data.outlook[0]).toMatchObject({ price_eur_mwh: 90, consumption_gw: 40, wind_and_solar_share_pct: 75 });
  });

  it("works without an outlook", async () => {
    const { data } = await status({ hours_ahead: 0 });
    expect(data.outlook).toEqual([]);
  });
});
