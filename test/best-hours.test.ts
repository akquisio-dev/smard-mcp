import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeSmard, type FakeSeries } from "./fake-smard.js";
import { connect, textOf } from "./helpers.js";

const HOUR = 3_600_000;
const OCT14 = Date.parse("2026-10-13T22:00:00Z"); // 2026-10-14 00:00 Berlin
const OCT13 = OCT14 - 24 * HOUR;
const hourOfDay = (t: number, dayStart: number) => Math.floor((t - dayStart) / HOUR);

/**
 * Every day (Berlin, summer time): price 100 except 20 from 12:00 to 14:59;
 * wind+solar 10 000 MWh except 40 000 from 01:00 to 03:59 and 15 000 from
 * 12:00 to 14:59; consumption 50 000. So the night is greenest, noon cheapest,
 * and noon wins the balanced score.
 */
function dayPattern(t: number): number {
  return ((hourOfDay(t, OCT13) % 24) + 24) % 24;
}
const price = (t: number) => (dayPattern(t) >= 12 && dayPattern(t) < 15 ? 20 : 100);
const windSolar = (t: number) => {
  const h = dayPattern(t);
  if (h >= 1 && h < 4) return 40_000;
  if (h >= 12 && h < 15) return 15_000;
  return 10_000;
};

function backend(opts: { pricesUntil?: number; forecastUntil?: number } = {}) {
  const until = (end: number | undefined, f: (t: number) => number) => (t: number) => (end !== undefined && t >= end ? null : f(t));
  const series: Record<number, FakeSeries> = {
    4169: { value: until(opts.pricesUntil, price), aggregate: "mean" },
    5097: { value: until(opts.forecastUntil, windSolar) },
    411: { value: () => 50_000 },
    // Actual values for past days: wind onshore + offshore + solar add up to windSolar.
    4067: { value: (t) => windSolar(t) / 2 },
    1225: { value: (t) => windSolar(t) / 4 },
    4068: { value: (t) => windSolar(t) / 4 },
    410: { value: () => 50_000 },
  };
  return createFakeSmard({ dataEnd: Date.parse("2026-10-16T00:00:00Z"), series });
}

interface W {
  start: string;
  end: string;
  average_price_eur_mwh: number | null;
  average_green_share_pct: number | null;
}
interface Result {
  date: string;
  region: string;
  price_zone: string;
  resolution: string;
  from: string;
  optimize: string;
  recommended: W | null;
  best: { price: W | null; green: W | null; balanced: W | null };
  worst: W | null;
  hours: { time: string; price_eur_mwh: number | null; green_share_pct: number | null }[];
  missing: string[];
  notes: string[];
}

