import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeSmard, type FakeSeries } from "./fake-smard.js";
import { connect, textOf } from "./helpers.js";
import { parseMoment } from "../src/tools/charging.js";
import { formatBerlin } from "../src/time.js";

const NOW = Date.parse("2026-10-14T10:00:00Z"); // 12:00 Berlin
const hourOf = (t: number) => Number(formatBerlin(t).slice(11, 13));

/** Base 100; evening peak 18-20 h 300; 22-23 h 50; night 02-03 h 20 (or `night`). */
function priceAt(t: number, night = 20): number {
  const h = hourOf(t);
  if (h >= 18 && h < 21) return 300;
  if (h >= 22) return 50;
  if (h >= 2 && h < 4) return night;
  return 100;
}

function backend(opts: { pricesUntil?: number; night?: number; price?: (t: number) => number } = {}) {
  const price = opts.price ?? ((t: number) => priceAt(t, opts.night));
  const series: Record<number, FakeSeries> = {
    4169: { value: (t) => (opts.pricesUntil !== undefined && t >= opts.pricesUntil ? null : price(t)), aggregate: "mean" },
    // Green share 20 %, 40 % from 02 to 03 h.
    5097: { value: (t) => (hourOf(t) >= 2 && hourOf(t) < 4 ? 20_000 : 10_000) },
    411: { value: () => 50_000 },
  };
  return createFakeSmard({ dataEnd: Date.parse("2026-12-31T00:00:00Z"), series });
}

interface Schedule {
  segments: { start: string; end: string; energy_kwh: number; average_price_eur_mwh: number | null }[];
  energy_kwh: number;
  average_price_eur_mwh: number | null;
  average_green_share_pct: number | null;
  cost_wholesale_eur: number | null;
  cost_retail_eur: number | null;
}
interface Result {
  from: string;
  to: string;
  prices_until: string | null;
  plan: Schedule;
  charge_now: Schedule;
  savings_eur: number | null;
  shortfall_kwh: number;
  unplanned_kwh: number;
  missing: string[];
  notes: string[];
}

async function plan(args: Record<string, unknown>, smard = backend(), now = NOW) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(now));
  const client = await connect(smard.fetch);
  const res = await client.callTool({ name: "plan_charging", arguments: { resolution: "hour", ...args } });
  return { res, data: res.structuredContent as unknown as Result, text: textOf(res) };
}

const blocks = (s: Schedule) => s.segments.map((g) => `${g.start.slice(8, 16)}-${g.end.slice(11, 16)} ${g.energy_kwh}`);

afterEach(() => {
  vi.useRealTimers();
});

describe("parseMoment", () => {
  it("reads a bare time as its next occurrence, over midnight", () => {
    const six = parseMoment("18:00", NOW);
    expect(formatBerlin(six)).toBe("2026-10-14T18:00:00+02:00");
    expect(formatBerlin(parseMoment("07:00", six))).toBe("2026-10-15T07:00:00+02:00");
    expect(formatBerlin(parseMoment("11:00", NOW))).toBe("2026-10-15T11:00:00+02:00");
  });

  it("handles the night of the clock change and ISO input", () => {
    const evening = parseMoment("2026-10-24T18:00", NOW);
    const morning = parseMoment("07:00", evening);
    expect(formatBerlin(morning)).toBe("2026-10-25T07:00:00+01:00");
    expect((morning - evening) / 3_600_000).toBe(14);
  });
});

