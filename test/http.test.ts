import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpApp } from "../src/http-app.js";
import { SmardClient } from "../src/smard.js";
import { SERVER_VERSION } from "../src/version.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const servers: Server[] = [];

async function start(probe?: () => Promise<boolean>, probeCacheMs?: number): Promise<string> {
  const client = new SmardClient({ fetch: (async () => new Response("", { status: 404 })) as unknown as typeof fetch });
  const server = createServer(createHttpApp({ client, probe, probeCacheMs }));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

describe("version", () => {
  it("comes from package.json", () => {
    expect(SERVER_VERSION).toBe(pkg.version);
  });
});

describe("HTTP app", () => {
  it("/health reports name and package version", async () => {
    const base = await start();
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", name: "smard-mcp", version: pkg.version });
  });

  it("/health?deep=1 checks SMARD at most every probeCacheMs", async () => {
    const probe = vi.fn().mockResolvedValue(true);
    const base = await start(probe, 60_000);
    const first = await (await fetch(`${base}/health?deep=1`)).json();
    await fetch(`${base}/health?deep=1`);
    expect(first).toMatchObject({ status: "ok", smard: { reachable: true } });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("/health?deep=1 answers 503 when SMARD is unreachable", async () => {
    const base = await start(() => Promise.reject(new Error("down")));
    const res = await fetch(`${base}/health?deep=1`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: "degraded", smard: { reachable: false } });
  });

  it("serves MCP over POST only", async () => {
    const base = await start();
    expect((await fetch(`${base}/mcp`)).status).toBe(405);
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`"version":"${pkg.version}"`);
  });

  it("rejects broken JSON", async () => {
    const base = await start();
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    expect(res.status).toBe(400);
  });
});
