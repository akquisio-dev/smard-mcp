import { describe, expect, it, vi } from "vitest";
import { createFakeSmard } from "./fake-smard.js";
import { connect, textOf } from "./helpers.js";

const HOUR = 3_600_000;
const DAY_START = Date.parse("2026-10-11T22:00:00Z"); // 2026-10-12 00:00 Berlin

/**
 * On 2026-10-12: 50, 40, ..., -180 EUR/MWh; 2026-10-05: 0.004 (rounds to 0.00)
 * except 3 hours at -12.34; in the week of 2025-10-20: -5; other days: 100.
 */
function price(t: number): number {
  if (t < Date.parse("2025-10-27T00:00:00Z") && t >= Date.parse("2025-10-20T00:00:00Z")) return -5;
  const oct5 = Date.parse("2026-10-04T22:00:00Z");
  if (t >= oct5 && t < oct5 + 24 * HOUR) return [13, 14, 15].includes((t - oct5) / HOUR) ? -12.34 : 0.004;
  if (t >= DAY_START && t < DAY_START + 24 * HOUR) return 50 - 10 * ((t - DAY_START) / HOUR);
  return 100;
}

function backend(dataEnd = "2026-10-13T22:00:00Z") {
  return createFakeSmard({ dataEnd: Date.parse(dataEnd), series: { 4169: { value: price, aggregate: "mean" } } });
}

interface P {
  time: string;
  price_eur_mwh: number;
  count?: number;
}
interface Result {
  bidding_zone: string;
  covered_until: string;
  complete: boolean;
  resolution: string;
  count: number;
  mean_eur_mwh: number;
  median_eur_mwh: number;
  min: P;
  max: P;
  negative_count: number;
  negative_prices: P[];
  negative_list_truncated: boolean;
  cheapest?: P[];
  most_expensive?: P[];
  all_prices?: P[];
  context?: { reference_mean_eur_mwh: number; deviation_pct: number | null } | null;
  daily_averages: { date: string; mean_eur_mwh: number }[];
  data_until: string;
  notes: string[];
}

async function analyze(args: Record<string, unknown>, fetch = backend().fetch) {
  const client = await connect(fetch);
  const res = await client.callTool({ name: "analyze_prices", arguments: args });
  return { res, data: res.structuredContent as unknown as Result, text: textOf(res) };
}

describe("analyze_prices", () => {
  it("computes the statistics of one day", async () => {
    const { res, data, text } = await analyze({ from: "2026-10-12", top_n: 3 });
    expect(res.isError, text).toBeFalsy();
    expect(data.bidding_zone).toBe("DE-LU");
    expect(data.count).toBe(24);
    expect(data.mean_eur_mwh).toBe(-65);
    expect(data.median_eur_mwh).toBe(-65);
    expect(data.max).toEqual({ time: "2026-10-12T00:00:00+02:00", price_eur_mwh: 50, count: 1 });
    expect(data.min).toEqual({ time: "2026-10-12T23:00:00+02:00", price_eur_mwh: -180, count: 1 });
    expect(data.negative_count).toBe(18);
    expect(data.negative_prices[0]).toEqual({ time: "2026-10-12T06:00:00+02:00", price_eur_mwh: -10 });
    expect(data.negative_list_truncated).toBe(false);
    expect(data.cheapest?.map((p) => p.price_eur_mwh)).toEqual([-180, -170, -160]);
    expect(data.most_expensive?.map((p) => p.price_eur_mwh)).toEqual([50, 40, 30]);
    expect(data.all_prices).toBeUndefined();
    expect(data.daily_averages).toEqual([{ date: "2026-10-12", mean_eur_mwh: -65 }]);
    expect(data.notes).toEqual([]);
    expect(text).toMatch(/Negative prices in 18 hours/);
    expect(text).toMatch(/Mean -65\.00 EUR\/MWh/);
  });

  it("handles the 25-hour day and caps the list of negative prices", async () => {
    const { data } = await analyze({ from: "2025-10-24", to: "2025-10-26" });
    expect(data.count).toBe(24 + 24 + 25);
    expect(data.daily_averages.map((d) => d.date)).toEqual(["2025-10-24", "2025-10-25", "2025-10-26"]);
    expect(data.negative_count).toBe(73);
    expect(data.negative_prices).toHaveLength(48);
    expect(data.negative_list_truncated).toBe(true);
  });

  it("supports quarter-hours and explains values before the 15-minute auction", async () => {
    const { data } = await analyze({ from: "2025-09-30", resolution: "quarterhour" });
    expect(data.count).toBe(96);
    expect(data.notes.join(" ")).toMatch(/auction was hourly/);
    const after = await analyze({ from: "2026-10-12", resolution: "quarterhour" });
    expect(after.data.count).toBe(96);
    expect(after.data.notes).toEqual([]);
  });

  it("reports the data horizon for ranges reaching into the future", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-13T10:00:00Z"));
    try {
      const { data } = await analyze({ from: "2026-10-13", to: "2026-10-14" }, backend("2026-10-13T22:00:00Z").fetch);
      expect(data.data_until).toBe("2026-10-13T23:00:00+02:00");
      expect(data.covered_until).toBe("2026-10-14T00:00:00+02:00");
      expect(data.complete).toBe(false);
      expect(data.notes.join(" ")).toMatch(/future/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows up to a year of hourly values but limits quarter-hours to 8 weeks", async () => {
    const year = await analyze({ from: "2025-10-13", to: "2026-10-12" });
    expect(year.res.isError, year.text).toBeFalsy();
    expect(year.data.daily_averages).toHaveLength(365);
    const tooLong = await analyze({ from: "2025-01-01", to: "2026-03-01" });
    expect(tooLong.res.isError).toBe(true);
    const quarter = await analyze({ from: "2026-01-01", to: "2026-03-31", resolution: "quarterhour" });
    expect(quarter.res.isError).toBe(true);
    expect(quarter.text).toMatch(/8 weeks/);
  });
});

describe("analyze_prices without data", () => {
  it("returns an error pointing to day-ahead publication", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-13T12:00:00Z"));
    const { res, text } = await analyze({ from: "2026-10-20" }).finally(() => vi.useRealTimers());
    expect(res.isError).toBe(true);
    expect(text).toMatch(/newest data reaches until 2026-10-14T00:00:00\+02:00/);
    expect(text).toMatch(/price_de_lu/);
  });
});

