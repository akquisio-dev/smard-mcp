/**
 * Daily monitoring run for forecast_renewables (systemd timer, see
 * deploy/forecast-monitor.*). Reads the smard-forecast archive, recomputes
 * the forecasts the tool would have given and writes their measured accuracy
 * to a JSON file that the server reads.
 *
 * Environment: SMARD_FORECAST_ARCHIVE (archive directory),
 * SMARD_MCP_FORECAST_MONITOR (output file).
 */

import { renameSync, writeFileSync } from "node:fs";
import { buildMonitorReport, DEFAULT_ARCHIVE_DIR, DEFAULT_MONITOR_FILE } from "./forecast/monitor.js";
import { SmardClient } from "./smard.js";

const archive = process.env.SMARD_FORECAST_ARCHIVE ?? DEFAULT_ARCHIVE_DIR;
const out = process.env.SMARD_MCP_FORECAST_MONITOR ?? DEFAULT_MONITOR_FILE;

const report = await buildMonitorReport(new SmardClient(), archive);
writeFileSync(`${out}.tmp`, JSON.stringify(report, null, 1));
renameSync(`${out}.tmp`, out);
const lines = Object.entries(report.sources).map(
  ([s, days]) => `${s}: ${days.map((d) => `T${d.lead_day} ${d.hours} h MAE ${d.mae_gw ?? "-"} GW Treffer ${d.coverage_p10_p90_pct ?? "-"} %`).join(" | ")}`,
);
console.log(`forecast monitor: ${report.forecasts} forecasts, model ${report.model_version}, written to ${out}`);
for (const l of lines) console.log(l);
