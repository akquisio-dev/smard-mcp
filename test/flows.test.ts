import { afterEach, describe, expect, it, vi } from "vitest";
import { BORDERS } from "../src/borders.js";
import { createFakeSmard, type FakeSeries } from "./fake-smard.js";
import { connect, textOf } from "./helpers.js";

const HOUR = 3_600_000;
const OCT12 = Date.parse("2026-10-11T22:00:00Z");
const hourOfDay = (t: number) => ((Math.floor((t - OCT12) / HOUR) % 24) + 24) % 24;

/**
 * DE physical: France exports 100 / imports -300 per hour (-2 500 at 18:00,
 * 0 at 13:00), Poland 400 / 0; all other borders have no series (404).
 * So the net is 200 per hour, -2 000 at 18:00 and +500 at 13:00, and
 * SMARD's net series agrees with the country series.
 */
const franceImport = (t: number) => (hourOfDay(t) === 18 ? -2_500 : hourOfDay(t) === 13 ? 0 : -300);
function backend(overrides: Record<number, FakeSeries> = {}) {
  const series: Record<number, FakeSeries> = {
    4963: { value: (t, region) => (region === "DE" ? 500 + franceImport(t) : -50) },
    4737: { value: () => 100 }, // DE FR physical export
    4881: { value: franceImport }, // DE FR physical import
    4741: { value: () => 400 }, // DE PL physical export
    4885: { value: () => 0 }, // DE PL physical import
    4753: { value: () => 70 }, // 50Hertz PL physical export
    4895: { value: () => -120 }, // 50Hertz PL physical import
    4629: { value: () => -500 }, // commercial net
    4404: { value: () => 50 }, // DE FR commercial export
    4546: { value: () => -550 }, // DE FR commercial import
    ...overrides,
  };
  return createFakeSmard({ dataEnd: Date.parse("2026-10-14T00:00:00Z"), series });
}

interface Result {
  kind: string;
  hours: number;
  resolution: string;
  complete: boolean;
  net_export_gwh: number;
  exports_gwh: number;
  imports_gwh: number;
  countries: { code: string; export_gwh: number; import_gwh: number; net_export_gwh: number }[];
  peak_net_import: { time: string; gw: number } | null;
  peak_net_export: { time: string; gw: number } | null;
  notes: string[];
  intervals_of?: string;
  intervals?: { time: string; export_gwh: number; import_gwh: number; net_export_gwh: number }[];
}