describe("plan_charging", () => {
  it("picks the cheapest hours over midnight and computes the savings incl. VAT", async () => {
    const { data, text } = await plan({ from: "18:00", to: "07:00", energy_kwh: 22, power_kw: 11 });
    expect(blocks(data.plan)).toEqual(["15T02:00-04:00 22"]);
    expect(data.plan.cost_wholesale_eur).toBe(0.44);
    expect(blocks(data.charge_now)).toEqual(["14T18:00-20:00 22"]);
    expect(data.charge_now.cost_wholesale_eur).toBe(6.6);
    expect(data.savings_eur).toBe(Math.round((6.6 - 0.44) * 1.19 * 100) / 100);
    expect(data.plan.average_green_share_pct).toBe(40);
    expect(text).toMatch(/Savings with a dynamic tariff: 7\.33 EUR incl\. 19\.0 % VAT/);
  });

  it("puts the partial interval into the worst chosen one", async () => {
    const { data } = await plan({ from: "18:00", to: "07:00", energy_kwh: 25, power_kw: 11 });
    expect(blocks(data.plan)).toEqual(["14T22:00-23:00 3", "15T02:00-04:00 22"]);
    expect(data.plan.cost_wholesale_eur).toBe(0.59);
    // Charging right away fills from the start, the last hour partially.
    expect(blocks(data.charge_now)).toEqual(["14T18:00-21:00 25"]);
  });

  it("warns first and plans only the priced part when tomorrow's prices are missing", async () => {
    const midnight = Date.parse("2026-10-14T22:00:00Z");
    const { data, text } = await plan({ from: "18:00", to: "07:00", energy_kwh: 22, power_kw: 11 }, backend({ pricesUntil: midnight }));
    expect(data.prices_until).toBe("2026-10-15T00:00:00+02:00");
    expect(blocks(data.plan)).toEqual(["14T22:00-00:00 22"]);
    expect(text.split("\n")[0]).toMatch(/^Attention: Day-ahead prices exist only until 2026-10-15T00:00/);
    expect(text).toMatch(/Plan \(only within the part with data, until 15\.10 00:00\)/);
    expect(text).toMatch(/Savings with a dynamic tariff \(within the part with data only\)/);
    expect(data.shortfall_kwh).toBe(0);
  });

  it("gives no savings when charging right away would use unpriced hours", async () => {
    const elevenPm = Date.parse("2026-10-14T21:00:00Z");
    const { data } = await plan({ from: "22:00", to: "07:00", energy_kwh: 33, power_kw: 11 }, backend({ pricesUntil: elevenPm }));
    expect(data.charge_now.cost_wholesale_eur).toBeNull();
    expect(data.savings_eur).toBeNull();
    // 22:00 to 07:00 at 11 kW holds 99 kWh: nothing is physically short, 22 kWh just lack prices.
    expect(data.shortfall_kwh).toBe(0);
    expect(data.unplanned_kwh).toBe(22);
  });

  it("reports negative prices as negative cost", async () => {
    const { data } = await plan({ from: "18:00", to: "07:00", energy_kwh: 22, power_kw: 11 }, backend({ night: -50 }));
    expect(data.plan.cost_wholesale_eur).toBe(-1.1);
  });

  it("plans one uninterrupted block with contiguous", async () => {
    const { data } = await plan({ from: "18:00", to: "07:00", energy_kwh: 33, power_kw: 11, contiguous: true });
    expect(blocks(data.plan)).toEqual(["15T01:00-04:00 33"]);
  });

  it("plans the longest block the data allows and reports the rest as unplanned", async () => {
    const midnight = Date.parse("2026-10-14T22:00:00Z");
    const { data, text } = await plan({ from: "22:00", to: "07:00", energy_kwh: 44, power_kw: 11, contiguous: true }, backend({ pricesUntil: midnight }));
    expect(blocks(data.plan)).toEqual(["14T22:00-00:00 22"]);
    expect(data.shortfall_kwh).toBe(0);
    expect(data.unplanned_kwh).toBe(22);
    expect(text).toMatch(/22\.0 kWh are not planned/);
  });

  it("treats a plug-in time that has passed as plugged in already", async () => {
    // 12:00 now, plugged in at 10:00, leaving at 17:00: today, from now on.
    const { data } = await plan({ from: "10:00", to: "17:00", energy_kwh: 11, power_kw: 11 });
    expect(data.from).toBe("2026-10-14T12:00:00+02:00");
    expect(data.to).toBe("2026-10-14T17:00:00+02:00");
  });

  it("adds a retail cost with a surcharge", async () => {
    const { data } = await plan({ from: "18:00", to: "07:00", energy_kwh: 22, power_kw: 11, surcharge_ct_kwh: 20 });
    // (0.44 + 0.20 x 22) x 1.19
    expect(data.plan.cost_retail_eur).toBe(Math.round((0.44 + 4.4) * 1.19 * 100) / 100);
  });

  it("does not split the charge for a few cents", async () => {
    const price = (t: number) => (hourOf(t) === 19 ? 101 : 100);
    const { data } = await plan({ from: "18:00", to: "21:00", energy_kwh: 22, power_kw: 11 }, backend({ price }));
    expect(blocks(data.plan)).toEqual(["14T18:00-20:00 22"]);
    expect(data.notes.join(" ")).toMatch(/practically as good/);
  });

  it("covers the 25-hour day and reports what does not fit", async () => {
    const { data, text } = await plan({ from: "2026-10-24T18:00", to: "07:00", energy_kwh: 100, power_kw: 1 }, backend(), Date.parse("2026-10-24T10:00:00Z"));
    expect(data.plan.energy_kwh).toBe(14);
    expect(data.shortfall_kwh).toBe(86);
    expect(data.unplanned_kwh).toBe(0);
    expect(text).toMatch(/86\.0 of 100\.0 kWh cannot be charged before departure/);
  });

  it("rejects windows that are reversed, too long or in the past", async () => {
    expect(textOf((await plan({ from: "2026-10-14T18:00", to: "2026-10-14T17:00", energy_kwh: 10, power_kw: 11 })).res)).toMatch(/must be after/);
    expect(textOf((await plan({ from: "2026-10-14T18:00", to: "2026-10-17T07:00", energy_kwh: 10, power_kw: 11 })).res)).toMatch(/at most 48 hours/);
    expect(textOf((await plan({ from: "2026-10-13T18:00", to: "2026-10-13T20:00", energy_kwh: 10, power_kw: 11 })).res)).toMatch(/in the past/);
  });
});
