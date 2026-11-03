/**
 * forecast_renewables: probabilistic forecast (p10/p50/p90) of solar, wind
 * onshore and wind offshore generation in Germany up to 6 days ahead, from
 * the smard-forecast models. describe_forecast_model: how these numbers are
 * made and how accurate they were, generated from the same model files.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ATTRIBUTION, findSeries } from "../catalog.js";
import { warn } from "../context.js";
import { loadModels, SOURCES, type ModelBundle, type Source } from "../forecast/model.js";
import { readMonitorReport, type MonitorReport } from "../forecast/monitor.js";
import { currentForecast, worse, type HourForecast, type Quality } from "../forecast/run.js";
import type { WeatherClient } from "../forecast/weather.js";
import type { SmardClient } from "../smard.js";
import { berlinDayFloor, formatBerlin, nextIntervalStart, parseTime } from "../time.js";
import { InputError, READ_ONLY_REMOTE, commonFields, fmt1, guarded, round2, toolResult } from "./common.js";

const HOUR = 3_600_000;
export const WEATHER_ATTRIBUTION = "Weather data: Open-Meteo.com (CC BY 4.0), models of the DWD; installed capacity: Energy-Charts.info (CC BY 4.0)";

export const MODEL_NOTICE =
  "These values are estimates of a statistical model (smard-forecast: machine learning on DWD ICON weather forecasts), " +
  "not measurements and not an official forecast. They can be wrong; the actual value is expected between p10 and p90 " +
  "about 80 % of the time. describe_forecast_model explains how they are made and how accurate they were.";

const NAMES: Record<Source, string> = { solar: "Solar (photovoltaics)", wind_onshore: "Wind onshore", wind_offshore: "Wind offshore" };
const OFFICIAL_KEYS: Record<Source, string> = {
  solar: "forecast_generation_solar",
  wind_onshore: "forecast_generation_wind_onshore",
  wind_offshore: "forecast_generation_wind_offshore",
};

const band = z.object({ p10: z.number(), p50: z.number(), p90: z.number() });
const intervalSchema = z.object({
  start: z.string(),
  end: z.string(),
  hours: z.number().describe("Forecast hours inside the interval"),
  gw: band.optional().describe("Hourly resolution: mean power in GW"),
  gwh: band.optional().describe("Daily resolution: energy in GWh (sum of the hourly quantiles)"),
  official_forecast: z
    .number()
    .nullable()
    .describe("Day-ahead forecast of the transmission system operators (SMARD), same unit; null where not published"),
  lead_days: z.string().describe("Lead time in days after the weather run, e.g. 2 or 2-3"),
  quality: z.enum(["high", "medium", "low"]).describe("Measured skill at this lead time: high >= 0.4, medium >= 0.2, low < 0.2 (see describe_forecast_model)"),
});

/** Monitoring in operation: only lead days with at least a day of comparable hours. */
const MIN_MONITOR_HOURS = 24;

const recentSchema = z
  .object({
    window_days: z.number(),
    forecasts: z.number().describe("Archived forecasts compared with SMARD's measurements"),
    created: z.string(),
    sources: z.record(
      z.string(),
      z.array(
        z.object({
          lead_day: z.number(),
          hours: z.number(),
          mae_gw: z.number().nullable(),
          mae_pct_of_capacity: z.number().nullable(),
          coverage_p10_p90_pct: z.number().nullable(),
        }),
      ),
    ),
  })
  .nullable()
  .describe("Measured accuracy in operation over the last days (null until monitoring has data); lead days with fewer than 24 comparable hours are left out");

function recentAccuracy(report: MonitorReport | null, sources: readonly Source[]) {
  if (!report) return null;
  const out: Record<string, MonitorReport["sources"][Source]> = {};
  for (const s of sources) out[s] = report.sources[s].filter((d) => d.hours >= MIN_MONITOR_HOURS);
  return { window_days: report.window_days, forecasts: report.forecasts, created: report.created, sources: out };
}

const outputShape = {
  ...commonFields,
  recent_accuracy: recentSchema,
  model_notice: z.string().describe("Always pass this on: the values are model estimates"),
  model_version: z.string(),
  trained_until: z.string(),
  weather_runs: z.array(z.object({ model: z.string(), run_start: z.string() })).describe("Start of the newest run of each ICON model used"),
  from: z.string(),
  to: z.string(),
  resolution: z.enum(["hour", "day"]),
  covered_until: z.string().nullable(),
  complete: z.boolean().describe("False if the range reaches beyond the forecast horizon"),
  sources: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      capacity_gw: z.number().describe("Installed capacity assumed for the month"),
      capacity_estimated: z.boolean().describe("True if the capacity is extrapolated, not yet published"),
      total_gwh: band.describe("Energy over the whole range (sum of the hourly quantiles)"),
      intervals: z.array(intervalSchema),
    }),
  ),
  notes: z.array(z.string()),
  source: z.string(),
};

