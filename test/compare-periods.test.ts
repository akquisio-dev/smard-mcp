import { describe, expect, it } from "vitest";
import { createFakeSmard, type FakeSeries } from "./fake-smard.js";
import { connect, textOf } from "./helpers.js";

const SWITCH = Date.parse("2025-12-31T23:00:00Z"); // 2026-01-01 00:00 Berlin
/** Before 2026: 10 GWh/h lignite, 5 solar, price 100. From 2026: 8 lignite, 10 solar, price 150. */
function backend() {
  const after = (t: number) => t >= SWITCH;
  const series: Record<number, FakeSeries> = {
    1223: { value: (t) => (after(t) ? 8_000 : 10_000) },
    4068: { value: (t) => (after(t) ? 10_000 : 5_000) },
    4070: { value: () => 1_000 },
    1224: { value: () => null },
    410: { value: (t, region) => (region === "DE" ? (after(t) ? 20_000 : 18_000) : 5_000) },
    4169: { value: (t) => (after(t) ? 150 : 100), aggregate: "mean" },
    4963: { value: (t) => (after(t) ? -1_000 : 500) },
  };
  return createFakeSmard({ dataEnd: Date.parse("2026-10-13T08:00:00Z"), series });
}

interface Period {
  label: string;
  from: string;
  hours: number;
  average_load_gw: number;
  complete: boolean;
  total_generation_gwh: number;
  renewable_share_pct: number;
  consumption_gwh: number;
  average_price_eur_mwh?: number | null;
}
interface Result {
  region: string;
  period_a: Period;
  period_b: Period;
  differences: {
    total_generation_gwh: number;
    renewable_share_pp: number;
    consumption_gwh: number;
    consumption_pct: number;
    average_load_gw: number;
      hours: number;
    average_price_eur_mwh?: number | null;
    average_price_pct?: number | null;
    sources: { key: string; a_gwh: number; b_gwh: number; delta_gwh: number; delta_share_pp: number }[];
  };
  notes: string[];
}

async function compare(args: Record<string, unknown>) {
  const client = await connect(backend().fetch);
  const res = await client.callTool({ name: "compare_periods", arguments: args });
  expect(res.isError, textOf(res)).toBeFalsy();
  return { data: res.structuredContent as unknown as Result, text: textOf(res) };
}

