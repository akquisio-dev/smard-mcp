import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { archiveRuns, buildMonitorReport, leadDayOf, readArchive, readMonitorReport } from "../src/forecast/monitor.js";
import { SmardClient } from "../src/smard.js";
import { createFakeSmard } from "./fake-smard.js";

const HOUR = 3_600_000;
const fx = JSON.parse(readFileSync(new URL("./fixtures/forecast-parity.json", import.meta.url), "utf8")) as {
  laeufe: { model: string; init: number; ende: number }[];
  antwort: { hourly: Record<string, unknown> }[];
};
const iso = (s: number) => new Date(s * 1000).toISOString().slice(0, 16) + "Z";
const fetched = fx.laeufe[0]!.init * 1000 + 1.5 * HOUR;

/** An archive directory with one file in the format of smard-forecast archiv/archiv.py. */
function archive(withEnds: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "archiv-"));
  const d = new Date(fetched);
  const sub = join(dir, String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, "0"), String(d.getUTCDate()).padStart(2, "0"));
  mkdirSync(sub, { recursive: true });
  const name = d.toISOString().slice(0, 16).replace(/[-:]/g, "") + "Z.json.gz";
  const orte = JSON.parse(readFileSync(new URL("../models/modell.json", import.meta.url), "utf8")).orte as { name: string }[];
  const entry = {
    abgerufen: d.toISOString().slice(0, 19) + "Z",
    modell: "icon_seamless",
    laeufe: Object.fromEntries(fx.laeufe.map((l) => [l.model, iso(l.init)])),
    ...(withEnds ? { laeufe_ende: Object.fromEntries(fx.laeufe.map((l) => [l.model, iso(l.ende)])) } : {}),
    orte: orte.map((o, i) => ({ name: o.name, hourly: fx.antwort[i]!.hourly })),
  };
  writeFileSync(join(sub, name), gzipSync(JSON.stringify(entry)));
  return dir;
}

describe("forecast monitoring", () => {
  it("approximates the data end of old archive files from the DWD schedule", () => {
    const r = archiveRuns({ dwd_icon_d2: "2026-11-03T06:00Z", dwd_icon_eu: "2026-11-03T03:00Z", dwd_icon: "2026-11-03T00:00Z" });
    expect(r.map((x) => (x.dataEndMs - x.initMs) / HOUR)).toEqual([48, 30, 180]);
  });

  it("counts lead days as the first, second, ... 24 hours", () => {
    expect([1, 24, 25, 48, 150, 170].map(leadDayOf)).toEqual([1, 1, 2, 2, 6, 6]);
  });

  it("reads the archive with the stored data ends", () => {
    const [e] = readArchive(archive(true), 0);
    expect(e!.runs.map((r) => r.dataEndMs / 1000)).toEqual(fx.laeufe.map((l) => l.ende));
    expect(e!.series.size).toBe(40);
  });

  it("compares archived forecasts with SMARD per lead day", async () => {
    const now = fetched + 3 * 24 * HOUR;
    const smard = new SmardClient({
      fetch: createFakeSmard({
        dataEnd: now,
        series: { 4068: { value: () => 5_000 }, 4067: { value: () => 10_000 }, 1225: { value: () => 2_000 } },
      }).fetch,
    });
    const r = await buildMonitorReport(smard, archive(true), now);
    expect(r.forecasts).toBe(1);
    const won = r.sources.wind_onshore;
    expect(won[0]!.hours).toBeGreaterThan(20);
    expect(won[2]!.hours).toBeGreaterThan(0);
    expect(won[5]!.hours).toBe(0);
    expect(won[5]!.mae_gw).toBeNull();
    expect(won[0]!.mae_gw).toBeGreaterThan(0);
    // solar: night hours are not counted
    expect(r.sources.solar[0]!.hours).toBeLessThan(won[0]!.hours);
  });

  it("ignores missing and stale report files", () => {
    const dir = mkdtempSync(join(tmpdir(), "mon-"));
    expect(readMonitorReport(join(dir, "fehlt.json"))).toBeNull();
    const f = join(dir, "alt.json");
    writeFileSync(f, JSON.stringify({ created: "2020-01-01T00:00:00Z" }));
    expect(readMonitorReport(f)).toBeNull();
  });
});