function leadText(hours: HourForecast[]): string {
  const days = hours.map((h) => Math.min(6, Math.max(1, Math.round((h.leadHours - 3) / 24))));
  const lo = Math.min(...days);
  const hi = Math.max(...days);
  return lo === hi ? String(lo) : `${lo}-${hi}`;
}

async function officialHourly(client: SmardClient, source: Source, from: number, to: number): Promise<Map<number, number>> {
  const info = findSeries(OFFICIAL_KEYS[source])!;
  try {
    const points = await client.getRange(info.filter, "DE", "hour", from, to);
    return new Map(points.map((p) => [p.timestamp, p.value / 1000]));
  } catch (err) {
    warn(`The official forecast of ${NAMES[source]} could not be loaded (${(err as Error).message})`);
    return new Map();
  }
}

export interface ForecastArgs {
  from?: string;
  to?: string;
  sources?: Source[];
  resolution?: "hour" | "day";
}

export async function runForecast(client: SmardClient, weather: WeatherClient, args: ForecastArgs, now = Date.now()) {
  const run = await currentForecast(weather, now);
  const bundle = run.bundle;
  const currentHour = Math.floor(now / HOUR) * HOUR;
  let from: number;
  let to: number;
  try {
    from = args.from ? parseTime(args.from) : currentHour;
    to = args.to ? parseTime(args.to, true) : run.endExclusive;
  } catch (err) {
    throw new InputError((err as Error).message);
  }
  const lastPossible = formatBerlin(run.endExclusive);
  if (from >= run.endExclusive) throw new InputError(`The forecast reaches until ${lastPossible} (6 days of lead time after the newest weather run).`);
  if (to <= from) throw new InputError('"to" must be after "from".');
  if (to <= currentHour) throw new InputError("The range lies in the past. Use get_generation_mix or get_series for measured generation.");
  const notes: string[] = [];
  if (from < currentHour) {
    from = currentHour;
    notes.push(`The range starts in the past; the forecast starts with the current hour ${formatBerlin(from)}.`);
  }
  from = Math.floor(from / HOUR) * HOUR;
  const end = Math.min(to, run.endExclusive);
  if (to > run.endExclusive) notes.push(`The forecast reaches only until ${lastPossible}; later hours are not included.`);
  const resolution = args.resolution ?? (end - from <= 48 * HOUR ? "hour" : "day");
  const sources = args.sources && args.sources.length > 0 ? SOURCES.filter((s) => args.sources!.includes(s)) : [...SOURCES];

  const out = [];
  let anyLow = false;
  let anyEstimated = false;
  for (const source of sources) {
    const sf = run.sources[source];
    const hours = sf.hours.filter((h) => h.start >= from && h.start < end);
    const official = await officialHourly(client, source, from, end);
    const groups = new Map<number, HourForecast[]>();
    for (const h of hours) {
      const key = resolution === "hour" ? h.start : berlinDayFloor(h.start);
      groups.set(key, [...(groups.get(key) ?? []), h]);
    }
    const intervals = [...groups].map(([start, hs]) => {
      const sum = (k: number) => round2(hs.reduce((a, h) => a + h.gw[k]!, 0));
      const values = { p10: sum(0), p50: sum(1), p90: sum(2) };
      const off = hs.map((h) => official.get(h.start));
      const offSum = off.every((v) => v !== undefined) ? round2(off.reduce((a, v) => a! + v!, 0)!) : null;
      const quality = hs.map((h) => h.quality).reduce<Quality>((a, b) => worse(a, b), "high");
      if (quality === "low") anyLow = true;
      const intervalEnd = resolution === "hour" ? start + HOUR : nextIntervalStart(start, "day");
      return {
        start: formatBerlin(start),
        end: formatBerlin(intervalEnd),
        hours: hs.length,
        ...(resolution === "hour" ? { gw: values } : { gwh: values }),
        official_forecast: offSum,
        lead_days: leadText(hs),
        quality,
      };
    });
    const cap = sf.capacityMw(from);
    if (cap.estimated) anyEstimated = true;
    const total = (k: number) => round2(hours.reduce((a, h) => a + h.gw[k]!, 0));
    out.push({
      key: source,
      name: NAMES[source],
      capacity_gw: round2(cap.mw / 1000),
      capacity_estimated: cap.estimated,
      total_gwh: { p10: total(0), p50: total(1), p90: total(2) },
      intervals,
    });
  }
  if (resolution === "day") {
    notes.push("Daily and total p10/p90 are sums of the hourly quantiles; this assumes the errors of one day move together, so the band is rather wide than narrow.");
  }
  if (anyLow) notes.push('Intervals with quality "low" are barely better than a simple seasonal average; treat them as a rough indication.');
  if (anyEstimated) notes.push("The installed capacity for this month is extrapolated from the trend; the forecast in GW scales with it.");
  notes.push("Solar is 0 at night. Germany as a whole; no regional breakdown.");
  const recent = recentAccuracy(readMonitorReport(), sources);
  if (!recent) notes.push("Accuracy in operation is not yet available; see describe_forecast_model for the validation results.");
  const coveredUntil = end > from ? formatBerlin(end) : null;
  return {
    model_notice: MODEL_NOTICE,
    model_version: bundle.meta.version,
    trained_until: bundle.meta.trainiert_bis,
    weather_runs: run.weather.runs.map((r) => ({ model: r.model, run_start: formatBerlin(r.initMs) })),
    from: formatBerlin(from),
    to: formatBerlin(to),
    resolution,
    covered_until: coveredUntil,
    complete: to <= run.endExclusive,
    sources: out,
    recent_accuracy: recent,
    notes,
    source: `${ATTRIBUTION}; ${WEATHER_ATTRIBUTION}; model: smard-forecast ${bundle.meta.version}`,
  };
}