async function flows(args: Record<string, unknown>, smard = backend()) {
  const client = await connect(smard.fetch);
  const res = await client.callTool({ name: "get_cross_border_flows", arguments: args });
  return { res, data: res.structuredContent as unknown as Result, text: textOf(res), calls: smard.calls };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("border table", () => {
  it("covers Germany's eleven neighbours and the TSO zones' foreign borders", () => {
    const de = BORDERS.filter((b) => b.region === "DE").map((b) => b.code).sort();
    expect(de).toEqual(["AT", "BE", "CH", "CZ", "DK", "FR", "LU", "NL", "NO", "PL", "SE"]);
    expect(BORDERS.filter((b) => b.region === "50Hertz").map((b) => b.code).sort()).toEqual(["CZ", "DK2", "PL"]);
    const ids = BORDERS.flatMap((b) => [b.physical.export, b.physical.import, b.commercial.export, b.commercial.import]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("get_cross_border_flows", () => {
  it("sums exports, imports and the net per country with peak hours", async () => {
    const { res, data, text } = await flows({ from: "2026-10-12" });
    expect(res.isError, text).toBeFalsy();
    expect(data.kind).toBe("physical");
    expect(data.hours).toBe(24);
    expect(data.exports_gwh).toBe(12); // (100 + 400) x 24 MWh
    expect(data.imports_gwh).toBe(9.1); // 22 x 300 + 2 500
    expect(data.net_export_gwh).toBe((22 * 200 - 2_000 + 500) / 1000);
    expect(data.countries.slice(0, 2)).toEqual([
      { code: "PL", name: "Poland", export_gwh: 9.6, import_gwh: 0, net_export_gwh: 9.6 },
      { code: "FR", name: "France", export_gwh: 2.4, import_gwh: 9.1, net_export_gwh: -6.7 },
    ]);
    expect(data.countries).toHaveLength(11);
    expect(data.peak_net_import).toEqual({ time: "2026-10-12T18:00:00+02:00", gw: 2 });
    expect(data.peak_net_export).toEqual({ time: "2026-10-12T13:00:00+02:00", gw: 0.5 });
    expect(text).toMatch(/Largest net import: 2\.0 GW at 2026-10-12T18:00/);
    expect(text).toMatch(/- France: export 2\.4, import 9\.1, net import 6\.7 GWh/);
    expect(data.notes.join(" ")).not.toMatch(/net series differs/);
    expect(data.notes.join(" ")).toMatch(/actually crossed the borders/);
  });

  it("uses the TSO zone's own border series and explains what they cover", async () => {
    const { data, calls } = await flows({ from: "2026-10-12", region: "50Hertz" });
    expect(data.countries.map((c) => c.code).sort()).toEqual(["CZ", "DK2", "PL"]);
    expect(data.countries.find((c) => c.code === "PL")).toMatchObject({ export_gwh: 1.7, import_gwh: 2.9 });
    expect(calls.some((c) => c.startsWith("4753/50Hertz/"))).toBe(true);
    expect(calls.some((c) => c.startsWith("4737/"))).toBe(false);
    expect(data.notes.join(" ")).toMatch(/exchanges between the German zones are not included/);
  });

  it("reports commercial exchanges on request", async () => {
    const { data } = await flows({ from: "2026-10-12", kind: "commercial" });
    expect(data.kind).toBe("commercial");
    expect(data.net_export_gwh).toBe(-12);
    expect(data.countries[0]).toMatchObject({ code: "FR", export_gwh: 1.2, import_gwh: 13.2 });
    expect(data.notes.join(" ")).toMatch(/scheduled cross-border trades/);
  });

  it("uses daily values for long ranges, without peak hours", async () => {
    const { data } = await flows({ from: "2026-01-01", to: "2026-06-30" });
    expect(data.resolution).toBe("day");
    expect(data.peak_net_import).toBeNull();
    expect(data.exports_gwh).toBeGreaterThan(0);
  });

  it("counts 25 hours on the day the clocks go back", async () => {
    const { data } = await flows({ from: "2025-10-26" });
    expect(data.hours).toBe(25);
    expect(data.exports_gwh).toBe(12.5);
  });

  it("notes when SMARD's net series does not match the country series", async () => {
    const { data } = await flows({ from: "2026-10-12" }, backend({ 4963: { value: () => 9_000 } }));
    expect(data.notes.join(" ")).toMatch(/net series differs from the sum of the country series/);
  });

  it("gives one neighbour's values per hour with country", async () => {
    const { data, text } = await flows({ from: "2026-10-12", country: "fr" });
    expect(data.intervals_of).toBe("FR");
    expect(data.intervals).toHaveLength(24);
    expect(data.intervals![18]).toEqual({ time: "2026-10-12T18:00:00+02:00", export_gwh: 0.1, import_gwh: 2.5, net_export_gwh: -2.4 });
    expect(data.countries).toHaveLength(11);
    expect(text).toMatch(/Per hour, France \(time: export, import, net export in GWh\):/);
  });

  it("gives all borders per interval on request, and none by default", async () => {
    const all = await flows({ from: "2026-10-12", include_intervals: true });
    expect(all.data.intervals_of).toBe("all");
    expect(all.data.intervals![0]).toMatchObject({ export_gwh: 0.5, import_gwh: 0.3, net_export_gwh: 0.2 });
    const none = await flows({ from: "2026-10-12" });
    expect(none.data.intervals).toBeUndefined();
  });

  it("rejects a country without a border to the region", async () => {
    const { res, text } = await flows({ from: "2026-10-12", region: "50Hertz", country: "FR" });
    expect(res.isError).toBe(true);
    expect(text).toMatch(/50Hertz has no border "FR"\. Codes: CZ, DK2, PL\./);
  });

  it("returns an error for periods without data", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-13T09:00:00Z"));
    const { res, text } = await flows({ from: "2026-10-20" });
    expect(res.isError).toBe(true);
    expect(text).toMatch(/No data for this period/);
  });
});

describe("get_cross_border_flows before SMARD's net series exists", () => {
  it("computes net and peaks from the country series", async () => {
    // Net series 4963 starts later than the country series (as on SMARD in September 2020).
    const smard = backend({ 4963: { value: (t) => (t >= Date.parse("2026-10-13T00:00:00Z") ? 200 : null) } });
    const { data, text } = await flows({ from: "2026-10-12" }, smard);
    expect(data.net_export_gwh).toBe(2.9); // 22 x 200 - 2 000 + 500, from the country series
    expect(data.peak_net_export).toEqual({ time: "2026-10-12T13:00:00+02:00", gw: 0.5 });
    expect(data.peak_net_import).toEqual({ time: "2026-10-12T18:00:00+02:00", gw: 2 });
    expect(text).toMatch(/^Cross-border physical flows DE[^\n]*\nNet export 2\.9 GWh; exports 12\.0 GWh, imports 9\.1 GWh\./);
    expect(data.notes.join(" ")).not.toMatch(/net series differs/);
  });
});
