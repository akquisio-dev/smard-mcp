/**
 * The exported forecast models (models/ in the package) and the operational
 * prediction: interpolation between lead days, calibration (CQR), night mask.
 * Port of smard-forecast's sf/betrieb.py.
 */

import { readFileSync } from "node:fs";
import { berlinOffsetMinutes } from "../time.js";
import type { Place } from "./features.js";
import { predictModel, type CompactModel } from "./trees.js";

export const SOURCES = ["solar", "wind_onshore", "wind_offshore"] as const;
export type Source = (typeof SOURCES)[number];
export const QUANTILES = [0.1, 0.5, 0.9] as const;

export interface DayMetrics {
  mae_pct_of_capacity: number;
  mae_gw: number;
  coverage_p10_p90_pct: number;
  skill_vs_simple: number;
  holdout_mae_pct_of_capacity: number;
  holdout_coverage_p10_p90_pct: number;
  holdout_skill_vs_simple: number;
  quality: "high" | "medium" | "low";
}

export interface SourceMeta {
  merkmale: string[];
  cqr: Record<string, number>;
  kennzahlen: {
    je_tag: Record<string, DayMetrics>;
    holdout_calibrated: boolean;
    pruefung: {
      rollierend_von: string;
      rollierend_bis: string;
      abstand_tage: number;
      abschluss_von: string;
      abschluss_bis: string;
      abschluss_kalibriert: boolean;
      abschluss_abstand_tage: number;
    };
    guete_grenzen: { high: number; medium: number };
    day1_vs_tso: { model_mae_pct: number; tso_mae_pct: number };
  };
}

export interface CapacityMeta {
  monate: Record<string, number>;
  geschaetzt_ab: string | null;
  trend_mw_je_monat: number;
}

export interface ModelMeta {
  version: string;
  trainiert_bis: string;
  erstellt: string;
  modell_wetter: string;
  parameter: Record<string, unknown>;
  orte: Place[];
  variablen: Record<string, string[]>;
  quellen: Record<Source, SourceMeta>;
  kapazitaet: Record<Source, CapacityMeta>;
}

export interface ModelBundle {
  meta: ModelMeta;
  models: Record<Source, CompactModel[]>; // index = quantile index
}

const MODEL_DIR = new URL("../../models/", import.meta.url);
let bundle: ModelBundle | undefined;

export function loadModels(dir: URL = MODEL_DIR): ModelBundle {
  if (bundle && dir === MODEL_DIR) return bundle;
  const read = (name: string) => JSON.parse(readFileSync(new URL(name, dir), "utf8")) as unknown;
  const meta = read("modell.json") as ModelMeta;
  const models = {} as Record<Source, CompactModel[]>;
  for (const s of SOURCES) {
    models[s] = QUANTILES.map((q) => {
      const m = read(`${s}_p${Math.round(q * 100)}.json`) as CompactModel;
      if (m.merkmale.join() !== meta.quellen[s].merkmale.join()) throw new Error(`feature order of ${s} differs`);
      return m;
    });
  }
  const loaded = { meta, models };
  if (dir === MODEL_DIR) bundle = loaded;
  return loaded;
}

/** Weather type of a source (the places it uses). */
export function placeType(source: Source): string {
  return source === "solar" ? "solar" : source === "wind_onshore" ? "wind" : "offshore";
}

/** Lower lead day N and weight w of day N+1 for a lead of L hours after the run start. */
export function leadDays(leadHours: number): [number, number] {
  const x = Math.min(6, Math.max(1, (leadHours - 3) / 24));
  const n = Math.min(Math.floor(x), 5);
  return [n, x - n];
}

function sorted3(p: number[]): number[] {
  return [...p].sort((a, b) => a - b);
}

const clip01 = (v: number) => Math.min(1, Math.max(0, v));

/** p10/p50/p90 utilization for a fixed lead day: sorted, clipped, calibrated. */
export function predictDay(bundle: ModelBundle, source: Source, row: Float64Array, day: number): number[] {
  const names = bundle.meta.quellen[source].merkmale;
  const x = Float64Array.from(row);
  x[names.indexOf("vorlauf_tag")] = day;
  const p = sorted3(bundle.models[source].map((m) => predictModel(m, x))).map(clip01);
  const k = bundle.meta.quellen[source].cqr[String(day)] ?? 0;
  return [clip01(p[0]! - k), p[1]!, clip01(p[2]! + k)];
}

/** Operational prediction for one row: interpolated between lead days, night = 0. */
export function predictRow(bundle: ModelBundle, source: Source, row: Float64Array, leadHours: number, night: boolean): number[] {
  if (night) return [0, 0, 0];
  const [n, w] = leadDays(leadHours);
  const lo = predictDay(bundle, source, row, n);
  if (w === 0) return lo;
  const hi = predictDay(bundle, source, row, n + 1);
  return sorted3(lo.map((v, i) => (1 - w) * v + w * hi[i]!));
}

/** Installed capacity in MW for the Berlin month of an instant; beyond the table the trend continues. */
export function capacityMw(meta: CapacityMeta, ms: number): { mw: number; estimated: boolean } {
  const local = new Date(ms + berlinOffsetMinutes(ms) * 60_000);
  const key = `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, "0")}`;
  const months = Object.keys(meta.monate).sort();
  const hit = meta.monate[key];
  const estimated = (meta.geschaetzt_ab !== null && key >= meta.geschaetzt_ab) || hit === undefined;
  if (hit !== undefined) return { mw: hit, estimated };
  const last = months[months.length - 1]!;
  const [ly, lm] = last.split("-").map(Number) as [number, number];
  const diff = (local.getUTCFullYear() - ly) * 12 + (local.getUTCMonth() + 1 - lm);
  return { mw: meta.monate[last]! + Math.max(0, diff) * meta.trend_mw_je_monat, estimated };
}
