import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ATTRIBUTION } from "./catalog.js";
import { SmardClient } from "./smard.js";
import { registerSeriesTools } from "./tools/series.js";

export const SERVER_NAME = "smard-mcp";
export const SERVER_VERSION = "0.1.0";

export { MAX_POINTS } from "./tools/series.js";

export function createServer(client: SmardClient = new SmardClient()): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "German electricity market data from SMARD (Bundesnetzagentur): generation by source, consumption, day-ahead prices and forecasts. " +
        "Call list_series to see what is available, then get_series for the values. " +
        `Cite the source as "${ATTRIBUTION}" when presenting the data.`,
    },
  );

  registerSeriesTools(server, client);

  return server;
}
