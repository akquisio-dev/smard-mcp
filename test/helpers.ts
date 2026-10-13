import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { SmardClient } from "../src/smard.js";

export async function connect(fetch: typeof globalThis.fetch): Promise<Client> {
  const server = createServer(new SmardClient({ fetch }));
  const client = new Client({ name: "test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

export function textOf(result: unknown): string {
  const content = ((result as { content?: unknown }).content ?? []) as { type: string; text?: string }[];
  return content.map((c) => c.text ?? "").join("\n");
}
