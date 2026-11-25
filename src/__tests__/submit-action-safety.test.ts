// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SUBMIT_WRITE_SAFETY, SUBMIT_CONNECT_ACTIONS, SUBMIT_READ_ACTIONS, SUBMIT_SETTING_ACTIONS, SUBMIT_SHIP_ACTIONS } from "../lib/submit-action-safety";
import { TOOL_POLICY } from "../lib/tool-policy";
import { schema, SUBMIT_ACTIONS } from "../tools/submit";

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("submit action safety tests never reach the network");
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("extension_submit says per action which calls only read (ledger 360)", () => {
  const ships = TOOL_POLICY.extension_submit.ships as (args: Record<string, unknown>) => boolean;

  it("names every action once, as a read, a store act, a setting, the connect or the submit itself", () => {
    const named = [...SUBMIT_READ_ACTIONS, ...SUBMIT_SHIP_ACTIONS, ...SUBMIT_SETTING_ACTIONS, ...SUBMIT_CONNECT_ACTIONS, "submit"].sort();

    expect(named).toEqual([...SUBMIT_ACTIONS].sort());
  });

  it("ships exactly the store acts and the submit that is not a dry run", () => {
    for (const action of SUBMIT_READ_ACTIONS) expect(ships({ action }), action).toBe(false);
    for (const action of SUBMIT_SETTING_ACTIONS) expect(ships({ action }), action).toBe(false);
    for (const action of SUBMIT_SHIP_ACTIONS) expect(ships({ action }), action).toBe(true);
    expect(ships({ action: "submit" })).toBe(false);
    expect(ships({ action: "submit", dryRun: true })).toBe(false);
    expect(ships({ dryRun: false })).toBe(true);
  });

  it("1139: the action input lists only acts, says the approval request executes nothing and names the tools that own the reads", () => {
    const described = schema.inputSchema.properties.action.description;

    expect(described.startsWith(SUBMIT_WRITE_SAFETY)).toBe(true);
    expect(schema.inputSchema.properties.action.enum).not.toContain("preflight");
    expect(schema.inputSchema.properties.action.enum).not.toContain("status");
    expect(described).not.toMatch(/\b(preflight|status):/);
    expect(described).toContain("extension_submit_read answers 'preflight', 'status'");
    expect(schema.inputSchema.properties.dryRun).not.toHaveProperty("default");
    expect(schema.inputSchema.properties.dryRun.description).toMatch(/^Omitted: submit dry runs, other actions run\. true sends nothing/);
    expect(described).toContain("submit with dryRun:false and no approvalId executes nothing");
    expect(TOOL_POLICY.extension_submit.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
  });
});
