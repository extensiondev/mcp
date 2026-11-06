// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { describe, expect, it } from "vitest";

import { tools } from "../index";
import { SESSION_PROJECT_PATH } from "../lib/common-schema";

const described = (name: string): string =>
  tools.find((tool) => tool.schema.name === name)?.schema.description ?? "";

const sessionTools = tools.filter((tool) => {
  const properties = (tool.schema.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};

  return properties.projectPath === SESSION_PROJECT_PATH;
});

describe("the session tools say a run the person started by hand is adopted, since they read the same ready contract", () => {
  it("the shared projectPath names the run by hand, the contract it writes and the flags its channels need", () => {
    expect(SESSION_PROJECT_PATH.description).toContain("`npx extension dev|start` by hand");
  });

  it("no session tool says the session must come from extension_dev", () => {
    expect(sessionTools.map((tool) => tool.schema.name)).toContain("extension_logs");

    for (const tool of sessionTools) {
      expect(JSON.stringify(tool.schema), tool.schema.name).not.toMatch(/requires an active extension_dev session/);
      expect(JSON.stringify(tool.schema), tool.schema.name).not.toMatch(/needs a running session: extension_dev or extension_start\)/);
    }
  });

  it("extension_logs, extension_open, extension_eval and extension_screenshot name the run by hand beside the flag their route needs", () => {
    expect(described("extension_logs")).toContain("a `npx extension dev` run by hand (follow needs --allow-control there)");
    expect(described("extension_open")).toContain("by hand: --allow-control");
    expect(described("extension_eval")).toContain("by hand: --allow-eval");
    expect(described("extension_screenshot")).toContain("in a live session");
  });
});
