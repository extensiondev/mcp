import { describe, expect, it } from "vitest";

import { CLIENTS, buildRecipe, type ClientId, type Reach } from "../clients";
import { resolveServerOptions } from "../lib/tool-policy";

const project = "acme/app";
const recipe = (client: ClientId, reach: Reach = "everything", strictApproval = false) =>
  buildRecipe({ client, reach, strictApproval, project });

describe("buildRecipe", () => {
  it("covers every listed client", () => {
    expect(CLIENTS.map((c) => c.id)).toEqual(["claude-code", "cursor", "vscode", "codex", "json"]);

    for (const client of CLIENTS) {
      expect(recipe(client.id).login).toBe("npx @extension.dev/mcp login --project acme/app");
    }
  });

  it("pins the project and adds --no-ship for the no-ship reach", () => {
    expect(recipe("claude-code", "no-ship").command).toBe(
      "claude mcp add extension-dev -- npx @extension.dev/mcp --features=local,platform --project acme/app --no-ship",
    );
  });

  it("drops the pin and strict approval for a local-only server, and still names the group", () => {
    const local = recipe("claude-code", "local", true);
    expect(local.command).toBe("claude mcp add extension-dev -- npx @extension.dev/mcp --features=local");
    expect(resolveServerOptions([], {})).toEqual(resolveServerOptions(["--features=local"], {}));
  });

  it("names both groups whenever the agent may reach the platform", () => {
    for (const reach of ["everything", "no-ship"] as const) {
      const args = JSON.parse(recipe("json", reach).config!.text).mcpServers["extension-dev"].args;
      expect(args, reach).toContain("--features=local,platform");
      const resolved = resolveServerOptions(args.slice(1), {});
      expect(resolved.ok && resolved.options.features, reach).toEqual(["local", "platform"]);
    }
  });

  it("passes strict approval as env in each client's own syntax", () => {
    expect(recipe("claude-code", "everything", true).command).toBe(
      "claude mcp add extension-dev -e EXTENSION_DEV_APPROVAL_GATE=1 -- npx @extension.dev/mcp --features=local,platform --project acme/app",
    );

    expect(recipe("codex", "everything", true).command).toBe(
      "codex mcp add extension-dev --env EXTENSION_DEV_APPROVAL_GATE=1 -- npx @extension.dev/mcp --features=local,platform --project acme/app",
    );

    expect(recipe("codex", "everything", true).config?.text).toContain(
      '[mcp_servers.extension-dev.env]\nEXTENSION_DEV_APPROVAL_GATE = "1"',
    );

    expect(JSON.parse(recipe("json", "everything", true).config!.text)).toEqual({
      mcpServers: {
        "extension-dev": {
          command: "npx",
          args: ["@extension.dev/mcp", "--features=local,platform", "--project", "acme/app"],
          env: { EXTENSION_DEV_APPROVAL_GATE: "1" },
        },
      },
    });
  });

  it("ignores strict approval when the agent cannot ship", () => {
    expect(recipe("json", "no-ship", true).config!.text).not.toContain("APPROVAL_GATE");
  });

  it("builds install links that decode to the same server", () => {
    const cursor = new URL(recipe("cursor").deeplink!);
    expect(JSON.parse(atob(cursor.searchParams.get("config")!))).toEqual({
      command: "npx",
      args: ["@extension.dev/mcp", "--features=local,platform", "--project", "acme/app"],
    });

    const vscode = recipe("vscode").deeplink!;
    expect(vscode.startsWith("vscode:mcp/install?")).toBe(true);
    expect(JSON.parse(decodeURIComponent(vscode.slice("vscode:mcp/install?".length)))).toEqual({
      name: "extension-dev",
      command: "npx",
      args: ["@extension.dev/mcp", "--features=local,platform", "--project", "acme/app"],
    });

    expect(recipe("claude-code").deeplink).toBeUndefined();
    expect(recipe("codex").deeplink).toBeUndefined();
  });

  it("only ever emits flags the server accepts", () => {
    for (const reach of ["everything", "no-ship", "local"] as const) {
      const args = JSON.parse(recipe("json", reach).config!.text).mcpServers["extension-dev"].args;
      expect(resolveServerOptions(args.slice(1), {}).ok, reach).toBe(true);
    }
  });

  it("never emits an approval-off setting", () => {
    for (const client of CLIENTS) {
      for (const reach of ["everything", "no-ship", "local"] as const) {
        for (const strict of [true, false]) {
          expect(JSON.stringify(buildRecipe({ client: client.id, reach, strictApproval: strict, project }))).not.toMatch(
            /APPROVAL_GATE["=: ]+"?0/,
          );
        }
      }
    }
  });
});
