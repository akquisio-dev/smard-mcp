/** Helpers shared by the tool implementations. */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { SmardError } from "../smard.js";

export function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/** Successful result: readable text for the model plus the structured data. */
export function toolResult(text: string, structured: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent: structured };
}

/** Turns expected failures (bad input, SMARD errors) into tool errors. */
export async function guarded(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof SmardError || err instanceof InputError) return errorResult(err.message);
    throw err;
  }
}

/** Invalid tool arguments that the schema cannot catch (e.g. ranges). */
export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Fixed one-decimal formatting for text summaries, e.g. 1234.5. */
export function fmt1(n: number): string {
  return round1(n).toFixed(1);
}

export const READ_ONLY_REMOTE = { readOnlyHint: true, openWorldHint: true } as const;
