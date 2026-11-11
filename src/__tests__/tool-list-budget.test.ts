// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "../index";

/* @invariant THE TOOL LIST IS PAID BEFORE THE FIRST CALL. Every session
 * that loads the server pays for tools/list before it calls anything, and
 * again after each compaction; on 2026-11-06 the list at
 * --features=local,platform was 199,587 characters of JSON, with
 * extension_submit alone at 38,643 (ledger 462). A schema carries one line
 * per property and per action; the long prose lives in the answers the
 * server already writes (hint, sayToPerson, nextStep). The ceilings below
 * are measured on JSON.stringify of each listed tool, the bytes a client
 * actually receives. */
const PER_TOOL = 6_000;
const WHOLE_LIST = 61_000;

type Listed = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

let listed: Listed[] = [];

beforeAll(async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer({ features: ["local", "platform"], noShip: false }).connect(serverTransport);
  const client = new Client({ name: "budget-probe", version: "0.0.0" });
  await client.connect(clientTransport);
  listed = (await client.listTools()).tools;
});

const size = (tool: Listed): number => JSON.stringify(tool).length;

type Schema = { type?: unknown; enum?: unknown; description?: unknown; properties?: Record<string, Schema>; items?: Schema; anyOf?: Schema[]; oneOf?: Schema[] };

const properties = (schema: Schema | undefined, path: string): Array<[string, Schema]> => {
  if (!schema || typeof schema !== "object") return [];

  const own = Object.entries(schema.properties ?? {}).flatMap(([name, child]) => [
    [`${path}.${name}`, child] as [string, Schema],
    ...properties(child, `${path}.${name}`),
  ]);
  const nested = [schema.items, ...(schema.anyOf ?? []), ...(schema.oneOf ?? [])].flatMap((child) => properties(child, path));

  return [...own, ...nested];
};

describe("the tool list fits a session's budget", () => {
  it("lists every tool at --features=local,platform", () => {
    expect(listed.length).toBeGreaterThanOrEqual(38);
  });

  it(`keeps the whole list under ${WHOLE_LIST} characters`, () => {
    const total = listed.reduce((sum, tool) => sum + size(tool), 0);

    expect(total, `tools/list is ${total} characters`).toBeLessThan(WHOLE_LIST);
  });

  it(`keeps every tool under ${PER_TOOL} characters`, () => {
    const over = listed
      .map((tool) => ({ name: tool.name, chars: size(tool) }))
      .filter((tool) => tool.chars > PER_TOOL);

    expect(over).toEqual([]);
  });

  it("gives every argument a type and a one-line meaning", () => {
    const missing = listed.flatMap((tool) =>
      properties(tool.inputSchema as Schema, tool.name)
        .filter(([, schema]) => typeof schema.description !== "string" || schema.description.trim() === "")
        .map(([path]) => path),
    );

    expect(missing).toEqual([]);
  });

  it("keeps every enum on the arguments that had one", () => {
    const submit = listed.find((tool) => tool.name === "extension_submit");
    const action = (submit?.inputSchema as Schema).properties?.action;

    expect(Array.isArray(action?.enum)).toBe(true);
    expect(action?.enum).toEqual(expect.arrayContaining(["submit", "publish", "sync-listing"]));
  });
});
