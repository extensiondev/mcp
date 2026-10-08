import { describe, it, expect, vi } from "vitest";

type RawTarget = {
  id: string;
  type: string;
  url: string;
  title: string;
  webSocketDebuggerUrl: string;
};
let targets: RawTarget[] = [];
let resolved: { port: number; source: "contract" } | null = {
  port: 9333,
  source: "contract",
};
let discoverThrows: Error | null = null;

vi.mock("../lib/cdp", () => ({
  CDPClient: {
    discoverTargets: async () => {
      if (discoverThrows) throw discoverThrows;

      return targets;
    },
  },
}));

vi.mock("../lib/cdp-port", () => ({
  resolveCdpPort: async () => resolved,
}));

const { verifyGuestLoaded } = await import("../lib/guest-load-oracle");
const { CARRIER_EXTENSION_ID } = await import("../lib/carrier");
const { readyContractPath } = await import("../lib/session-paths");
const { readyContract } = await import("./fixtures/engine-answers");
const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");

const GUEST = "abcdefghijklmnopabcdefghijklmnop";
const COMPANION = "kgdaecdpfkikjncaalnmmnjjfpofkcbl";
const STRANGER = "ponmlkjihgfedcbaponmlkjihgfedcba";
const EDGE_COMPANION = "aabbccddeeffgghhaabbccddeeffgghh";

let project = "/proj";

function session(contract: Record<string, unknown> = { extensionId: GUEST }): void {
  project = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-oracle-"));
  const file = readyContractPath(project, "chrome");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(readyContract("dev", "chrome", { cdpPort: 9333, ...contract })));
}

function target(url: string, type = "service_worker"): RawTarget {
  return { id: `t-${url}`, type, url, title: "", webSocketDebuggerUrl: "" };
}

describe("verifyGuestLoaded oracle", () => {
  it("reports loaded when a non-companion extension target is present", async () => {
    session();
    resolved = { port: 9333, source: "contract" };
    discoverThrows = null;
    targets = [
      target(`chrome-extension://${COMPANION}/devtools.html`, "page"),
      target(`chrome-extension://${GUEST}/service_worker.js`),
    ];

    const r = await verifyGuestLoaded(project, "chrome");
    expect(r.checked).toBe(true);
    expect(r.loaded).toBe(true);
    expect(r.guestIds).toEqual([GUEST]);
    expect(r.cdpPort).toBe(9333);
  });

  it("flags the false-green when only the engine companion is present", async () => {
    session();
    resolved = { port: 9333, source: "contract" };
    discoverThrows = null;
    targets = [target(`chrome-extension://${COMPANION}/devtools.html`, "page")];
    const r = await verifyGuestLoaded(project, "chrome");
    expect(r.checked).toBe(true);
    expect(r.loaded).toBe(false);
    expect(r.reason).toMatch(/silently rejected/i);
  });

  it("does not count the live-preview carrier as the guest", async () => {
    session();
    resolved = { port: 9333, source: "contract" };
    discoverThrows = null;
    targets = [
      target(`chrome-extension://${COMPANION}/x.html`, "page"),
      target(`chrome-extension://${CARRIER_EXTENSION_ID}/background.js`),
    ];

    const r = await verifyGuestLoaded(project, "chrome");
    expect(r.loaded).toBe(false);
  });

  it("ignores non-extension targets (tabs, the dev server page)", async () => {
    session();
    resolved = { port: 9333, source: "contract" };
    discoverThrows = null;
    targets = [
      target("http://localhost:8080/", "page"),
      target("chrome://extensions/", "page"),
    ];

    const r = await verifyGuestLoaded(project, "chrome");
    expect(r.checked).toBe(true);
    expect(r.loaded).toBe(false);
  });

  it("is unchecked (not a false negative) when there is no CDP port", async () => {
    resolved = null;
    const r = await verifyGuestLoaded("/proj", "gecko");
    expect(r.checked).toBe(false);
    expect(r.loaded).toBe(false);
    expect(r.reason).toMatch(/no CDP port/i);
  });

  it("is unchecked when the target list cannot be fetched", async () => {
    resolved = { port: 9333, source: "contract" };
    discoverThrows = new Error("connect ECONNREFUSED 127.0.0.1:9333");
    const r = await verifyGuestLoaded(project, "chrome");
    expect(r.checked).toBe(false);
    expect(r.reason).toMatch(/ECONNREFUSED|could not query/i);
  });
});

describe("verifyGuestLoaded matches the contract's own extension id", () => {
  it("does not take a stranger's worker for the guest", async () => {
    session();
    resolved = { port: 9333, source: "contract" };
    discoverThrows = null;
    targets = [
      target(`chrome-extension://${COMPANION}/devtools.html`, "page"),
      target(`chrome-extension://${STRANGER}/sw.js`),
    ];

    const r = await verifyGuestLoaded(project, "chrome");
    expect(r.checked).toBe(true);
    expect(r.loaded).toBe(false);
    expect(r.otherExtensionIds).toEqual([STRANGER]);
    expect(r.reason).toContain(STRANGER);
    expect(r.reason).toContain(GUEST);
  });

  it("does not count a companion the contract lists under managedExtensions", async () => {
    session({
      extensionId: GUEST,
      managedExtensions: [{ path: "/engine/devtools/edge", id: EDGE_COMPANION }],
    });

    resolved = { port: 9333, source: "contract" };
    discoverThrows = null;
    targets = [target(`chrome-extension://${EDGE_COMPANION}/sw.js`)];
    const r = await verifyGuestLoaded(project, "chrome");
    expect(r.loaded).toBe(false);
    expect(r.otherExtensionIds).toEqual([]);
  });

  it("falls back to the id derived from distPath when the contract stamps none", async () => {
    const { unpackedExtensionId } = await import("../lib/extension-identity");
    session({ distPath: "/tmp/some/dist/chrome", extensionId: undefined });
    const derived = unpackedExtensionId("/tmp/some/dist/chrome");
    resolved = { port: 9333, source: "contract" };
    discoverThrows = null;
    targets = [target(`chrome-extension://${derived}/sw.js`)];
    const r = await verifyGuestLoaded(project, "chrome");
    expect(r.loaded).toBe(true);
    expect(r.guestIds).toEqual([derived]);
  });

  it("is inconclusive, not loaded, when the contract names no id at all", async () => {
    session({ extensionId: undefined, distPath: undefined });
    resolved = { port: 9333, source: "contract" };
    discoverThrows = null;
    targets = [target(`chrome-extension://${GUEST}/sw.js`)];
    const r = await verifyGuestLoaded(project, "chrome");
    expect(r.checked).toBe(false);
    expect(r.loaded).toBe(false);
  });
});
