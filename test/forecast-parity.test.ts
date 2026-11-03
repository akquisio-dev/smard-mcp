/**
 * Parity with the Python reference (smard-forecast scripts/phase4_vergleich.py):
 * the same raw Open-Meteo answer and the same models must give the same
 * forecast. Python computes the weather features in float32; features.ts
 * reproduces that with Math.fround (including pandas' float32 summation in
 * the means), so both agree to the 7 decimals stored in the fixture.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildFeatures, type PlaceSeries } from "../src/forecast/features.js";
import { loadModels, placeType, predictRow, SOURCES } from "../src/forecast/model.js";
import { runStartFor, type ModelRun } from "../src/forecast/weather.js";

interface Fixture {
  modell: string;
  laeufe: { model: string; init: number; ende: number }[];
  antwort: { hourly: Record<string, (number | null)[]> & { time: string[] } }[];
  erwartet: Record<string, { zeit: string[]; vorlauf_h: number[]; p: number[][]; merkmale_zeile_30: (number | null)[] }>;
}

const fx = JSON.parse(readFileSync(new URL("./fixtures/forecast-parity.json", import.meta.url), "utf8")) as Fixture;
const bundle = loadModels();
const runs: ModelRun[] = fx.laeufe.map((l) => ({ model: l.model, initMs: l.init * 1000, dataEndMs: l.ende * 1000 }));

const series = new Map<string, PlaceSeries>();
bundle.meta.orte.forEach((p, i) => {
  const h = fx.antwort[i]!.hourly;
  series.set(p.name, { time: h.time.map((t) => Date.parse(`${t}:00Z`)), values: h });
});

describe("forecast parity with the Python reference", () => {
  it("uses the model version of the fixture", () => {
    expect(bundle.meta.version).toBe(fx.modell);
  });

  for (const source of SOURCES) {
    it(`${source}: features and p10/p50/p90 match`, () => {
      const exp = fx.erwartet[source]!;
      const names = bundle.meta.quellen[source].merkmale;
      const places = bundle.meta.orte.filter((p) => p.typ.includes(placeType(source)));
      const f = buildFeatures(names, places, series, bundle.meta.variablen[placeType(source)]!);
      expect(f.time.map((t) => new Date(t).toISOString().slice(0, 16) + "Z")).toEqual(exp.zeit);

      const row = f.rows[30]!;
      exp.merkmale_zeile_30.forEach((v, j) => {
        if (v === null) expect(Number.isNaN(row[j]!), names[j]).toBe(true);
        else expect(Math.abs(row[j]! - v), names[j]).toBeLessThan(1e-5 * Math.max(1, Math.abs(v)));
      });

      let worst = 0;
      f.rows.forEach((r, i) => {
        const lead = (f.time[i]! - runStartFor(runs, f.time[i]!)) / 3_600_000;
        expect(lead).toBeCloseTo(exp.vorlauf_h[i]!, 3);
        const night = source === "solar" && f.sunMax[i]! <= 0;
        const p = predictRow(bundle, source, r, lead, night);
        p.forEach((v, k) => (worst = Math.max(worst, Math.abs(v - exp.p[i]![k]!))));
      });
      expect(worst).toBeLessThan(1e-6);
    });
  }
});
