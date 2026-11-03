/**
 * Monitoring of forecast_renewables in operation. The smard-forecast archive
 * stores every weather forecast the tool would have used (the same Open-Meteo
 * answer plus the run start of each ICON model). For each archived forecast
 * this module recomputes what the tool would have answered, with the models
 * shipped in this package, and compares it with SMARD's measured generation
 * once published. The result (error and coverage per source and lead day over
 * the last days) is written to a JSON file that forecast_renewables and
 * describe_forecast_model read.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { findSeries } from "../catalog.js";
import type { SmardClient } from "../smard.js";
import { buildFeatures, type PlaceSeries } from "./features.js";
import { capacityMw, loadModels, placeType, predictRow, SOURCES, type ModelBundle, type Source } from "./model.js";
import { MAX_LEAD_HOURS } from "./run.js";
import { runStartFor, type ModelRun } from "./weather.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const DEFAULT_ARCHIVE_DIR = "/var/lib/smard-forecast/archiv";
export const DEFAULT_MONITOR_FILE = "/var/lib/smard-mcp/forecast-monitor.json";
export const MONITOR_WINDOW_DAYS = 30;

const GENERATION_KEYS: Record<Source, string> = {
  solar: "generation_solar",
  wind_onshore: "generation_wind_onshore",
  wind_offshore: "generation_wind_offshore",
};

export interface ArchiveEntry {
  file: string;
  fetchedAt: number;
  runs: ModelRun[];
  series: Map<string, PlaceSeries>;
}

export interface LeadDayAccuracy {
  lead_day: number;
  hours: number;
  mae_gw: number | null;
  mae_pct_of_capacity: number | null;
  coverage_p10_p90_pct: number | null;
}

export interface MonitorReport {
  created: string;
  model_version: string;
  window_days: number;
  forecasts: number;
  first_forecast: string | null;
  last_forecast: string | null;
  sources: Record<Source, LeadDayAccuracy[]>;
}

/**
 * Data end of each ICON run. Archive files written before the archive stored
 * data_end_time carry only the run start; the horizon then follows the DWD
 * schedule (ICON-D2 48 h; ICON-EU 120 h from 00/06/12/18 UTC, else 30 h;
 * ICON global 180 h from 00/12 UTC, else 120 h).
 */
export function archiveRuns(laeufe: Record<string, string>, enden: Record<string, string> = {}): ModelRun[] {
  const out: ModelRun[] = [];
  for (const model of ["dwd_icon_d2", "dwd_icon_eu", "dwd_icon"]) {
    const start = laeufe[model];
    if (!start) continue;
    const initMs = Date.parse(start);
    const hour = new Date(initMs).getUTCHours();
    const horizon = model === "dwd_icon_d2" ? 48 : model === "dwd_icon_eu" ? (hour % 6 === 0 ? 120 : 30) : hour % 12 === 0 ? 180 : 120;
    const end = enden[model] ? Date.parse(enden[model]) : initMs + horizon * HOUR;
    out.push({ model, initMs, dataEndMs: end });
  }
  return out;
}

/** Archive files fetched at or after `since`, oldest first. */
export function readArchive(dir: string, since: number): ArchiveEntry[] {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".json.gz")) files.push(p);
    }
  };
  walk(dir);
  const out: ArchiveEntry[] = [];
  for (const file of files) {
    const m = /(\d{8})T(\d{4})Z\.json\.gz$/.exec(file);
    if (!m) continue;
    const stamp = Date.parse(`${m[1]!.slice(0, 4)}-${m[1]!.slice(4, 6)}-${m[1]!.slice(6)}T${m[2]!.slice(0, 2)}:${m[2]!.slice(2)}:00Z`);
    if (stamp < since) continue;
    const raw = JSON.parse(gunzipSync(readFileSync(file)).toString("utf8")) as {
      abgerufen: string;
      laeufe: Record<string, string>;
      laeufe_ende?: Record<string, string>;
      orte: { name: string; hourly: Record<string, (number | null)[]> & { time: string[] } }[];
    };
    const series = new Map<string, PlaceSeries>();
    for (const o of raw.orte) {
      series.set(o.name, { time: o.hourly.time.map((t) => Date.parse(`${t}:00Z`)), values: o.hourly });
    }
    out.push({ file, fetchedAt: Date.parse(raw.abgerufen), runs: archiveRuns(raw.laeufe, raw.laeufe_ende), series });
  }
  return out;
}

export interface IssuedHour {
  start: number;
  leadHours: number;
  /** p10, p50, p90 in GW */
  gw: [number, number, number];
  capacityGw: number;
}

