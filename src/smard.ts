/**
 * Minimal client for the public SMARD chart_data API.
 *
 * SMARD stores each series as consecutive blocks. An index file lists the
 * start timestamp of every block; a block file holds [timestamp, value]
 * pairs (value is null where no data exists yet).
 */

import type { Region, Resolution } from "./catalog.js";

export const SMARD_BASE_URL = "https://www.smard.de/app/chart_data";

export interface DataPoint {
  timestamp: number;
  value: number;
}

export class SmardError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SmardError";
  }
}

export interface SmardClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** How long fetched documents stay cached. */
  cacheTtlMs?: number;
  /** Upper bound on cached documents. */
  cacheMaxEntries?: number;
  /** Upper bound on blocks fetched for one query. */
  maxBlocksPerQuery?: number;
}

interface CacheEntry {
  expires: number;
  value: unknown;
}

export class SmardClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly cacheMaxEntries: number;
  readonly maxBlocksPerQuery: number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: SmardClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? SMARD_BASE_URL;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.cacheTtlMs = options.cacheTtlMs ?? 15 * 60_000;
    this.cacheMaxEntries = options.cacheMaxEntries ?? 500;
    this.maxBlocksPerQuery = options.maxBlocksPerQuery ?? 8;
  }

  /** Start timestamps (ms since epoch) of all available blocks, ascending. */
  async getIndex(filter: number, region: Region, resolution: Resolution): Promise<number[]> {
    const doc = await this.getJson(`${filter}/${region}/index_${resolution}.json`);
    const timestamps = (doc as { timestamps?: unknown }).timestamps;
    if (!Array.isArray(timestamps)) throw new SmardError("Unexpected index format from SMARD");
    return timestamps.filter((t): t is number => typeof t === "number").sort((a, b) => a - b);
  }

  /** All non-null points of one block. */
  async getBlock(filter: number, region: Region, resolution: Resolution, start: number): Promise<DataPoint[]> {
    const doc = await this.getJson(`${filter}/${region}/${filter}_${region}_${resolution}_${start}.json`);
    const series = (doc as { series?: unknown }).series;
    if (!Array.isArray(series)) throw new SmardError("Unexpected data format from SMARD");
    const points: DataPoint[] = [];
    for (const pair of series) {
      if (Array.isArray(pair) && typeof pair[0] === "number" && typeof pair[1] === "number") {
        points.push({ timestamp: pair[0], value: pair[1] });
      }
    }
    return points;
  }

  /** Non-null points with from <= timestamp < to. */
  async getRange(filter: number, region: Region, resolution: Resolution, from: number, to: number): Promise<DataPoint[]> {
    const index = await this.getIndex(filter, region, resolution);
    const blocks = blocksForRange(index, from, to);
    if (blocks.length > this.maxBlocksPerQuery) {
      throw new SmardError(
        `Time range too large for resolution "${resolution}" (needs ${blocks.length} data blocks, limit ${this.maxBlocksPerQuery}). Use a shorter range or a coarser resolution.`,
      );
    }
    const parts = await Promise.all(blocks.map((start) => this.getBlock(filter, region, resolution, start)));
    return parts.flat().filter((p) => p.timestamp >= from && p.timestamp < to);
  }

  private async getJson(path: string): Promise<unknown> {
    const now = Date.now();
    const hit = this.cache.get(path);
    if (hit && hit.expires > now) return hit.value;

    const url = `${this.baseUrl}/${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new SmardError(`SMARD is not reachable: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.status === 404) {
      throw new SmardError("SMARD has no data for this combination of series, region and resolution.", 404);
    }
    if (!res.ok) throw new SmardError(`SMARD responded with HTTP ${res.status}`, res.status);

    let value: unknown;
    try {
      value = await res.json();
    } catch {
      throw new SmardError("SMARD returned invalid JSON");
    }

    this.cache.delete(path);
    this.cache.set(path, { expires: now + this.cacheTtlMs, value });
    while (this.cache.size > this.cacheMaxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return value;
  }
}

/** Block start timestamps whose block can contain points in [from, to). */
export function blocksForRange(index: readonly number[], from: number, to: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < index.length; i++) {
    const start = index[i]!;
    const next = index[i + 1] ?? Number.POSITIVE_INFINITY;
    if (start < to && next > from) result.push(start);
  }
  return result;
}
