/**
 * Per-request context: lets deep code (the SMARD client) report warnings,
 * e.g. that cached data was served because SMARD was unreachable, which the
 * tool wrapper then adds to the result.
 */

import { AsyncLocalStorage } from "node:async_hooks";

interface RequestContext {
  warnings: Set<string>;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(fn: () => Promise<T>): Promise<{ value: T; warnings: string[] }> {
  const ctx: RequestContext = { warnings: new Set() };
  return storage.run(ctx, async () => ({ value: await fn(), warnings: [...ctx.warnings] }));
}

/** Records a warning for the current request; does nothing outside a request. */
export function warn(message: string): void {
  storage.getStore()?.warnings.add(message);
}
