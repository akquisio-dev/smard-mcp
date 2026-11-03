import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { SmardClient } from "../src/smard.js";
import { MODEL_NOTICE, runForecast } from "../src/tools/forecast.js";
import { WeatherClient } from "../src/forecast/weather.js";
import { createFakeSmard } from "./fake-smard.js";
import { textOf } from "./helpers.js";

const HOUR = 3_600_000;
const fx = JSON.parse(readFileSync(new URL("./fixtures/forecast-parity.json", import.meta.url), "utf8")) as {
  laeufe: { model: string; init: number; ende: number }[];
  antwort: unknown[];
  erwartet: Record<string, { zeit: string[]; p: number[][] }>;
};
const d2 = fx.laeufe[0]!;
const NOW = d2.init * 1000 + 5.5 * HOUR;

/** Open-Meteo imitation: meta.json per model and the forecast answer of the fixture. */
function weatherFetch(failForecast: { on: boolean; times?: number } = { on: false }) {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const meta = fx.laeufe.find((l) => url.includes(`/data/${l.model}/`));
    if (meta) return Response.json({ last_run_initialisation_time: meta.init, data_end_time: meta.ende });
    if (url.includes("/v1/forecast")) {
      if (failForecast.on && (failForecast.times === undefined || failForecast.times-- > 0)) return new Response("down", { status: 503 });
      return Response.json(fx.antwort);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

const smard = new SmardClient({
  fetch: createFakeSmard({
    dataEnd: NOW + 40 * HOUR,
    series: { 125: { value: () => 2_000 }, 123: { value: () => 8_000 }, 3791: { value: () => 1_500 } },
  }).fetch,
});

describe("forecast_renewables", () => {
  const weather = new WeatherClient({ fetch: weatherFetch(), now: () => NOW });

  it("forecasts from the current hour with hourly values and the official forecast", async () => {
    const r = await runForecast(smard, weather, { to: new Date(NOW + 24 * HOUR).toISOString() }, NOW);
    expect(r.model_notice).toBe(MODEL_NOTICE);
    expect(r.resolution).toBe("hour");
    expect(r.sources.map((s) => s.key)).toEqual(["solar", "wind_onshore", "wind_offshore"]);
    const wind = r.sources[1]!;
    expect(wind.intervals.length).toBeGreaterThanOrEqual(24);
    const first = wind.intervals[0]!;
    expect(first.official_forecast).toBe(8);
    expect(first.lead_days).toBe("1");
    expect(first.quality).toBe("high");
    for (const s of r.sources) {
      for (const i of s.intervals) {
        const b = (i as { gw: { p10: number; p50: number; p90: number } }).gw;
        expect(b.p10).toBeLessThanOrEqual(b.p50);
        expect(b.p50).toBeLessThanOrEqual(b.p90);
        expect(b.p90).toBeLessThanOrEqual(s.capacity_gw + 1e-9);
      }
    }
  });

  it("matches the Python reference in GW for the first wind hour", async () => {
    const r = await runForecast(smard, weather, { sources: ["wind_onshore"], resolution: "hour" }, NOW);
    const startUtc = new Date(Math.floor(NOW / HOUR) * HOUR).toISOString().slice(0, 16) + "Z";
    const k = fx.erwartet.wind_onshore!.zeit.indexOf(startUtc);
    const p50 = fx.erwartet.wind_onshore!.p[k]![1]!;
    const cap = r.sources[0]!.capacity_gw;
    expect((r.sources[0]!.intervals[0] as { gw: { p50: number } }).gw.p50).toBeCloseTo(p50 * cap, 1);
  });

  it("uses daily values beyond 48 hours, ends at the horizon and marks low quality", async () => {
    const r = await runForecast(smard, weather, {}, NOW);
    expect(r.resolution).toBe("day");
    const qualities = r.sources.flatMap((s) => s.intervals.map((i) => i.quality));
    expect(qualities).toContain("low");
    expect(r.notes.join(" ")).toMatch(/quality "low"/);
    const glob = fx.laeufe[fx.laeufe.length - 1]!;
    expect(Date.parse(r.covered_until!)).toBeLessThanOrEqual(glob.init * 1000 + 148 * HOUR);
  });

  it("rejects past ranges and ranges beyond the horizon", async () => {
    await expect(runForecast(smard, weather, { from: "2026-01-01", to: "2026-01-02" }, NOW)).rejects.toThrow(/past/);
    await expect(runForecast(smard, weather, { from: new Date(NOW + 10 * 24 * HOUR).toISOString() }, NOW)).rejects.toThrow(/reaches until/);
  });

  it("serves the last forecast with a warning when Open-Meteo fails", async () => {
    let t = NOW;
    const fail = { on: false };
    const w = new WeatherClient({ fetch: weatherFetch(fail), now: () => t, metaTtlMs: 0, retryDelaysMs: [0, 0] });
    const server = createServer(smard, w);
    const client = new Client({ name: "t", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    await client.callTool({ name: "forecast_renewables", arguments: { sources: ["solar"] } });
    fail.on = true;
    // a newer run appears but the forecast request fails
    fx.laeufe[0]!.init += 3600;
    t += HOUR;
    const res = await client.callTool({ name: "forecast_renewables", arguments: { sources: ["solar"] } });
    fx.laeufe[0]!.init -= 3600;
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toMatch(/Warning: Open-Meteo did not answer/);
    expect(textOf(res)).toMatch(/^Notice: These values are estimates/);
  });
});

describe("weather retries", () => {
  it("retries a failed request, so a fresh server without cache still answers", async () => {
    let calls = 0;
    const base = weatherFetch({ on: true, times: 2 });
    const counting = (async (input: string | URL | Request) => {
      if (String(input).includes("/v1/forecast")) calls++;
      return base(input);
    }) as typeof fetch;
    const w = new WeatherClient({ fetch: counting, now: () => NOW, retryDelaysMs: [0, 0] });
    const res = await runForecast(smard, w, { sources: ["wind_offshore"] }, NOW);
    expect(calls).toBe(3);
    expect(res.sources[0]!.intervals.length).toBeGreaterThan(0);
  });

  it("gives up after the retries and does not retry client errors", async () => {
    const fail = { on: true };
    const w = new WeatherClient({ fetch: weatherFetch(fail), now: () => NOW, retryDelaysMs: [0, 0] });
    await expect(runForecast(smard, w, { sources: ["solar"] }, NOW)).rejects.toThrow(/HTTP 503/);
    let calls = 0;
    const bad = (async () => {
      calls++;
      return new Response("bad", { status: 400 });
    }) as typeof fetch;
    const w2 = new WeatherClient({ fetch: bad, now: () => NOW, retryDelaysMs: [0, 0] });
    await expect(runForecast(smard, w2, { sources: ["solar"] }, NOW)).rejects.toThrow(/HTTP 400/);
    expect(calls).toBe(3); // one meta.json request per ICON model, none repeated
  });
});

describe("describe_forecast_model", () => {
  it("describes the model from the model files", async () => {
    const server = createServer(smard, new WeatherClient({ fetch: weatherFetch() }));
    const client = new Client({ name: "t", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const res = await client.callTool({ name: "describe_forecast_model", arguments: {} });
    const text = textOf(res);
    expect(text).toMatch(/LightGBM/);
    expect(text).toMatch(/Wind offshore \(7 places/);
    expect(text).toMatch(/day 6: MAE/);
    const d = res.structuredContent as { sources: { by_lead_day: { quality: string }[] }[] };
    expect(d.sources[0]!.by_lead_day).toHaveLength(6);
  });
});

describe("weather cache", () => {
  it("fetches the forecast once for several server instances", async () => {
    let forecasts = 0;
    const base = weatherFetch();
    const counting = (async (input: string | URL | Request) => {
      if (String(input).includes("/v1/forecast")) forecasts++;
      return base(input);
    }) as typeof fetch;
    const w = new WeatherClient({ fetch: counting, now: () => NOW });
    for (let i = 0; i < 2; i++) {
      const server = createServer(smard, w);
      const client = new Client({ name: "t", version: "0" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(a), client.connect(b)]);
      await client.callTool({ name: "forecast_renewables", arguments: { sources: ["wind_offshore"] } });
    }
    expect(forecasts).toBe(1);
  });

  it("is shared by default", async () => {
    const { sharedWeatherClient } = await import("../src/forecast/weather.js");
    expect(sharedWeatherClient()).toBe(sharedWeatherClient());
  });
});
