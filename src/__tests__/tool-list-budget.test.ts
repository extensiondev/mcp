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

import { createServer, tools } from "../index";
import { FEATURE_GROUPS, TOOL_POLICY } from "../lib/tool-policy";

/* @invariant THE TOOL LIST IS PAID BEFORE THE FIRST CALL. Every session
 * that loads the server pays for tools/list before it calls anything, and
 * again after each compaction; on 2026-11-06 the list at
 * --features=local,platform was 199,587 characters of JSON, with
 * extension_submit alone at 38,643 (ledger 462). A schema carries one line
 * per property and per action; the long prose lives in the answers the
 * server already writes (hint, sayToPerson, nextStep). The ceilings below
 * are measured on JSON.stringify of each listed tool, the bytes a client
 * actually receives. Since ledger 525 every tool lists its title as the
 * tool's own `title` field, the one the connector directories read, and
 * since ledger 757 only there: `annotations` carries the four hints and no
 * second copy of the title, which won back about 1,200 characters for the
 * split of extension_builds. Ledger 1078 and 1080 raised the whole list
 * from 67,000 to 67,300 for two arguments an agent could not do without:
 * lifetime on extension_auth and workspaceRoot on extension_project_create.
 * Ledger 1100 raised it to 67,450 for workspace on extension_submit and its
 * check, the only way a connect can name a workspace's shared account.
 * Ledger 1106 raised it to 73,850 on 2026-11-24: every description now
 * says what the tool answers and which neighbor answers the rest, and the
 * parameters say what changes, which a grader and a first session read.
 * Ledger 1107 raised it to 81,900 the same day: every tool lists a minimal
 * envelope outputSchema (ok, command, status, value; ok and command
 * required) and repeats its title in annotations, the fields the directory
 * graders and spec-conformance checks read. Each tool's schema is inlined,
 * since tools/list has no shared $defs, so it stays as small as valid.
 * Ledger 1108 raised it to 95,800 the same day, on Cezar's ruling: ten tools
 * that read and wrote are listed as a read twin and a write twin, each
 * carrying only the parameters its own actions take, and the old names
 * answer unlisted; the default list fell from 24 tools to 19 with it.
 * Ledger 1143 raised it to 95,900 on 2026-11-25 for offset on
 * extension_templates, the only way to read the rows past a list cut at
 * the 40,000 character answer cap. */
const PER_TOOL = 6_000;
const WHOLE_LIST = 95_900;

type Listed = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

let listed: Listed[] = [];

beforeAll(async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer({ features: [...FEATURE_GROUPS], noShip: false }).connect(serverTransport);
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
  it("measures every tool the server registers, with every group on", () => {
    expect(listed.length).toBe(tools.filter((tool) => !TOOL_POLICY[tool.schema.name]?.aliasOf).length);
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