async function best(args: Record<string, unknown>, smard = backend(), now = "2026-10-13T12:00:00Z") {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(now));
  const client = await connect(smard.fetch);
  const res = await client.callTool({ name: "find_best_hours", arguments: args });
  return { res, data: res.structuredContent as unknown as Result, text: textOf(res), calls: smard.calls };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("find_best_hours", () => {
  it("finds the best windows per criterion for a given day", async () => {
    const { res, data, text, calls } = await best({ date: "2026-10-14", duration_hours: 3 });
    expect(res.isError, text).toBeFalsy();
    expect(data.hours).toHaveLength(24);
    expect(data.best.price).toEqual({
      start: "2026-10-14T12:00:00+02:00",
      end: "2026-10-14T15:00:00+02:00",
      average_price_eur_mwh: 20,
      average_green_share_pct: 30,
    });
    expect(data.best.green).toMatchObject({ start: "2026-10-14T01:00:00+02:00", average_green_share_pct: 80, average_price_eur_mwh: 100 });
    expect(data.best.balanced?.start).toBe("2026-10-14T12:00:00+02:00");
    expect(data.optimize).toBe("balanced");
    expect(data.recommended).toEqual(data.best.balanced);
    expect(data.worst?.average_price_eur_mwh).toBe(100);
    expect(data.worst?.average_green_share_pct).toBe(20);
    expect(data.missing).toEqual([]);
    expect(data.notes.join(" ")).toMatch(/dynamic electricity tariff/);
    expect(calls.some((c) => c.startsWith("5097/"))).toBe(true);
    expect(text).toMatch(/Recommended: 12:00 to 15:00: 20\.00 EUR\/MWh, green 30\.0 %/);
    expect(text).toMatch(/Hour \| EUR\/MWh \| green %/);
    expect(text).toMatch(/on 2026-10-14 \(hourly steps, 00:00 to 24:00, green share for DE, price DE-LU/);
  });

  it("defaults to tomorrow once the day-ahead prices are published", async () => {
    const { data } = await best({ optimize: "price" }, backend(), "2026-10-13T12:00:00Z");
    expect(data.date).toBe("2026-10-14");
    expect(data.recommended?.start).toBe("2026-10-14T12:00:00+02:00");
  });

  it("falls back to the rest of today before the auction and says so", async () => {
    const { data } = await best({ duration_hours: 2 }, backend({ pricesUntil: OCT14 }), "2026-10-13T07:20:00Z");
    expect(data.date).toBe("2026-10-13");
    expect(data.from).toBe("2026-10-13T10:00:00+02:00");
    expect(data.hours).toHaveLength(14);
    expect(data.notes.join(" ")).toMatch(/not published yet/);
    expect(data.best.price?.start).toBe("2026-10-13T12:00:00+02:00");
  });

  it("works with prices only when forecasts are missing and says what is missing", async () => {
    const { data, text } = await best({ date: "2026-10-14", optimize: "green" }, backend({ forecastUntil: OCT14 }));
    expect(data.best.green).toBeNull();
    expect(data.best.balanced).toBeNull();
    expect(data.best.price?.start).toBe("2026-10-14T12:00:00+02:00");
    expect(data.optimize).toBe("price");
    expect(data.missing.join(" ")).toMatch(/forecasts of wind\/solar generation or consumption for this day are not available/);
    expect(data.notes.join(" ")).toMatch(/"green" cannot be computed/);
    expect(text).toMatch(/Missing: /);
  });

  it("works with forecasts only when prices are missing", async () => {
    const { data } = await best({ date: "2026-10-14" }, backend({ pricesUntil: OCT14 }));
    expect(data.best.price).toBeNull();
    expect(data.optimize).toBe("green");
    expect(data.missing.join(" ")).toMatch(/Day-ahead prices for this day are not available/);
  });

  it("uses actual values for past days", async () => {
    const { data, calls } = await best({ date: "2026-10-12", optimize: "green" });
    expect(data.best.green).toMatchObject({ start: "2026-10-12T01:00:00+02:00", average_green_share_pct: 80 });
    expect(calls.some((c) => c.startsWith("4067/"))).toBe(true);
    expect(calls.some((c) => c.startsWith("5097/"))).toBe(false);
  });

  it("handles the 25-hour day", async () => {
    // 2025-10-26: 02:00 exists twice. Make 00:00-02:59 UTC (02:00 CEST, 02:00 CET, 03:00 CET) the greenest hours.
    const smard = createFakeSmard({
      dataEnd: Date.parse("2025-11-01T00:00:00Z"),
      series: {
        4169: { value: () => 50, aggregate: "mean" },
        4067: { value: (t) => (t >= Date.parse("2025-10-26T00:00:00Z") && t < Date.parse("2025-10-26T03:00:00Z") ? 40_000 : 5_000) },
        1225: { value: () => 0 },
        4068: { value: () => 0 },
        410: { value: () => 50_000 },
      },
    });
    const { data } = await best({ date: "2025-10-26", optimize: "green" }, smard);
    expect(data.hours).toHaveLength(25);
    expect(data.hours.filter((h) => h.time.slice(11, 13) === "02")).toHaveLength(2);
    expect(data.recommended).toMatchObject({ start: "2025-10-26T02:00:00+02:00", end: "2025-10-26T04:00:00+01:00", average_green_share_pct: 80 });
  });

  it("rejects windows longer than the hours left", async () => {
    const { res, text } = await best({ date: "2026-10-13", duration_hours: 12 }, backend(), "2026-10-13T15:30:00Z");
    expect(res.isError).toBe(true);
    expect(text).toMatch(/Only 6\.0 hours are left/);
  });
});

describe("find_best_hours criteria", () => {
  /**
   * Night 00-05: cheap (10) and dirty (10 %); morning 06-10: 40 and 60 %;
   * noon 11-14: expensive (120) and green (90 %); rest: 100 and 20 %.
   * Scaled over the day, the morning scores 0.676 vs. 0.5 for night and noon.
   */
  function diverging() {
    const h = (t: number) => (((Math.floor((t - OCT14) / HOUR) % 24) + 24) % 24);
    const pick = (t: number, night: number, morning: number, noon: number, rest: number) =>
      h(t) <= 5 ? night : h(t) <= 10 ? morning : h(t) <= 14 ? noon : rest;
    return createFakeSmard({
      dataEnd: Date.parse("2026-10-16T00:00:00Z"),
      series: {
        4169: { value: (t) => pick(t, 10, 40, 120, 100), aggregate: "mean" },
        5097: { value: (t) => pick(t, 5_000, 30_000, 45_000, 10_000), regions: ["DE", "TenneT", "Amprion"] },
        411: { value: () => 50_000 },
      },
    });
  }

  it("gives different windows for price, green and balanced", async () => {
    const { data } = await best({ date: "2026-10-14", duration_hours: 3 }, diverging());
    expect(data.best.price?.start).toBe("2026-10-14T00:00:00+02:00");
    expect(data.best.green?.start).toBe("2026-10-14T11:00:00+02:00");
    expect(data.best.balanced?.start).toBe("2026-10-14T06:00:00+02:00");
    expect(new Set([data.best.price?.start, data.best.green?.start, data.best.balanced?.start]).size).toBe(3);
    expect(data.notes.join(" ")).toMatch(/scaled to 0\.\.1 over the intervals of the day/);
  });

  it("searches in 15-minute steps", async () => {
    const smard = createFakeSmard({
      dataEnd: Date.parse("2026-10-16T00:00:00Z"),
      series: {
        // Hourly 100, but 13:15 to 14:15 costs 5 in the quarter-hour auction.
        4169: {
          value: () => 100,
          quarterValue: (t) => (t >= OCT14 + 13.25 * HOUR && t < OCT14 + 14.25 * HOUR ? 5 : 100),
          aggregate: "mean",
        },
        5097: { value: () => 10_000 },
        411: { value: () => 50_000 },
      },
    });
    const { data, text } = await best({ date: "2026-10-14", duration_hours: 1, optimize: "price", resolution: "quarterhour" }, smard);
    expect(data.resolution).toBe("quarterhour");
    expect(data.hours).toHaveLength(96);
    expect(data.recommended).toMatchObject({ start: "2026-10-14T13:15:00+02:00", end: "2026-10-14T14:15:00+02:00", average_price_eur_mwh: 5 });
    expect(text).toMatch(/15-minute steps/);
    expect(text).toMatch(/Hour \(mean of the quarter-hours\)/);
  });

  it("leaves out intervals that have already started", async () => {
    const { data } = await best({ date: "2026-10-13", resolution: "quarterhour", duration_hours: 1 }, backend(), "2026-10-13T08:07:00Z");
    expect(data.from).toBe("2026-10-13T10:15:00+02:00");
    const hourly = await best({ date: "2026-10-13", duration_hours: 1 }, backend(), "2026-10-13T08:07:00Z");
    expect(hourly.data.from).toBe("2026-10-13T11:00:00+02:00");
  });

  it("uses the region for the green share only and keeps the DE-LU price", async () => {
    const smard = createFakeSmard({
      dataEnd: Date.parse("2026-10-16T00:00:00Z"),
      series: {
        4169: { value: () => 50, aggregate: "mean" },
        5097: { value: (_t, region) => (region === "TenneT" ? 25_000 : 10_000) },
        411: { value: (_t, region) => (region === "TenneT" ? 25_000 : 50_000) },
      },
    });
    const { data, text, calls } = await best({ date: "2026-10-14", region: "TenneT" }, smard);
    expect(data.region).toBe("TenneT");
    expect(data.price_zone).toBe("DE-LU");
    expect(data.recommended?.average_green_share_pct).toBe(100);
    expect(calls.some((c) => c.startsWith("5097/TenneT/"))).toBe(true);
    expect(calls.some((c) => c.startsWith("4169/DE/"))).toBe(true);
    expect(text).toMatch(/green share for TenneT, price DE-LU/);
    expect(data.notes.join(" ")).toMatch(/no regional prices/);
  });

  it("counts missing offshore wind as 0 for zones without offshore (actual values)", async () => {
    const smard = createFakeSmard({
      dataEnd: Date.parse("2026-10-16T00:00:00Z"),
      series: {
        4169: { value: () => 50, aggregate: "mean" },
        4067: { value: () => 6_000 },
        1225: { value: () => 9_999, regions: ["DE", "TenneT", "50Hertz"] },
        4068: { value: () => 4_000 },
        410: { value: () => 20_000 },
      },
    });
    const { data } = await best({ date: "2026-10-12", region: "Amprion", optimize: "green" }, smard);
    expect(data.recommended?.average_green_share_pct).toBe(50);
    expect(data.missing).toEqual([]);
  });
});

describe("find_best_hours intraday forecasts for today", () => {
  /** Day-ahead says the evening (18-20) is greenest; the intraday update moves it to 21-23, but stops at 22:00. */
  function smard(intraday: boolean) {
    const h = (t: number) => (((Math.floor((t - OCT13) / HOUR) % 24) + 24) % 24);
    const series: Record<number, FakeSeries> = {
      4169: { value: () => 50, aggregate: "mean" },
      5097: { value: (t) => (h(t) >= 18 && h(t) < 21 ? 40_000 : 10_000) },
      411: { value: () => 50_000 },
    };
    if (intraday) series[5129] = { value: (t) => (h(t) >= 22 ? null : h(t) >= 21 ? 45_000 : 10_000) };
    return createFakeSmard({ dataEnd: Date.parse("2026-10-16T00:00:00Z"), series });
  }

  it("prefers the intraday forecast for today and falls back to day-ahead per interval", async () => {
    const { data, calls } = await best({ date: "2026-10-13", optimize: "green", duration_hours: 3 }, smard(true), "2026-10-13T10:00:00Z");
    // Intraday: 21:00 = 90 %; day-ahead fills 22:00 and 23:00 (20 %), 18-20 are 20 % intraday.
    expect(data.hours.find((r) => r.time.startsWith("2026-10-13T21:00"))?.green_share_pct).toBe(90);
    expect(data.hours.find((r) => r.time.startsWith("2026-10-13T19:00"))?.green_share_pct).toBe(20);
    expect(data.hours.find((r) => r.time.startsWith("2026-10-13T22:00"))?.green_share_pct).toBe(20);
    expect(calls.some((c) => c.startsWith("5129/DE/"))).toBe(true);
    expect(data.notes.join(" ")).toMatch(/intraday forecast \(updated during the day\)/);
  });

  it("says when no intraday forecast exists yet", async () => {
    const { data } = await best({ date: "2026-10-13", optimize: "green" }, smard(false), "2026-10-13T10:00:00Z");
    expect(data.recommended?.start).toBe("2026-10-13T18:00:00+02:00");
    expect(data.notes.join(" ")).toMatch(/No intraday forecast is available yet/);
  });

  it("keeps the day-ahead forecast for tomorrow", async () => {
    const { data, calls } = await best({ date: "2026-10-14", optimize: "green" }, smard(true), "2026-10-13T10:00:00Z");
    expect(data.recommended?.start).toBe("2026-10-14T18:00:00+02:00");
    expect(calls.some((c) => c.startsWith("5129/"))).toBe(false);
  });
});
