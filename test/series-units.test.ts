import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeSmard } from "./fake-smard.js";
import { connect, textOf } from "./helpers.js";

const NOW = Date.parse("2026-10-27T10:00:00Z");

function backend() {
  return createFakeSmard({
    dataEnd: Date.parse("2026-10-27T09:00:00Z"),
    series: {
      410: { value: () => 1_000, quarterValue: () => 250 },
      4169: { value: () => 80, aggregate: "mean" },
      1223: { value: () => 500 },
    },
  });
}

async function call(name: string, args: Record<string, unknown>) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  const client = await connect(backend().fetch);
  const res = await client.callTool({ name, arguments: args });
  return { res, data: res.structuredContent as Record<string, unknown>, text: textOf(res) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("get_series unit MW", () => {
  it("turns quarter-hour energy into average power", async () => {
    const { res, text } = await call("get_series", {
      series: "consumption_total",
      resolution: "quarterhour",
      from: "2026-10-26T12:00",
      to: "2026-10-26T13:00",
      unit: "MW",
    });
    const data = JSON.parse(text) as { unit: string; points: { value: number }[]; summary: Record<string, unknown> };
    expect(res.isError).toBeFalsy();
    expect(data.unit).toBe("MW");
    expect(data.points.map((p) => p.value)).toEqual([1000, 1000, 1000, 1000]);
    expect(data.summary.mean).toBe(1000);
    expect(data.summary).not.toHaveProperty("sum");
  });

  it("divides daily energy by the real day length on a DST switch day", async () => {
    // 2026-10-25 has 25 hours: 25 000 MWh -> 1 000 MW.
    const { text } = await call("get_series", { series: "consumption_total", resolution: "day", from: "2026-10-24", to: "2026-10-25", unit: "MW" });
    const data = JSON.parse(text) as { points: { time: string; value: number }[] };
    expect(data.points).toEqual([
      { time: "2026-10-24T00:00:00+02:00", value: 1000 },
      { time: "2026-10-25T00:00:00+02:00", value: 1000 },
    ]);
  });

  it("keeps MWh with a sum by default", async () => {
    const { text } = await call("get_series", { series: "consumption_total", from: "2026-10-26T12:00", to: "2026-10-26T14:00" });
    const data = JSON.parse(text) as { unit: string; summary: { sum: number } };
    expect(data.unit).toBe("MWh");
    expect(data.summary.sum).toBe(2000);
  });

  it("rejects MW for prices", async () => {
    const { res, text } = await call("get_series", { series: "price_de_lu", unit: "MW" });
    expect(res.isError).toBe(true);
    expect(text).toMatch(/unit MW only applies to energy series/);
  });
});

describe("server time and data age", () => {
  it("get_series carries server_time and, for measured data up to now, data_age_minutes", async () => {
    const { text } = await call("get_series", { series: "consumption_total", from: "2026-10-27T06:00", to: "2026-10-27T12:00" });
    const data = JSON.parse(text) as Record<string, unknown>;
    expect(data.server_time).toBe("2026-10-27T11:00:00+01:00");
    expect(data.covered_until).toBe("2026-10-27T10:00:00+01:00");
    expect(data.data_age_minutes).toBe(60);
    expect(text).not.toMatch(/Server time:/);
  });

  it("has no data_age_minutes for past ranges or prices", async () => {
    const past = await call("get_series", { series: "consumption_total", from: "2026-10-20", to: "2026-10-20" });
    expect(JSON.parse(past.text)).not.toHaveProperty("data_age_minutes");
    const price = await call("get_series", { series: "price_de_lu", from: "2026-10-27T06:00", to: "2026-10-27T12:00" });
    expect(JSON.parse(price.text)).not.toHaveProperty("data_age_minutes");
  });

  it("analysis tools carry server_time in the data and the text", async () => {
    const { data, text } = await call("analyze_prices", { from: "2026-10-26", to: "2026-10-26" });
    expect(data.server_time).toBe("2026-10-27T11:00:00+01:00");
    expect(text).toMatch(/Server time: 2026-10-27T11:00:00\+01:00$/);
  });
});