/** What forecast_renewables would have answered from one archived forecast (night hours left out for solar). */
export function issuedForecast(bundle: ModelBundle, entry: ArchiveEntry, source: Source): IssuedHour[] {
  const names = bundle.meta.quellen[source].merkmale;
  const places = bundle.meta.orte.filter((p) => p.typ.includes(placeType(source)));
  const f = buildFeatures(names, places, entry.series, bundle.meta.variablen[placeType(source)]!);
  const globalRun = entry.runs[entry.runs.length - 1]!;
  const first = Math.floor(entry.fetchedAt / HOUR) * HOUR;
  const end = Math.min(globalRun.initMs + (MAX_LEAD_HOURS + 1) * HOUR, f.time[f.time.length - 2]! + HOUR);
  const out: IssuedHour[] = [];
  f.time.forEach((t, i) => {
    if (t < first || t >= end) return;
    if (source === "solar" && f.sunMax[i]! <= 0) return;
    const leadHours = (t - runStartFor(entry.runs, t)) / HOUR;
    const p = predictRow(bundle, source, f.rows[i]!, leadHours, false);
    const gw = capacityMw(bundle.meta.kapazitaet[source], t).mw / 1000;
    out.push({ start: t, leadHours, gw: [p[0]! * gw, p[1]! * gw, p[2]! * gw], capacityGw: gw });
  });
  return out;
}

/** Lead day in the sense of the user: hour within the first, second, ... 24 hours after the run. */
export function leadDayOf(leadHours: number): number {
  return Math.min(6, Math.max(1, Math.ceil(leadHours / 24)));
}

export async function buildMonitorReport(
  client: SmardClient,
  archiveDir: string,
  now = Date.now(),
  bundle: ModelBundle = loadModels(),
  windowDays = MONITOR_WINDOW_DAYS,
): Promise<MonitorReport> {
  // forecasts issued in the window plus up to 6 days earlier, so that day 6 is covered too
  const since = now - (windowDays + 7) * DAY;
  const entries = readArchive(archiveDir, since);
  const windowStart = now - windowDays * DAY;
  const sources = {} as Record<Source, LeadDayAccuracy[]>;
  for (const source of SOURCES) {
    const info = findSeries(GENERATION_KEYS[source])!;
    const actual = new Map<number, number>();
    if (entries.length > 0) {
      const points = await client.getRange(info.filter, "DE", "hour", windowStart, now);
      for (const p of points) actual.set(p.timestamp, p.value / 1000);
    }
    const acc = Array.from({ length: 6 }, () => ({ n: 0, abs: 0, absPct: 0, hit: 0 }));
    for (const entry of entries) {
      for (const h of issuedForecast(bundle, entry, source)) {
        if (h.start < windowStart) continue;
        const y = actual.get(h.start);
        if (y === undefined) continue;
        const a = acc[leadDayOf(h.leadHours) - 1]!;
        a.n++;
        a.abs += Math.abs(y - h.gw[1]);
        a.absPct += (Math.abs(y - h.gw[1]) / h.capacityGw) * 100;
        if (y >= h.gw[0] && y <= h.gw[2]) a.hit++;
      }
    }
    sources[source] = acc.map((a, i) => ({
      lead_day: i + 1,
      hours: a.n,
      mae_gw: a.n ? Math.round((a.abs / a.n) * 100) / 100 : null,
      mae_pct_of_capacity: a.n ? Math.round((a.absPct / a.n) * 100) / 100 : null,
      coverage_p10_p90_pct: a.n ? Math.round((a.hit / a.n) * 1000) / 10 : null,
    }));
  }
  const used = entries;
  return {
    created: new Date(now).toISOString(),
    model_version: bundle.meta.version,
    window_days: windowDays,
    forecasts: used.length,
    first_forecast: used.length ? new Date(used[0]!.fetchedAt).toISOString() : null,
    last_forecast: used.length ? new Date(used[used.length - 1]!.fetchedAt).toISOString() : null,
    sources,
  };
}

let cached: { at: number; file: string; report: MonitorReport | null } | undefined;

/** The latest monitoring report, if the file exists and is at most 3 days old (cached 10 minutes). */
export function readMonitorReport(file = process.env.SMARD_MCP_FORECAST_MONITOR ?? DEFAULT_MONITOR_FILE, now = Date.now()): MonitorReport | null {
  if (cached && cached.file === file && now - cached.at < 10 * 60_000) return cached.report;
  let report: MonitorReport | null;
  try {
    report = JSON.parse(readFileSync(file, "utf8")) as MonitorReport;
    if (now - Date.parse(report.created) > 3 * DAY) report = null;
  } catch {
    report = null;
  }
  cached = { at: now, file, report };
  return report;
}
