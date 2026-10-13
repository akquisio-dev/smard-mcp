import { afterEach, describe, expect, it, vi } from "vitest";
import { BORDERS } from "../src/borders.js";
import { createFakeSmard, type FakeSeries } from "./fake-smard.js";
import { connect, textOf } from "./helpers.js";

const HOUR = 3_600_000;
const OCT12 = Date.parse("2026-10-11T22:00:00Z");
const hourOfDay = (t: number) => ((Math.floor((t - OCT12) / HOUR) % 24) + 24) % 24;

/**
 * DE physical: France exports 100 / imports -300 per hour, Poland 400 / 0;
 * all other borders have no series (404). Net = exports + imports, except
 * at 18:00 a net import of 2 000 and at 13:00 a net export of 1 500.
 */
function backend(overrides: Record<number, FakeSeries> = {}) {
  const net = (t: number) => (hourOfDay(t) === 18 ? -2_000 : hourOfDay(t) === 13 ? 1_500 : 200);
  const series: Record<number, FakeSeries> = {
    4963: { value: (t, region) => (region === "DE" ? net(t) : -50) },
    4737: { value: () => 100 }, // DE FR physical export
    4881: { value: () => -300 }, // DE FR physical import
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
    expect(data.imports_gwh).toBe(7.2); // 300 x 24
    expect(data.net_export_gwh).toBe((22 * 200 - 2_000 + 1_500) / 1000);
    expect(data.countries.slice(0, 2)).toEqual([
      { code: "PL", name: "Poland", export_gwh: 9.6, import_gwh: 0, net_export_gwh: 9.6 },
      { code: "FR", name: "France", export_gwh: 2.4, import_gwh: 7.2, net_export_gwh: -4.8 },
    ]);
    expect(data.countries).toHaveLength(11);
    expect(data.peak_net_import).toEqual({ time: "2026-10-12T18:00:00+02:00", gw: 2 });
    expect(data.peak_net_export).toEqual({ time: "2026-10-12T13:00:00+02:00", gw: 1.5 });
    expect(text).toMatch(/Largest net import: 2\.0 GW at 2026-10-12T18:00/);
    expect(text).toMatch(/- France: export 2\.4, import 7\.2, net import 4\.8 GWh/);
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

  it("returns an error for periods without data", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-13T09:00:00Z"));
    const { res, text } = await flows({ from: "2026-10-20" });
    expect(res.isError).toBe(true);
    expect(text).toMatch(/No data for this period/);
  });
});