type ForecastResult = Awaited<ReturnType<typeof runForecast>>;

function bandText(b: { p10: number; p50: number; p90: number }, unit: string): string {
  return `${fmt1(b.p50)} ${unit} (p10 to p90: ${fmt1(b.p10)} to ${fmt1(b.p90)})`;
}

function forecastText(r: ForecastResult): string {
  const lines = [`Notice: ${r.model_notice}`, `Forecast ${r.from} to ${r.covered_until ?? r.to}, ${r.resolution} values, model ${r.model_version}:`];
  for (const s of r.sources) {
    lines.push(`${s.name}: total ${bandText(s.total_gwh, "GWh")}`);
    for (const i of s.intervals) {
      const v = "gw" in i ? bandText(i.gw, "GW") : bandText(i.gwh, "GWh");
      const off = i.official_forecast === null ? "" : `, official ${fmt1(i.official_forecast)}`;
      const full = (Date.parse(i.end) - Date.parse(i.start)) / HOUR;
      const part = i.hours < full ? `, only ${i.hours} of ${full} hours` : "";
      lines.push(`- ${i.start}: ${v}${off}${part}, lead day ${i.lead_days}, quality ${i.quality}`);
    }
  }
  for (const n of r.notes) lines.push(`Note: ${n}`);
  lines.push(`Source: ${r.source}`);
  return lines.join("\n");
}

const monthText = (ym: string) => `${ym.slice(5)}/${ym.slice(0, 4)}`;

/** How the accuracy figures were measured, from the model files. */
function validationText(m: ModelBundle["meta"]): string {
  const k = m.quellen.wind_onshore.kennzahlen;
  const p = k.pruefung;
  const g = k.guete_grenzen;
  const parts = [
    `Rolling: for each month from ${monthText(p.rollierend_von)} to ${monthText(p.rollierend_bis)} a model was trained only on data ending ${p.abstand_tage} days before that month, then tested on it; the calibration of each month was learned only from earlier months.`,
    `Holdout: ${monthText(p.abschluss_von)} to ${monthText(p.abschluss_bis)}, used once.`,
  ];
  for (const s of SOURCES) {
    const q = m.quellen[s].kennzahlen.pruefung;
    if (!q.abschluss_kalibriert || q.abschluss_abstand_tage !== p.abstand_tage) {
      const missing = [q.abschluss_kalibriert ? null : "calibration", q.abschluss_abstand_tage === p.abstand_tage ? null : "the gap before the test months"].filter((x) => x !== null);
      parts.push(`For ${NAMES[s]} the holdout ran without ${missing.join(" and ")} (an earlier stage of the method); compare its holdout coverage with care.`);
    }
  }
  parts.push(
    `skill_vs_simple = 1 - MAE / MAE of the better of climatology (mean by month and hour) and persistence (same hour of the last known day). quality: high >= ${g.high}, medium >= ${g.medium}, low below, using the worse of rolling and holdout.`,
  );
  return parts.join(" ");
}

