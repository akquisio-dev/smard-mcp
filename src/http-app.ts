/**
 * HTTP request handling: the stateless MCP endpoint and /health.
 * Every MCP request gets its own server/transport pair, while the SMARD
 * client (and its cache) is shared. Nothing about the caller (IP address,
 * headers, request body) is logged.
 */

import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";
import type { SmardClient } from "./smard.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

const MAX_BODY_BYTES = 1_000_000;

export interface HttpAppOptions {
  client: SmardClient;
  mcpPath?: string;
  /** Checks whether SMARD answers; used by /health?deep=1. */
  probe?: () => Promise<boolean>;
  /** How long a deep health result is reused. */
  probeCacheMs?: number;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createHttpApp(options: HttpAppOptions): RequestListener {
  const mcpPath = options.mcpPath ?? "/mcp";
  const probeCacheMs = options.probeCacheMs ?? 5 * 60_000;
  let lastProbe: { at: number; ok: boolean; checkedAt: string } | null = null;
  let pendingProbe: Promise<boolean> | null = null;

  async function deepCheck() {
    if (!options.probe) return null;
    if (!lastProbe || Date.now() - lastProbe.at >= probeCacheMs) {
      pendingProbe ??= options.probe().catch(() => false);
      const ok = await pendingProbe;
      pendingProbe = null;
      lastProbe = { at: Date.now(), ok, checkedAt: new Date().toISOString() };
    }
    return { reachable: lastProbe.ok, checked_at: lastProbe.checkedAt };
  }

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      // Stateless server: no standalone SSE stream and no sessions to delete.
      res.setHeader("allow", "POST");
      sendJson(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
      return;
    }
    let body: unknown;
    try {
      body = await readBody(req);
    } catch {
      sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
      return;
    }
    const server = createServer(options.client);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/health") {
      const deep = url.searchParams.get("deep") === "1";
      if (!deep) {
        sendJson(res, 200, { status: "ok", name: SERVER_NAME, version: SERVER_VERSION });
        return;
      }
      deepCheck().then(
        (smard) => {
          const ok = smard === null || smard.reachable;
          sendJson(res, ok ? 200 : 503, { status: ok ? "ok" : "degraded", name: SERVER_NAME, version: SERVER_VERSION, smard });
        },
        () => sendJson(res, 503, { status: "degraded", name: SERVER_NAME, version: SERVER_VERSION, smard: { reachable: false } }),
      );
      return;
    }
    if (url.pathname === mcpPath) {
      handleMcp(req, res).catch((err: unknown) => {
        // Only the error itself, never the request.
        console.error("MCP request failed:", err instanceof Error ? err.message : String(err));
        if (!res.headersSent) {
          sendJson(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
        }
      });
      return;
    }
    sendJson(res, 404, { error: "Not found" });
  };
}

/** Deep health probe: the price index must load and contain timestamps. */
export function smardProbe(client: SmardClient): () => Promise<boolean> {
  return async () => (await client.getIndex(4169, "DE", "hour")).length > 0;
}
