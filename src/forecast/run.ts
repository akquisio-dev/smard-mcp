/**
 * Hourly forecasts of all sources from the newest weather run, computed once
 * per weather forecast and shared by all calls until a newer run arrives.
 */

import { buildFeatures } from "./features.js";
import { capacityMw, leadDays, loadModels, placeType, predictRow, SOURCES, type ModelBundle, type Source } from "./model.js";
import { runStartFor, type WeatherClient, type WeatherForecast } from "./weather.js";

const HOUR = 3_600_000;
/** Last usable lead: (L - 3 h) / 24 h = 6, the longest lead the models were trained on. */
export const MAX_LEAD_HOURS = 147;

export type Quality = "high" | "medium" | "low";

export interface HourForecast {
  start: number;
  leadHours: number;
  /** p10, p50, p90 in GW */
  gw: [number, number, number];
  quality: Quality;
}

export interface SourceForecast {
  hours: HourForecast[];
  capacityMw: (ms: number) => { mw: number; estimated: boolean };
}

export interface ForecastRun {
  weather: WeatherForecast;
  bundle: ModelBundle;
  /** Start of the first and end of the last hour that may be forecast. */
  firstHour: number;
  endExclusive: number;
  sources: Record<Source, SourceForecast>;
}

const RANK: Record<Quality, number> = { high: 0, medium: 1, low: 2 };
export const worse = (a: Quality, b: Quality): Quality => (RANK[a] >= RANK[b] ? a : b);

function qualityAt(bundle: ModelBundle, source: Source, leadHours: number): Quality {
  const days = bundle.meta.quellen[source].kennzahlen.je_tag;
  const [n, w] = leadDays(leadHours);
  const q = days[String(n)]!.quality;
  return w > 0 ? worse(q, days[String(n + 1)]!.quality) : q;
}

let cache: { fetchedAt: number; run: ForecastRun } | undefined;

export async function currentForecast(weather: WeatherClient, now: number, bundle: ModelBundle = loadModels()): Promise<ForecastRun> {
  const variables = [...new Set(Object.values(bundle.meta.variablen).flat())];
  const wf = await weather.get(bundle.meta.orte, variables);
  if (cache && cache.fetchedAt === wf.fetchedAt && cache.run.bundle === bundle) return cache.run;

  const globalRun = wf.runs[wf.runs.length - 1]!;
  const anyTimes = wf.series.values().next().value!.time;
  const lastWeatherHour = anyTimes[anyTimes.length - 2]!; // the last hour needs the stamp after it
  const firstHour = Math.floor(now / HOUR) * HOUR;
  const endExclusive = Math.min(globalRun.initMs + (MAX_LEAD_HOURS + 1) * HOUR, lastWeatherHour + HOUR);

  const sources = {} as Record<Source, SourceForecast>;
  for (const source of SOURCES) {
    const names = bundle.meta.quellen[source].merkmale;
    const places = bundle.meta.orte.filter((p) => p.typ.includes(placeType(source)));
    const f = buildFeatures(names, places, wf.series, bundle.meta.variablen[placeType(source)]!);
    const capacity = (ms: number) => capacityMw(bundle.meta.kapazitaet[source], ms);
    const hours: HourForecast[] = [];
    f.time.forEach((t, i) => {
      if (t < firstHour || t >= endExclusive) return;
      const leadHours = (t - runStartFor(wf.runs, t)) / HOUR;
      const night = source === "solar" && f.sunMax[i]! <= 0;
      const p = predictRow(bundle, source, f.rows[i]!, leadHours, night);
      const gw = capacity(t).mw / 1000;
      hours.push({ start: t, leadHours, gw: [p[0]! * gw, p[1]! * gw, p[2]! * gw], quality: qualityAt(bundle, source, leadHours) });
    });
    sources[source] = { hours, capacityMw: capacity };
  }
  const run = { weather: wf, bundle, firstHour, endExclusive, sources };
  cache = { fetchedAt: wf.fetchedAt, run };
  return run;
}
