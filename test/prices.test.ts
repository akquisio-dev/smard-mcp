import { describe, expect, it, vi } from "vitest";
import { createFakeSmard } from "./fake-smard.js";
import { connect, textOf } from "./helpers.js";

const HOUR = 3_600_000;
const DAY_START = Date.parse("2026-10-11T22:00:00Z"); // 2026-10-12 00:00 Berlin

/** On 2026-10-12: 50, 40, ..., -180 EUR/MWh; other days: 100, before Oct 2025: -5. */
function price(t: number): number {
  if (t < Date.parse("2025-10-27T00:00:00Z") && t >= Date.parse("2025-10-20T00:00:00Z")) return -5;
  if (t >= DAY_START && t < DAY_START + 24 * HOUR) return 50 - 10 * ((t - DAY_START) / HOUR);
  return 100;
}

function backend(dataEnd = "2026-10-13T22:00:00Z") {
  return createFakeSmard({ dataEnd: Date.parse(dataEnd), series: { 4169: { value: price, aggregate: "mean" } } });
}

interface P {
  time: string;
  price_eur_mwh: number;
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
  cheapest: P[];
  most_expensive: P[];
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
    expect(data.max).toEqual({ time: "2026-10-12T00:00:00+02:00", price_eur_mwh: 50 });
    expect(data.min).toEqual({ time: "2026-10-12T23:00:00+02:00", price_eur_mwh: -180 });
    expect(data.negative_count).toBe(18);
    expect(data.negative_prices[0]).toEqual({ time: "2026-10-12T06:00:00+02:00", price_eur_mwh: -10 });
    expect(data.negative_list_truncated).toBe(false);
    expect(data.cheapest.map((p) => p.price_eur_mwh)).toEqual([-180, -170, -160]);
    expect(data.most_expensive.map((p) => p.price_eur_mwh)).toEqual([50, 40, 30]);
    expect(data.daily_averages).toEqual([{ date: "2026-10-12", mean_eur_mwh: -65 }]);
    expect(data.notes).toEqual([]);
    expect(text).toMatch(/Negative prices in 18 hours/);
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
