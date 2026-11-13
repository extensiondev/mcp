// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "../index";
import { CHROME_PUBLISHER_SLOTS_CHECK, CHROME_SLOTS_SENTENCE } from "../lib/chrome-publisher-slots";
import { PLATFORM_UNAVAILABLE_SENTENCE, PLATFORM_UNAVAILABLE_STATUS } from "../lib/store-run-unavailable";
import { SHARED_INPUT_NOTE, handler as checkHandler, schema as checkSchema } from "../tools/submit-check";
import { schema as submitSchema } from "../tools/submit";
import { usePlatformWorld, WORLD_API } from "./fixtures/platform-world";

const world = usePlatformWorld("extdev-submit-check-");
const api = { api: WORLD_API };
const STORE_SEND = "POST /api/cli/stores/submit";
const sent = () => world.calls.map((call) => `${call.method} ${call.path}`);
const platformReads = () => sent().filter((call) => call !== "GET /api/cli/whoami");

async function listed(): Promise<Map<string, Record<string, unknown>>> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer({ features: ["local", "platform"], noShip: false }).connect(serverTransport);
  const client = new Client({ name: "check-probe", version: "0.0.0" });
  await client.connect(clientTransport);

  return new Map((await client.listTools()).tools.map((tool) => [tool.name, tool.annotations as Record<string, unknown>]));
}

describe("extension_submit_check takes the calls that only read or ask, under a read-only hint (ledger 365)", () => {
  it("lists a read-only, non-destructive hint a client's permission layer reads, and extension_submit keeps its destructive one", async () => {
    const annotations = await listed();

    expect(annotations.get("extension_submit_check")).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: true });
    expect(annotations.get("extension_submit")).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it("describes only what differs from extension_submit: the shared inputs keep their shape and carry no prose of their own (ledger 502)", () => {
    const own = Object.keys(submitSchema.inputSchema.properties).filter((key) => key !== "approvalId").sort();
    const listedHere = Object.keys(checkSchema.inputSchema.properties).sort();
    const described = Object.entries(checkSchema.inputSchema.properties as Record<string, { description?: string }>)
      .filter(([, property]) => property.description !== SHARED_INPUT_NOTE)
      .map(([key]) => key)
      .sort();

    expect(listedHere).toEqual(own);
    expect(described).toEqual(["action", "dryRun"]);
    expect((checkSchema.inputSchema.properties as Record<string, { enum?: string[] }>).store.enum).toEqual(["chrome", "firefox", "edge", "safari"]);
    expect(JSON.stringify(checkSchema).length).toBeLessThan(2_500);
    expect(JSON.stringify(submitSchema).length).toBeLessThan(5_700);
  });

  it("answers a preflight from extension_submit's own handler, reading the same routes", async () => {
    world.login();
    const checked = await world.call("extension_submit_check", { action: "preflight", browsers: ["chrome"], ...api });
    const checkedCalls = platformReads();
    world.calls.length = 0;
    const direct = await world.call("extension_submit", { action: "preflight", browsers: ["chrome"], ...api });

    expect(checked.command).toBe("extension_submit_check");
    expect(checked.status).toBe(direct.status);
    expect(checkedCalls.length).toBeGreaterThan(0);
    expect(checkedCalls).toEqual(platformReads());
  });

  it("asks for the owner's approval on dryRun:false and sends nothing to a store", async () => {
    world.login();
    const out = await world.call("extension_submit_check", { browsers: ["chrome"], buildSha: "603fc8a", dryRun: false, ...api });

    expect(out.status).toBe("approval-required");
    expect(out.value.approvalUrl).toContain("/device/approve/apr_world");
    expect(sent()).toContain("POST /api/cli/approvals");
    expect(world.calls.filter((call) => `${call.method} ${call.path}` === STORE_SEND).map((call) => call.body.dryRun)).toEqual([true]);
  });

  it("names the publisher's two default extension slots on a first Chrome item as an advisory, and on the real submit's unlinked-item stop (ledger 510)", async () => {
    world.login();
    world.routes.push([
      /^POST \/api\/projects\/[^/]+\/stores\/chrome\/submissions\/preflight$/,
      () => ({ body: { store: "chrome", summary: { pass: 0, warn: 0, fail: 0, blockingFailures: 0, canSubmit: false }, checks: [], connection: { kind: "oauth", connectedAs: "owner@example.com", healthy: true, itemLinked: false } } }),
    ]);

    const read = await world.call("extension_submit_check", { action: "preflight", browsers: ["chrome"], ...api });
    const row = (read.value.stores.chrome.warnings as Array<Record<string, unknown>>).find((check) => check.id === CHROME_PUBLISHER_SLOTS_CHECK)!;

    expect(row).toMatchObject({ owner: "you", severity: "advisory" });
    expect(String(row.message)).toContain("2 extension slots by default");
    expect(read.value.stores.chrome.canSubmit).toBe(false);

    const asked = await world.call("extension_submit_check", { browsers: ["chrome"], buildSha: "603fc8a", dryRun: false, ...api });

    expect(asked.status).toBe("store-item-not-linked");
    expect(asked.warnings).toContain(CHROME_SLOTS_SENTENCE);
    expect(sent()).not.toContain("POST /api/cli/approvals");
  });

  it("refuses a store act, the call spending an approval and a server with its gate off, before anything leaves the machine", async () => {
    world.login();
    const refusedCalls = [
      { action: "publish", browsers: ["chrome"], approvalId: "apr_world", ...api },
      { action: "sync-listing", browsers: ["safari"], projectPath: "/tmp/x", approvalId: "apr_world", ...api },
      { action: "configure-store", store: "chrome", storeSettings: { enabled: true }, ...api },
      { browsers: ["chrome"], buildSha: "603fc8a", dryRun: false, approvalId: "apr_world", ...api },
    ];

    for (const args of refusedCalls) {
      const out = await world.call("extension_submit_check", args);

      expect(out.status, JSON.stringify(args)).toBe("check-refused");
      expect(out.value.useTool).toBe("extension_submit");
    }

    process.env.EXTENSION_DEV_APPROVAL_GATE = "0";
    const ungated = await world.call("extension_submit_check", { browsers: ["chrome"], buildSha: "603fc8a", dryRun: false, ...api });

    expect(ungated.status).toBe("check-refused");
    expect(ungated.error.message).toContain("EXTENSION_DEV_APPROVAL_GATE");
    expect(sent()).toEqual([]);
  });

  it("refuses the same calls when its handler is reached directly", async () => {
    const out = JSON.parse(await checkHandler({ action: "cancel", approvalId: "apr_world", ...api }));

    expect(out.status).toBe("check-refused");
    expect(sent()).toEqual([]);
  });
});
