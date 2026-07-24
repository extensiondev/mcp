import { describe, it, expect, vi } from "vitest";

type RawTarget = {
  id: string;
  type: string;
  url: string;
  title: string;
  webSocketDebuggerUrl: string;
};
let targets: RawTarget[] = [];
let resolved: { port: number; source: "contract" | "default-probe" } | null = {
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

const GUEST = "abcdefghijklmnopabcdefghijklmnop";
const COMPANION = "kgdaecdpfkikjncaalnmmnjjfpofkcbl";

function target(url: string, type = "service_worker"): RawTarget {
  return { id: `t-${url}`, type, url, title: "", webSocketDebuggerUrl: "" };
}

describe("verifyGuestLoaded (BUGS_TO_FIX §83 oracle)", () => {
  it("reports loaded when a non-companion extension target is present", async () => {
    resolved = { port: 9333, source: "contract" };
    discoverThrows = null;
    targets = [
      target(`chrome-extension://${COMPANION}/devtools.html`, "page"),
      target(`chrome-extension://${GUEST}/service_worker.js`),
    ];
    const r = await verifyGuestLoaded("/proj", "chrome");
    expect(r.checked).toBe(true);
    expect(r.loaded).toBe(true);
    expect(r.guestIds).toEqual([GUEST]);
    expect(r.cdpPort).toBe(9333);
  });

  it("flags the false-green when only the engine companion is present", async () => {
    resolved = { port: 9333, source: "contract" };
    discoverThrows = null;
    targets = [target(`chrome-extension://${COMPANION}/devtools.html`, "page")];
    const r = await verifyGuestLoaded("/proj", "chrome");
    expect(r.checked).toBe(true);
    expect(r.loaded).toBe(false);
    expect(r.reason).toMatch(/§83|silently rejected/i);
  });

  it("does not count the live-preview carrier as the guest", async () => {
    resolved = { port: 9333, source: "contract" };
    discoverThrows = null;
    targets = [
      target(`chrome-extension://${COMPANION}/x.html`, "page"),
      target(`chrome-extension://${CARRIER_EXTENSION_ID}/background.js`),
    ];
    const r = await verifyGuestLoaded("/proj", "chrome");
    expect(r.loaded).toBe(false);
  });

  it("ignores non-extension targets (tabs, the dev server page)", async () => {
    resolved = { port: 9333, source: "contract" };
    discoverThrows = null;
    targets = [
      target("http://localhost:8080/", "page"),
      target("chrome://extensions/", "page"),
    ];
    const r = await verifyGuestLoaded("/proj", "chrome");
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
    const r = await verifyGuestLoaded("/proj", "chrome");
    expect(r.checked).toBe(false);
    expect(r.reason).toMatch(/ECONNREFUSED|could not query/i);
  });
});
