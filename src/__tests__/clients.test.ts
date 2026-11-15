import { describe, expect, it } from "vitest";

import { CLIENTS, buildRecipe, type ClientId, type Reach } from "../clients";
import { resolveServerOptions } from "../lib/tool-policy";

const project = "acme/app";
const recipe = (client: ClientId, reach: Reach = "everything") =>
  buildRecipe({ client, reach, project });

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

  it("drops the pin for a local-only server, and still names the group", () => {
    const local = recipe("claude-code", "local");
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

  it("795: writes no approval gate variable in any recipe, since no tool reads one once the platform tools run on the hosted lane", () => {
    for (const client of CLIENTS) {
      for (const reach of ["everything", "no-ship", "local"] as const) {
        expect(JSON.stringify(recipe(client.id, reach)), `${client.id} ${reach}`).not.toMatch(/APPROVAL_GATE|\benv\b/);
      }
    }
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
});
