import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

  it("fails the file for a refused call made while it loaded or in one of its hooks, whatever the file is called", () => {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const home = fs.mkdtempSync(path.join(root, "node_modules", ".guard-cells-"));
    const leak = (name: string) => `await fetch("https://unstubbed.invalid.example.com/${name}").catch(() => "fail-soft");`;
    const file = (name: string, body: string) => fs.writeFileSync(path.join(home, name), `import { afterAll, it } from "vitest";\n${body}\nit("clean", () => {});\n`);

    try {
      fs.writeFileSync(
        path.join(home, "vitest.config.mjs"),
        `export default { test: { include: ["*.test.ts"], setupFiles: [${JSON.stringify(path.join(root, "src/__tests__/setup-network-guard.ts"))}] } };\n`,
      );

      file("loaded.test.ts", leak("loaded"));
      file("hook.live.test.ts", `afterAll(async () => { ${leak("hook")} });`);
      file("quiet.test.ts", "");

      const run = spawnSync(process.execPath, [path.join(root, "node_modules/vitest/vitest.mjs"), "run", "--root", home, "--config", path.join(home, "vitest.config.mjs"), "--reporter=json"], {
        encoding: "utf8",
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(VITEST|VITE_|TEST$|NODE_ENV$)/.test(key))),
      });
      const report = JSON.parse(run.stdout.slice(run.stdout.indexOf("{"))) as { testResults: Array<{ name: string; status: string; message: string; assertionResults: Array<{ failureMessages: string[] }> }> };

      const of = (name: string) => {
        const result = report.testResults.find((entry) => path.basename(entry.name) === name);

        return { status: result?.status, said: `${result?.message ?? ""}${(result?.assertionResults ?? []).flatMap((entry) => entry.failureMessages).join("\n")}` };
      };

      expect(run.status, run.stderr).toBe(1);
      expect(of("loaded.test.ts").status).toBe("failed");
      expect(of("loaded.test.ts").said).toContain("Refused while the test file loaded:");
      expect(of("loaded.test.ts").said).toContain(`${NETWORK_REFUSAL}: fetch https://unstubbed.invalid.example.com/loaded`);
      expect(of("hook.live.test.ts").status).toBe("failed");
      expect(of("hook.live.test.ts").said).toContain("Refused in a hook of this file, outside any test:");
      expect(of("quiet.test.ts").status).toBe("passed");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);

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
