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
    expect(text).toMatch(/on 2026-10-14 \(hours 00:00 to 24:00,/);
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
    expect(text).toMatch(/Only 6 hours are left/);
  });
});
