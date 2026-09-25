import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer, SERVER_INSTRUCTIONS, tools } from "../index";

async function initialized(): Promise<Client> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverTransport);
  const client = new Client({ name: "instructions-probe", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

describe("the initialize result carries instructions, the one field a search-first client shows the model before any tool is searched", () => {
  it("hands the client the server instructions on initialize", async () => {
    const client = await initialized();

    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
    expect(SERVER_INSTRUCTIONS.length).toBeGreaterThan(200);
  });

  it("names the moments and the tools that replace hand-rolled session plumbing", () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/search this server first/);
    for (const name of [
      "extension_dev",
      "extension_wait",
      "extension_logs",
      "extension_open",
      "extension_inspect",
      "extension_eval",
      "extension_build",
    ]) {
      expect(SERVER_INSTRUCTIONS).toContain(name);
    }
    expect(SERVER_INSTRUCTIONS).toMatch(/ps, curl/);
    expect(SERVER_INSTRUCTIONS).toMatch(/CDP or Playwright/);
  });

  it("only names tools the server really registers", () => {
    const registered = new Set(tools.map((t) => t.schema.name));
    const named = SERVER_INSTRUCTIONS.match(/\bextension_[a-z_]+/g) ?? [];
    expect(named.length).toBeGreaterThan(5);
    for (const name of named) {
      expect(registered.has(name), `${name} is not a registered tool`).toBe(true);
    }
  });

  it("serves the tool list from the same server object the stdio path connects", async () => {
    const client = await initialized();

    const listed = await client.listTools();

    expect(listed.tools.map((t) => t.name).sort()).toEqual(
      tools.map((t) => t.schema.name).sort(),
    );
  });
});
