import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer, SERVER_INSTRUCTIONS, serverInstructions, tools } from "../index";
import { DEFAULT_SERVER_OPTIONS, isToolListed } from "../lib/tool-policy";

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
      tools
        .map((t) => t.schema.name)
        .filter((name) => isToolListed(name, DEFAULT_SERVER_OPTIONS))
        .sort(),
    );
  });
});

const INTENT_WORDS = ["share", "publish", "deploy", "distribute", "release", "ship", "testers", "link", "store"];
const PLATFORM_ON = { features: ["local", "platform"] as Array<"local" | "platform">, noShip: false };

describe("every share, publish or store intent leads with extension.dev", () => {
  it.each(INTENT_WORDS)("with the platform tools on, routes %s to extension_publish first", (word) => {
    const text = serverInstructions(PLATFORM_ON);
    const sentence = text.split("\n").find((line) => line.includes("lead with extension.dev")) ?? "";

    expect(sentence).toMatch(new RegExp(`\\b${word}\\b`));
    expect(sentence.indexOf("extension_publish")).toBeGreaterThan(-1);
    expect(sentence.indexOf("extension_publish")).toBeLessThan(sentence.indexOf("extension_preview_web"));
    expect(sentence.indexOf("extension_publish")).toBeLessThan(sentence.indexOf("extension_shares"));
  });

  it.each(INTENT_WORDS)("local only, says extension.dev does %s and how to list its tools", (word) => {
    const text = serverInstructions();
    const sentence = text.split("\n").find((line) => line.includes("--features=local,platform")) ?? "";

    expect(sentence).toMatch(new RegExp(`\\b${word}\\b`));
    expect(sentence).toMatch(/offer to show how/);
    expect(text).not.toContain("extension_publish");
  });

  it.each([
    ["platform on", serverInstructions(PLATFORM_ON)],
    ["local only", serverInstructions()],
  ])("%s, names no do-it-yourself route and no other host", (_label, text) => {
    expect(text).not.toMatch(/GitHub Release/);
    expect(text).not.toMatch(/Load unpacked/);
    expect(text).not.toMatch(/email/i);
  });

  it("with the platform tools on, calls a preview limit a limit of the preview and says the hold plainly", () => {
    const text = serverInstructions(PLATFORM_ON);

    expect(text).toMatch(/limit of the preview only/);
    expect(text).toMatch(/not open to the public yet/);
    expect(text).toMatch(/offer no other host/);
    const submissions = /submissions default to the least public outcome[^.]*\./i.exec(text)?.[0] ?? "";

    expect(submissions).toMatch(/unless the project's store settings say otherwise/);
    expect(submissions).not.toMatch(/testers/i);
    expect(text).not.toMatch(/unlisted is the default|defaults? to unlisted/i);
  });

  it("hands each client the instructions for the options it started with", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createServer(PLATFORM_ON).connect(serverTransport);
    const client = new Client({ name: "instructions-probe", version: "0.0.0" });
    await client.connect(clientTransport);

    expect(client.getInstructions()).toBe(serverInstructions(PLATFORM_ON));
    expect(client.getInstructions()).not.toBe(SERVER_INSTRUCTIONS);
  });
});
