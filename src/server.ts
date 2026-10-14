import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ATTRIBUTION } from "./catalog.js";
import { registerPrompts } from "./prompts.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";
import { SmardClient } from "./smard.js";
import { registerPlanCharging } from "./tools/charging.js";
import { registerCurrentStatus } from "./tools/current-status.js";
import { registerMarketOverview } from "./tools/market-overview.js";
import { registerCrossBorderFlows } from "./tools/flows.js";
import { registerBestHours } from "./tools/best-hours.js";
import { registerCo2Intensity } from "./tools/co2.js";
import { registerAnalyzePrices } from "./tools/prices.js";
import { registerComparePeriods } from "./tools/compare-periods.js";
import { registerGenerationMix } from "./tools/generation-mix.js";
import { registerSeriesTools } from "./tools/series.js";

export { SERVER_NAME, SERVER_VERSION } from "./version.js";

export { MAX_POINTS } from "./tools/series.js";

export function createServer(client: SmardClient = new SmardClient()): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: [
        "German electricity market data from SMARD (Bundesnetzagentur). All times are Europe/Berlin.",
        "Which tool to use:",
        "- get_current_status: what is happening right now (power per source in GW with utilization of installed capacity, consumption, net export, CO2, current price, hourly outlook) for the newest quarter-hour SMARD has published. First choice for 'right now' questions.",
        "- get_market_overview: one day at a glance (mix, renewable share, CO2, consumption, prices with 30-day context, outlook for the next day).",
        "- plan_charging: when to charge an electric car or battery between plug-in and departure (also over midnight), given kWh and kW; cheapest/greenest intervals, not necessarily contiguous, and the savings in euros compared with charging right away.",
        "- find_best_hours: cheapest and/or greenest contiguous time window of one day for appliances with a fixed run time (washing machine, dishwasher, heat pump). For today it uses the intraday forecast.",
        "- get_co2_intensity: estimated CO2 intensity per hour, cleanest/dirtiest hours and total emissions. Always say it is an estimate (generation-based, without imports/exports, direct emissions only) and an average of the generation mix, not the marginal emissions of additional consumption.",
        "- get_cross_border_flows: electricity exchanged with neighbouring countries (net import/export, per country, peak hours, with country or include_intervals also per hour or day); physical = measured flows, commercial = scheduled trades.",
        "- get_generation_mix: how electricity was generated in a period (shares by source, renewable share, consumption). First choice for questions like 'how much solar/coal yesterday' or 'renewable share in March'.",
        "- compare_periods: two periods side by side (e.g. this October vs. last October, week vs. week), including the mean price for Germany. Put the baseline (usually the older period) in A; differences are the change from A to B.",
        "- analyze_prices: day-ahead prices DE-LU in detail (mean, negative hours, cheapest/most expensive hours, daily means) plus the mean of the 30 days before, so 'was it expensive?' needs one call. Tomorrow's prices exist after the auction around noon.",
        "- get_series: raw values of a single series, including forecasts, neighbouring price zones, installed capacity per source (capacity_*, MW per year), AT/LU and single TSO zones; use include_points=false for totals only.",
        "- list_series: available series keys, regions and the current server time.",
        "Answer short questions briefly with the few numbers asked for. Use a full report layout only when the user explicitly asks for an overview or a report; the prompts strom_uebersicht, wochen_bericht, monatsvergleich, region_vergleich and beste_stunden contain fixed German report templates for that.",
        "Energy is reported in GWh (get_series: MWh per interval, or MW with unit=MW; get_current_status: GW), prices in EUR/MWh. Every result carries server_time. Check complete, covered_until and notes: recent data may be incomplete.",
        "Analysis tools return an error for periods without any data (e.g. the future); use get_series with forecast_* series or price_de_lu for those.",
        "If a result contains warnings (e.g. data served from the cache because SMARD did not answer), mention them.",
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
  registerCurrentStatus(server, client);
  registerPlanCharging(server, client);
  registerCrossBorderFlows(server, client);
  registerPrompts(server);

  return server;
}
