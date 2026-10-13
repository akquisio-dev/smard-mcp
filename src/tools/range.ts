/** Parsing of from/to arguments for the analysis tools. */

import { MAX_RANGE_MS } from "../analysis.js";
import { berlinDayFloor, parseTime } from "../time.js";
import { InputError } from "./common.js";

const DAY = 24 * 3_600_000;

/**
 * Without arguments: yesterday (Berlin). With only `from`: until the end of
 * that day if it is a plain date, else 24 hours.
 */
export function parseRange(from: string | undefined, to: string | undefined, now = Date.now()): { from: number; to: number } {
  let fromMs: number;
  let toMs: number;
  try {
    if (!from && !to) {
      toMs = berlinDayFloor(now);
      fromMs = berlinDayFloor(toMs - 12 * 3_600_000);
    } else if (!from) {
      throw new InputError('"from" is required when "to" is given.');
    } else {
      fromMs = parseTime(from);
      toMs = to ? parseTime(to, true) : /^\d{4}-\d{2}-\d{2}$/.test(from) ? parseTime(from, true) : fromMs + DAY;
    }
  } catch (err) {
    if (err instanceof InputError) throw err;
    throw new InputError((err as Error).message);
  }
  if (toMs <= fromMs) throw new InputError('"to" must be after "from".');
  if (toMs - fromMs > MAX_RANGE_MS) throw new InputError("The range may span at most 10 years.");
  return { from: fromMs, to: toMs };
}