describe("compare_periods", () => {
  it("reports both periods and the differences B minus A", async () => {
    const { data, text } = await compare({ period_a_from: "2025-10-12", period_b_from: "2026-10-12" });
    // A: 24 h * 16 GWh/h, B: 24 h * 19 GWh/h
    expect(data.period_a.total_generation_gwh).toBe(384);
    expect(data.period_b.total_generation_gwh).toBe(456);
    expect(data.differences.total_generation_gwh).toBe(72);
    // Renewable: A 5/16 = 31.25 %, B 10/19 = 52.63 %; pumped storage does not count.
    expect(data.period_a.renewable_share_pct).toBe(31.3);
    expect(data.period_b.renewable_share_pct).toBe(52.6);
    expect(data.differences.renewable_share_pp).toBe(21.4);
    expect(data.differences.consumption_gwh).toBe(48);
    expect(data.differences.consumption_pct).toBe(11.1);
    expect(data.period_a.average_price_eur_mwh).toBe(100);
    expect(data.period_b.average_price_eur_mwh).toBe(150);
    expect(data.differences.average_price_eur_mwh).toBe(50);
    expect(data.differences.average_price_pct).toBe(50);
    expect(data.differences.sources[0]).toMatchObject({ key: "generation_solar", a_gwh: 120, b_gwh: 240, delta_gwh: 120 });
    expect(data.differences.sources.some((s) => s.key === "generation_nuclear")).toBe(false);
    expect(data.notes).toEqual([]);
    expect(data.period_a).toMatchObject({ label: "2025-10-12", hours: 24, average_load_gw: 18, complete: true });
    expect(data.period_b).toMatchObject({ label: "2026-10-12", hours: 24, average_load_gw: 20 });
    expect(data.differences).toMatchObject({ average_load_gw: 2, hours: 0 });
    // A: 10 lignite of 16 -> 992 * 10/16 = 620; B: 8 of 19 -> 992 * 8/19 = 417.7
    expect((data.period_a as unknown as { co2_intensity_g_per_kwh: number }).co2_intensity_g_per_kwh).toBe(620);
    expect((data.differences as unknown as { co2_intensity_g_per_kwh: number }).co2_intensity_g_per_kwh).toBe(Math.round((992 * 8) / 19 - 620));
    // Every source with generation in a period is listed, also in the text.
    expect(data.differences.sources.map((s) => s.key).sort()).toEqual(["generation_lignite", "generation_pumped_storage", "generation_solar"]);
    expect(text).toMatch(/A = 2025-10-12 \(24\.0 hours, complete\), B = 2026-10-12/);
    expect(text).toMatch(/Changes are from A to B/);
    expect(text).toMatch(/Renewable share: A 31\.3 %, B 52\.6 % \(\+21\.4 pp\)/);
    expect(text).toMatch(/Total generation: A 384\.0 GWh, B 456\.0 GWh \(\+72\.0 GWh\)/);
    expect(text).toMatch(/Mean day-ahead price DE-LU: A 100\.00 EUR\/MWh, B 150\.00 EUR\/MWh \(\+50\.00 EUR\/MWh, \+50\.0 %\)/);
    expect(text).toMatch(/pumped storage: 24\.0 GWh -> 24\.0 GWh/);
    expect(text).toMatch(/No generation in either period: nuclear/);
    expect((data.differences as unknown as { net_export_gwh: number }).net_export_gwh).toBe(-36);
    expect(text).toMatch(/Cross-border physical flows \(measured\): A net export 12\.0 GWh, B net import 24\.0 GWh \(net export -36\.0 GWh\)/);
  });

  it("handles the 25-hour day and warns about different lengths", async () => {
    const { data } = await compare({ period_a_from: "2025-10-26", period_b_from: "2026-10-12" });
    expect(data.period_a.total_generation_gwh).toBe(400); // 25 h * 16
    expect(data.period_a.hours).toBe(25);
    expect(data.differences.hours).toBe(-1);
    expect(data.period_a.consumption_gwh).toBe(450);
    expect(data.notes.join(" ")).toMatch(/differ in length/);
  });

  it("compares long periods with daily values", async () => {
    const { data } = await compare({
      period_a_from: "2025-01-01",
      period_a_to: "2025-06-30",
      period_b_from: "2026-01-01",
      period_b_to: "2026-06-30",
    });
    expect(data.period_a.average_price_eur_mwh).toBe(100);
    expect(data.period_b.average_price_eur_mwh).toBe(150);
    expect(data.differences.renewable_share_pp).toBe(21.4);
    expect(data.period_a.label).toBe("2025-01-01 to 2025-06-30");
  });

  it("leaves out the price for TSO zones", async () => {
    const { data } = await compare({ period_a_from: "2025-10-12", period_b_from: "2026-10-12", region: "Amprion" });
    expect(data.region).toBe("Amprion");
    expect(data.period_a.average_price_eur_mwh).toBeUndefined();
    expect(data.differences.average_price_eur_mwh).toBeUndefined();
    expect(data.differences.consumption_gwh).toBe(0);
    expect(data.notes.join(" ")).toMatch(/no regional price/);
  });
});

describe("compare_periods without data", () => {
  it("names the period that has no data", async () => {
    const client = await connect(backend().fetch);
    const res = await client.callTool({ name: "compare_periods", arguments: { period_a_from: "2026-10-12", period_b_from: "2026-11-01" } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^Period B: No data for this period/);
  });
});
