/** Helpers shared by the tool implementations. */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { runWithContext } from "../context.js";
import { SmardError } from "../smard.js";
import { formatBerlin } from "../time.js";

export function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/** Successful result: readable text for the model plus the structured data. */
export function toolResult(text: string, structured: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent: structured };
}

/**
 * Runs a tool: expected failures (bad input, SMARD errors) become tool
 * errors, warnings raised during the call (e.g. data served from the cache
 * because SMARD was down) are added to the result, and so is the server
 * time, so that "now" never has to be guessed. A tool whose text is its JSON
 * puts server_time into that JSON itself.
 */
export async function guarded(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  const serverTime = formatBerlin(Date.now());
  let outcome: { value: CallToolResult; warnings: string[] };
  try {
    outcome = await runWithContext(run);
  } catch (err) {
    if (err instanceof SmardError || err instanceof InputError) return errorResult(err.message);
    throw err;
  }
  const { value, warnings } = outcome;
  if (value.isError) return value;
  const hasTime = value.structuredContent !== undefined && "server_time" in value.structuredContent;
  const lines = [...warnings.map((w) => `Warning: ${w}`), ...(hasTime ? [] : [`Server time: ${serverTime}`])];
  if (lines.length === 0) return value;
  const text = lines.join("\n");
  const content = value.content.map((c, i) => (i === 0 && c.type === "text" ? { ...c, text: `${c.text}\n${text}` } : c));
  return {
    ...value,
    content,
    ...(value.structuredContent
      ? { structuredContent: { ...value.structuredContent, ...(warnings.length > 0 ? { warnings } : {}), ...(hasTime ? {} : { server_time: serverTime }) } }
      : {}),
  };
}

/** Fields every structured result may carry; guarded() fills them in. */
export const commonFields = {
  warnings: z
    .array(z.string())
    .optional()
    .describe("Problems during this call, e.g. values served from the cache because SMARD did not answer"),
  server_time: z.string().optional().describe("Time of the call (Europe/Berlin)"),
};

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