/** Known weaknesses; the lead days rated low come from the model files. */
function limitations(m: ModelBundle["meta"]): string[] {
  const low = SOURCES.map((s) => {
    const days = Object.entries(m.quellen[s].kennzahlen.je_tag)
      .filter(([, d]) => d.quality === "low")
      .map(([day]) => day);
    return days.length > 0 ? `${NAMES[s]} day ${days.join(", ")}` : null;
  }).filter((x) => x !== null);
  const tsoBetter = SOURCES.filter((s) => m.quellen[s].kennzahlen.day1_vs_tso.tso_mae_pct < m.quellen[s].kennzahlen.day1_vs_tso.model_mae_pct);
  const out: string[] = [];
  if (tsoBetter.length > 0) {
    out.push(
      `Day 1: the transmission system operators' own forecast is more accurate for ${tsoBetter.map((s) => NAMES[s]).join(", ")} (see day1_vs_tso); it is shown next to ours as official_forecast.`,
    );
  }
  if (low.length > 0) out.push(`Rated low (skill below ${m.quellen.solar.kennzahlen.guete_grenzen.medium} against simple baselines): ${low.join("; ")}.`);
  out.push(
    "Germany only, no regional breakdown; curtailment and grid congestion are not modelled explicitly.",
    "Daily sums of hourly quantiles are approximations, not true daily quantiles.",
  );
  return out;
}

/** The model description, generated from the model files. */
export function describeModel(bundle: ModelBundle) {
  const m = bundle.meta;
  const sources = SOURCES.map((s) => {
    const k = m.quellen[s].kennzahlen;
    return {
      key: s,
      name: NAMES[s],
      weather_places: m.orte.filter((o) => o.typ.includes(s === "solar" ? "solar" : s === "wind_onshore" ? "wind" : "offshore")).length,
      features: m.quellen[s].merkmale.length,
      day1_vs_tso: { model_mae_pct_of_capacity: k.day1_vs_tso.model_mae_pct, tso_mae_pct_of_capacity: k.day1_vs_tso.tso_mae_pct },
      by_lead_day: Object.entries(k.je_tag).map(([day, d]) => ({
        lead_day: Number(day),
        mae_pct_of_capacity: d.mae_pct_of_capacity,
        mae_gw: d.mae_gw,
        coverage_p10_p90_pct: d.coverage_p10_p90_pct,
        skill_vs_simple: d.skill_vs_simple,
        holdout_mae_pct_of_capacity: d.holdout_mae_pct_of_capacity,
        holdout_coverage_p10_p90_pct: d.holdout_coverage_p10_p90_pct,
        holdout_skill_vs_simple: d.holdout_skill_vs_simple,
        quality: d.quality,
        calibration_widening_pct: round2((m.quellen[s].cqr[day] ?? 0) * 100),
      })),
    };
  });
  return {
    model_notice: MODEL_NOTICE,
    model_version: m.version,
    trained_until: m.trainiert_bis,
    created: m.erstellt,
    target: "Hourly utilization (generation / installed capacity of the month) for Germany as a whole; GW = utilization x capacity.",
    weather_input: `Open-Meteo ${m.modell_wetter} (DWD ICON-D2, ICON-EU, ICON global), ${m.orte.length} places; training data from the Previous Runs API (forecasts as they were 1 to 6 days ahead), so training sees the same forecast errors as operation.`,
    method:
      "LightGBM gradient-boosted trees with quantile loss, one model per source and quantile (p10, p50, p90), all lead days in one model with the lead day as a feature. " +
      `Parameters: ${Object.entries(m.parameter)
        .filter(([k]) => ["num_leaves", "learning_rate", "n_estimators", "min_child_samples", "colsample_bytree", "subsample"].includes(k))
        .map(([k, v]) => `${k} ${String(v)}`)
        .join(", ")}.`,
    features:
      "Per place: radiation (global, direct, diffuse; hour-ending values shifted to the SMARD hour), temperature, cloud cover, wind speed 10 m and 100 m, gusts, wind direction (as sine and cosine), surface pressure; " +
      "means over all places; hour and day of year as sine/cosine, solar elevation, weekday, nationwide holidays, lead day.",
    lead_time:
      "Lead L = hour minus start of the weather run that covers it. The models know lead days 1 to 6 (about 24 to 150 h); in between, the forecasts of the two neighbouring lead days are blended linearly with x = (L - 3 h) / 24 h.",
    calibration:
      "Conformalized quantile regression: the p10/p90 band is widened per lead day so that about 80 % of past out-of-sample values fell inside it (calibration_widening_pct, in % of capacity).",
    validation: validationText(m),
    capacity: `Installed capacity per month from Energy-Charts (Fraunhofer ISE); newer months extrapolated from the trend (solar ${m.kapazitaet.solar.trend_mw_je_monat} MW/month, wind onshore ${m.kapazitaet.wind_onshore.trend_mw_je_monat} MW/month, offshore held constant).`,
    limitations: limitations(m),
    recent_accuracy: recentAccuracy(readMonitorReport(), SOURCES),
    sources,
    source: `${ATTRIBUTION}; ${WEATHER_ATTRIBUTION}; code: github.com/akquisio-dev/smard-forecast`,
  };
}

