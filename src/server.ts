import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ATTRIBUTION } from "./catalog.js";
import { SmardClient } from "./smard.js";
import { registerMarketOverview } from "./tools/market-overview.js";
import { registerBestHours } from "./tools/best-hours.js";
import { registerCo2Intensity } from "./tools/co2.js";
import { registerAnalyzePrices } from "./tools/prices.js";
import { registerComparePeriods } from "./tools/compare-periods.js";
import { registerGenerationMix } from "./tools/generation-mix.js";
import { registerSeriesTools } from "./tools/series.js";

export const SERVER_NAME = "smard-mcp";
export const SERVER_VERSION = "0.3.0";

export { MAX_POINTS } from "./tools/series.js";

export function createServer(client: SmardClient = new SmardClient()): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: [
        "German electricity market data from SMARD (Bundesnetzagentur). All times are Europe/Berlin.",
        "Which tool to use:",
        "- get_generation_mix: how electricity was generated in a period (shares by source, renewable share, consumption). First choice for questions like 'how much solar/coal yesterday' or 'renewable share in March'.",
        "- compare_periods: two periods side by side (e.g. this October vs. last October, week vs. week), including the mean price for Germany. Put the baseline (usually the older period) in A; differences are the change from A to B.",
        "- analyze_prices: day-ahead prices DE-LU in detail (mean, negative hours, cheapest/most expensive hours, daily means) plus the mean of the 30 days before, so 'was it expensive?' needs one call. Tomorrow's prices exist after the auction around noon.",
        "- get_series: raw values of a single series, including forecasts, neighbouring price zones, AT/LU and single TSO zones; use include_points=false for totals only.",
        "- list_series: available series keys, regions and the current server time.",
        "Energy is reported in GWh (get_series: MWh per interval), prices in EUR/MWh. Check complete, covered_until and notes: recent data may be incomplete.",
        "Analysis tools return an error for periods without any data (e.g. the future); use get_series with forecast_* series or price_de_lu for those.",
        `Cite the source as "${ATTRIBUTION}" when presenting the data.`,
      ].join("\n"),
    },
  );

  registerSeriesTools(server, client);
  registerGenerationMix(server, client);
  registerComparePeriods(server, client);
  registerAnalyzePrices(server, client);
  registerCo2Intensity(server, client);
  registerBestHours(server, client);
  registerMarketOverview(server, client);

  return server;
}
