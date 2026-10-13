/** Streamable HTTP entry point (see http-app.ts for the request handling). */

import { createServer as createHttpServer } from "node:http";
import { createHttpApp, smardProbe } from "./http-app.js";
import { SmardClient } from "./smard.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

const PORT = Number(process.env.PORT ?? 8450);
const HOST = process.env.HOST ?? "127.0.0.1";
const MCP_PATH = process.env.MCP_PATH ?? "/mcp";

const client = new SmardClient();
// The deep health check must really reach SMARD, so its client has no cache.
const probeClient = new SmardClient({ cacheTtlMs: 0, archiveCacheTtlMs: 0, timeoutMs: 5_000 });
const httpServer = createHttpServer(createHttpApp({ client, mcpPath: MCP_PATH, probe: smardProbe(probeClient) }));

httpServer.listen(PORT, HOST, () => {
  console.log(`${SERVER_NAME} ${SERVER_VERSION} listening on http://${HOST}:${PORT}${MCP_PATH}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => httpServer.close(() => process.exit(0)));
}
