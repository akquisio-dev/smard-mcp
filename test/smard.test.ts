import { describe, expect, it, vi } from "vitest";
import { SmardClient, SmardError, blocksForRange } from "../src/smard.js";

const WEEK = 7 * 24 * 3_600_000;
const HOUR = 3_600_000;
const B0 = Date.parse("2026-09-27T22:00:00Z");
const B1 = B0 + WEEK;

/** Fake SMARD backend serving one index and two hourly blocks. */
function fakeFetch() {
  const docs: Record<string, unknown> = {
    "4169/DE/index_hour.json": { timestamps: [B1, B0] },
    [`4169/DE/4169_DE_hour_${B0}.json`]: { series: [[B0, 10], [B0 + HOUR, 20], [B1 - HOUR, 30]] },
    [`4169/DE/4169_DE_hour_${B1}.json`]: { series: [[B1, 40], [B1 + HOUR, null]] },
  };
  return vi.fn(async (url: string | URL | Request) => {
    const path = String(url).replace("https://www.smard.de/app/chart_data/", "");
    const doc = docs[path];
    return doc ? new Response(JSON.stringify(doc)) : new Response("not found", { status: 404 });
  });
}

describe("blocksForRange", () => {
  const index = [0, 100, 200, 300];
  it("selects blocks overlapping the range", () => {
    expect(blocksForRange(index, 150, 250)).toEqual([100, 200]);
    expect(blocksForRange(index, 100, 200)).toEqual([100]);
    expect(blocksForRange(index, 350, 400)).toEqual([300]);
    expect(blocksForRange(index, -50, -10)).toEqual([]);
  });
});

describe("SmardClient", () => {
  it("returns points across blocks, without nulls, in [from, to)", async () => {
    const client = new SmardClient({ fetch: fakeFetch() });
    const points = await client.getRange(4169, "DE", "hour", B0 + HOUR, B1 + 2 * HOUR);
    expect(points).toEqual([
      { timestamp: B0 + HOUR, value: 20 },
      { timestamp: B1 - HOUR, value: 30 },
      { timestamp: B1, value: 40 },
    ]);
  });

  it("caches documents", async () => {
    const fetch = fakeFetch();
    const client = new SmardClient({ fetch });
    await client.getRange(4169, "DE", "hour", B0, B0 + HOUR);
    await client.getRange(4169, "DE", "hour", B0, B0 + HOUR);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reports missing combinations clearly", async () => {
    const client = new SmardClient({ fetch: fakeFetch() });
    await expect(client.getIndex(4169, "AT", "hour")).rejects.toThrow(/no data for this combination/);
  });

  it("refuses ranges spanning too many blocks", async () => {
    const client = new SmardClient({ fetch: fakeFetch(), maxBlocksPerQuery: 1 });
    await expect(client.getRange(4169, "DE", "hour", B0, B1 + HOUR)).rejects.toBeInstanceOf(SmardError);
  });

  it("wraps network failures", async () => {
    const client = new SmardClient({ fetch: vi.fn().mockRejectedValue(new Error("ECONNRESET")) });
    await expect(client.getIndex(4169, "DE", "hour")).rejects.toThrow(/not reachable/);
  });
});

describe("SmardClient request handling", () => {
  it("never runs more than maxConcurrentRequests fetches at once", async () => {
    let active = 0;
    let peak = 0;
    const fetch = vi.fn(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return new Response(JSON.stringify({ series: [] }));
    });
    const client = new SmardClient({ fetch, maxConcurrentRequests: 3 });
    await Promise.all(Array.from({ length: 12 }, (_, i) => client.getBlock(1, "DE", "hour", i)));
    expect(fetch).toHaveBeenCalledTimes(12);
    expect(peak).toBe(3);
  });

  it("shares one fetch between parallel callers of the same document", async () => {
    const fetch = fakeFetch();
    const client = new SmardClient({ fetch });
    await Promise.all([client.getIndex(4169, "DE", "hour"), client.getIndex(4169, "DE", "hour")]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("caches the newest block briefly and older blocks longer", async () => {
    vi.useFakeTimers();
    try {
      const fetch = fakeFetch();
      const client = new SmardClient({ fetch, cacheTtlMs: 1_000, archiveCacheTtlMs: 100_000 });
      await client.getRange(4169, "DE", "hour", B0, B1 + HOUR); // index + 2 blocks
      expect(fetch).toHaveBeenCalledTimes(3);
      vi.advanceTimersByTime(2_000);
      await client.getRange(4169, "DE", "hour", B0, B1 + HOUR); // index + newest block again
      expect(fetch).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows a per-call block limit", async () => {
    const client = new SmardClient({ fetch: fakeFetch(), maxBlocksPerQuery: 1 });
    await expect(client.getRange(4169, "DE", "hour", B0, B1 + HOUR, { maxBlocks: 2 })).resolves.toHaveLength(4);
  });
});
