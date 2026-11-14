import http from "node:http";
import net from "node:net";

import { describe, expect, it } from "vitest";

import config from "../../vitest.config";
import { NETWORK_REFUSAL, drainRefusedCalls } from "./setup-network-guard";

type AliasEntry = { find: RegExp | string; replacement: string };

describe("every engine alias is an exact match, because a bare string alias is a prefix replacement that would swallow the bridge subpath", () => {
  it("matches the bare specifier and not its subpath export", () => {
    const aliases = (config as { resolve?: { alias?: AliasEntry[] } }).resolve?.alias ?? [];
    const develop = aliases.find((entry) => entry.find instanceof RegExp && entry.find.test("extension-develop"));

    expect(develop).toBeDefined();
    expect((develop!.find as RegExp).test("extension-develop/bridge")).toBe(false);
    expect(aliases.every((entry) => entry.find instanceof RegExp)).toBe(true);
  });
});

describe("no test reaches a real host, and one that tries fails by name", () => {
  it("is installed before every test file by the vitest config", () => {
    expect((config as { test?: { setupFiles?: string[] } }).test?.setupFiles).toContain("src/__tests__/setup-network-guard.ts");
  });

  it("refuses a fetch and a socket to a host or to a loopback port nobody here listens on, and remembers each", async () => {
    await expect(fetch("https://unstubbed.example.com/api")).rejects.toThrow(NETWORK_REFUSAL);
    await expect(fetch("http://127.0.0.1:9333/json")).rejects.toThrow(NETWORK_REFUSAL);
    expect(() => net.connect({ host: "unstubbed.example.com", port: 443 })).toThrow(NETWORK_REFUSAL);

    const seen = drainRefusedCalls();

    expect(seen).toHaveLength(3);
    expect(seen[0]).toContain("fetch https://unstubbed.example.com/api");
    expect(seen[1]).toContain("fetch http://127.0.0.1:9333/json");
    expect(seen[2]).toContain("socket unstubbed.example.com:443");
  });

  it("leaves a test's own loopback server alone", async () => {
    const server = http.createServer((_request, response) => response.end("own"));

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const answer = await fetch(`http://127.0.0.1:${(server.address() as net.AddressInfo).port}/`);

      expect(await answer.text()).toBe("own");
      expect(drainRefusedCalls()).toEqual([]);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