function describeText(d: ReturnType<typeof describeModel>): string {
  const lines = [
    `smard-forecast model ${d.model_version} (trained until ${d.trained_until})`,
    `Notice: ${d.model_notice}`,
    `Target: ${d.target}`,
    `Weather input: ${d.weather_input}`,
    `Method: ${d.method}`,
    `Features: ${d.features}`,
    `Lead time: ${d.lead_time}`,
    `Calibration: ${d.calibration}`,
    `Validation: ${d.validation}`,
    `Capacity: ${d.capacity}`,
    "Accuracy (rolling validation; MAE in % of capacity and GW, coverage of p10 to p90, skill, quality):",
  ];
  for (const s of d.sources) {
    lines.push(`${s.name} (${s.weather_places} places, ${s.features} features):`);
    for (const r of s.by_lead_day) {
      lines.push(
        `- day ${r.lead_day}: MAE ${r.mae_pct_of_capacity} % (${r.mae_gw} GW), coverage ${r.coverage_p10_p90_pct} %, skill ${r.skill_vs_simple}, holdout skill ${r.holdout_skill_vs_simple}, quality ${r.quality}`,
      );
    }
    lines.push(`- day 1 against the TSO forecast: ours ${s.day1_vs_tso.model_mae_pct_of_capacity} %, TSO ${s.day1_vs_tso.tso_mae_pct_of_capacity} %`);
  }
  if (d.recent_accuracy) {
    lines.push(`Accuracy in operation (last ${d.recent_accuracy.window_days} days, ${d.recent_accuracy.forecasts} archived forecasts compared with SMARD):`);
    for (const [src, days] of Object.entries(d.recent_accuracy.sources)) {
      for (const r of days) lines.push(`- ${NAMES[src as Source]} day ${r.lead_day}: MAE ${r.mae_gw} GW (${r.mae_pct_of_capacity} %), coverage ${r.coverage_p10_p90_pct} %, ${r.hours} hours`);
    }
  } else {
    lines.push("Accuracy in operation: monitoring has no data yet.");
  }
  lines.push("Limitations:");
  for (const l of d.limitations) lines.push(`- ${l}`);
  lines.push(`Source: ${d.source}`);
  return lines.join("\n");
}

export function registerForecast(server: McpServer, client: SmardClient, weather: WeatherClient): void {
  server.registerTool(
    "forecast_renewables",
    {
      title: "Renewable generation forecast",
      description:
        "Model forecast of solar, wind onshore and wind offshore generation in Germany for the coming hours up to 6 days: " +
        "median (p50) with a p10 to p90 range per hour (GW) or per day (GWh), the transmission system operators' official day-ahead forecast next to it where published, " +
        "and a quality level per interval. The values are estimates of our own model, not measurements: always pass on model_notice. " +
        "Without from/to: from the current hour to the end of the horizon. For how the model works and how accurate it is, use describe_forecast_model.",
      inputSchema: {
        from: z.string().optional().describe("Start, YYYY-MM-DD or ISO 8601 date-time (Berlin time if no offset). Default: current hour."),
        to: z.string().optional().describe("End (exclusive); a plain YYYY-MM-DD includes that day. Default: end of the forecast horizon."),
        sources: z.array(z.enum(SOURCES)).optional().describe("Default: all three"),
        resolution: z.enum(["hour", "day"]).optional().describe("Default: hour for up to 48 hours, else day"),
      },
      outputSchema: outputShape,
      annotations: { title: "Renewable generation forecast", ...READ_ONLY_REMOTE },
    },
    async (args) =>
      guarded(async () => {
        const result = await runForecast(client, weather, args);
        return toolResult(forecastText(result), result);
      }),
  );

  server.registerTool(
    "describe_forecast_model",
    {
      title: "How the forecast model works",
      description:
        "Short technical description of the model behind forecast_renewables: data, features, method, lead-time handling, calibration, validation, " +
        "measured accuracy per source and lead day, and known limitations. Use it when someone asks how the forecast values come about or how reliable they are.",
      inputSchema: {},
      annotations: { title: "How the forecast model works", readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      guarded(async () => {
        const d = describeModel(loadModels());
        return toolResult(describeText(d), d);
      }),
  );
}
