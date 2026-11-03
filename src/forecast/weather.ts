/**
 * Weather forecasts from Open-Meteo (DWD ICON via icon_seamless) for all
 * forecast places in one request, cached until a newer model run exists.
 * meta.json of the three ICON models tells when each run started; the lead
 * time of an hour is counted from the run of the model that covers it
 * (ICON-D2 first, then ICON-EU, then ICON global), as in the training data.
 * If Open-Meteo fails, the last forecast is served with a warning up to
 * 12 hours old; after that the call fails.
 */

import { warn } from "../context.js";
import { SmardError } from "../smard.js";
import type { Place, PlaceSeries } from "./features.js";

const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const META_URL = (model: string) => `https://api.open-meteo.com/data/${model}/static/meta.json`;
/** ICON models inside icon_seamless, highest resolution first. */
const RUN_MODELS = ["dwd_icon_d2", "dwd_icon_eu", "dwd_icon"] as const;
const HOUR = 3_600_000;
export const MAX_WEATHER_AGE_MS = 12 * HOUR;

export interface ModelRun {
  model: string;
  initMs: number;
  dataEndMs: number;
}

export interface WeatherForecast {
  fetchedAt: number;
  runs: ModelRun[];
  series: Map<string, PlaceSeries>;
}

export interface WeatherClientOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  metaTtlMs?: number;
  now?: () => number;
}

/** Start of the run (ms) of the model that covers the given hour. */
export function runStartFor(runs: ModelRun[], hourStart: number): number {
  for (const r of runs) if (hourStart <= r.dataEndMs) return r.initMs;
  return runs[runs.length - 1]!.initMs;
}

export class WeatherClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly metaTtlMs: number;
  private readonly now: () => number;
  private meta?: { at: number; runs: ModelRun[] };
  private forecast?: WeatherForecast;
  private pending?: Promise<WeatherForecast>;

  constructor(options: WeatherClientOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.metaTtlMs = options.metaTtlMs ?? 10 * 60_000;
    this.now = options.now ?? Date.now;
  }

  private async getJson(url: string): Promise<unknown> {
    const res = await this.fetchImpl(url, {
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: { "User-Agent": "smard-mcp (+https://github.com/akquisio-dev/smard-mcp)" },
    });
    if (!res.ok) throw new SmardError(`Open-Meteo answered HTTP ${res.status}`, res.status);
    return res.json();
  }

  private async runs(): Promise<ModelRun[]> {
    if (this.meta && this.now() - this.meta.at < this.metaTtlMs) return this.meta.runs;
    const runs = await Promise.all(
      RUN_MODELS.map(async (model) => {
        const m = (await this.getJson(META_URL(model))) as { last_run_initialisation_time: number; data_end_time: number };
        return { model, initMs: m.last_run_initialisation_time * 1000, dataEndMs: m.data_end_time * 1000 };
      }),
    );
    this.meta = { at: this.now(), runs };
    return runs;
  }

  /** The newest forecast for all places; refetched only when a model has a newer run. */
  async get(places: Place[], variables: string[]): Promise<WeatherForecast> {
    try {
      const runs = await this.runs();
      const cached = this.forecast;
      if (cached && sameRuns(cached.runs, runs)) return cached;
      this.pending ??= this.fetchForecast(places, variables, runs).finally(() => (this.pending = undefined));
      this.forecast = await this.pending;
      return this.forecast;
    } catch (err) {
      const cached = this.forecast;
      const reason = err instanceof Error ? err.message : String(err);
      if (cached && this.now() - cached.fetchedAt <= MAX_WEATHER_AGE_MS) {
        const ageH = Math.round((this.now() - cached.fetchedAt) / HOUR);
        warn(`Open-Meteo did not answer (${reason}); using the weather forecast fetched ${ageH} h ago`);
        return cached;
      }
      throw new SmardError(`Weather forecast unavailable: Open-Meteo did not answer (${reason})`);
    }
  }

  private async fetchForecast(places: Place[], variables: string[], runs: ModelRun[]): Promise<WeatherForecast> {
    const q = new URLSearchParams({
      latitude: places.map((p) => p.lat).join(","),
      longitude: places.map((p) => p.lon).join(","),
      models: "icon_seamless",
      hourly: variables.join(","),
      forecast_days: "8",
      timezone: "GMT",
    });
    const body = await this.getJson(`${FORECAST_URL}?${q}`);
    const list = (Array.isArray(body) ? body : [body]) as { hourly: Record<string, (number | null)[]> & { time: string[] } }[];
    if (list.length !== places.length) throw new SmardError(`Open-Meteo returned ${list.length} places instead of ${places.length}`);
    const series = new Map<string, PlaceSeries>();
    places.forEach((p, i) => {
      const h = list[i]!.hourly;
      const values: Record<string, (number | null)[]> = {};
      for (const v of variables) values[v] = h[v] ?? [];
      series.set(p.name, { time: h.time.map((t) => Date.parse(`${t}:00Z`)), values });
    });
    return { fetchedAt: this.now(), runs, series };
  }
}

function sameRuns(a: ModelRun[], b: ModelRun[]): boolean {
  return a.length === b.length && a.every((r, i) => r.initMs === b[i]!.initMs);
}

let shared: WeatherClient | undefined;

/**
 * The process-wide client. The HTTP server builds a new MCP server per
 * request; sharing the client keeps one cache, so Open-Meteo is asked about
 * once per model run instead of once per call.
 */
export function sharedWeatherClient(): WeatherClient {
  shared ??= new WeatherClient();
  return shared;
}