describe("analyze_prices output details", () => {
  it("keeps two decimals and reports ties", async () => {
    const { data, text } = await analyze({ from: "2026-10-05", top_n: 3, context: false });
    expect(data.min).toEqual({ time: "2026-10-05T13:00:00+02:00", price_eur_mwh: -12.34, count: 3 });
    expect(data.max).toEqual({ time: "2026-10-05T00:00:00+02:00", price_eur_mwh: 0, count: 21 });
    expect(text).toMatch(/Min -12\.34 EUR\/MWh \(3 hours, first at 2026-10-05T13:00:00\+02:00\)/);
    expect(text).toMatch(/max 0\.00 EUR\/MWh \(21 hours, first at 2026-10-05T00:00:00\+02:00\)/);
  });

  it("lists all prices chronologically when there are at most 2 * top_n", async () => {
    const { data, text } = await analyze({ from: "2026-10-12T20:00", to: "2026-10-12T23:59", top_n: 2, context: false });
    expect(data.count).toBe(4);
    expect(data.all_prices?.map((p) => p.price_eur_mwh)).toEqual([-150, -160, -170, -180]);
    expect(data.cheapest).toBeUndefined();
    expect(data.most_expensive).toBeUndefined();
    expect(text).toMatch(/All prices: 2026-10-12T20:00:00\+02:00 \(-150\.00\)/);
  });

  it("puts the period into context of the 30 days before", async () => {
    const { data, text } = await analyze({ from: "2026-10-12" });
    // The 30 days before contain one day at about 0 and 29 days at 100.
    const ref = (29 * 24 * 100 + 21 * 0.004 + 3 * -12.34) / (30 * 24);
    expect(data.context?.reference_mean_eur_mwh).toBe(Math.round(ref * 100) / 100);
    expect(data.context?.deviation_pct).toBe(Math.round((1000 * (-65 - ref)) / ref) / 10);
    expect(text).toMatch(/Context: mean of the 30 days before was 96\.62 EUR\/MWh; this period is -167\.3 %/);
  });

  it("can switch the context off", async () => {
    const { data, text } = await analyze({ from: "2026-10-12", context: false });
    expect(data.context).toBeUndefined();
    expect(text).not.toMatch(/Context:/);
  });
});

describe("analyze_prices context at the same clock hours", () => {
  /** Every day: 200 EUR/MWh from 17:00 to 19:59 Berlin (summer time), else 100. */
  const evening = () =>
    createFakeSmard({
      dataEnd: Date.parse("2026-10-14T00:00:00Z"),
      series: {
        4169: {
          value: (t) => {
            const h = new Date(t + 2 * HOUR).getUTCHours();
            return h >= 17 && h < 20 ? 200 : 100;
          },
          aggregate: "mean",
        },
      },
    });

  interface Ctx {
    hours_compared: string;
    reference_mean_eur_mwh: number;
    deviation_pct: number;
    same_hours_mean_eur_mwh: number;
    same_hours_deviation_pct: number;
  }

  it("compares an evening with the evenings of the 30 days before", async () => {
    const { data, text } = await analyze({ from: "2026-10-12T17:00", to: "2026-10-12T20:00" }, evening().fetch);
    const ctx = (data as unknown as { context: Ctx }).context;
    expect(ctx.hours_compared).toBe("17:00 to 20:00");
    expect(ctx.same_hours_mean_eur_mwh).toBe(200);
    expect(ctx.same_hours_deviation_pct).toBe(0);
    expect(ctx.reference_mean_eur_mwh).toBe(112.5); // (3 x 200 + 21 x 100) / 24
    expect(ctx.deviation_pct).toBe(77.8);
    expect(text).toMatch(/at the same hours \(17:00 to 20:00\) the 30 days before averaged 200\.00 EUR\/MWh; this period is 0\.0 %/);
  });

  it("keeps the all-hours comparison for whole days", async () => {
    const { data, text } = await analyze({ from: "2026-10-12" }, evening().fetch);
    const ctx = (data as unknown as { context: Ctx }).context;
    expect(ctx.hours_compared).toBe("all hours");
    expect(ctx.same_hours_mean_eur_mwh).toBe(ctx.reference_mean_eur_mwh);
    expect(text).toMatch(/Context: mean of the 30 days before was 112\.50 EUR\/MWh; this period is 0\.0 %/);
  });
});

describe("hoursLabel", () => {
  it("joins consecutive hours into ranges", async () => {
    const { hoursLabel } = await import("../src/tools/prices.js");
    expect(hoursLabel(new Set(["17", "18", "19"]))).toBe("17:00 to 20:00");
    expect(hoursLabel(new Set(["06", "07", "17", "18"]))).toBe("06:00 to 08:00, 17:00 to 19:00");
    expect(hoursLabel(new Set(["23"]))).toBe("23:00 to 24:00");
    expect(hoursLabel(new Set(Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0"))))).toBe("all hours");
  });
});
