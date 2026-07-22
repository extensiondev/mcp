import { describe, it, expect, beforeEach, vi } from "vitest";
import type { RdpTab } from "../lib/rdp";

// Firefox parity for extension_dom_inspect listTargets: instead of the
// "Gecko does not expose CDP targets" refusal, the tool lists RDP tab
// descriptors from the root actor. Discovery therefore works even without
// allowControl, which the bridge listTabs path requires.

let rdpTabs: RdpTab[] = [];
let rdpError: Error | null = null;
let rdpPort: number | null = 9223;

vi.mock("../lib/rdp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/rdp")>();
  return {
    ...actual,
    rdpListTabs: async () => {
      if (rdpError) throw rdpError;
      return rdpTabs;
    },
  };
});

vi.mock("../lib/cdp-port", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/cdp-port")>();
  return {
    ...actual,
    resolveRdpPort: async () =>
      rdpPort == null ? null : { port: rdpPort, source: "contract" as const },
  };
});

vi.mock("../lib/session-browser", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/session-browser")>();
  return {
    ...actual,
    resolveSessionBrowser: (_p: string, browser?: string) => ({
      browser: browser ?? "chrome",
      source: "arg",
    }),
  };
});

const domInspect = await import("../tools/dom-inspect");

beforeEach(() => {
  rdpTabs = [];
  rdpError = null;
  rdpPort = 9223;
});

describe("extension_dom_inspect listTargets on Gecko (RDP root listTabs)", () => {
  it("maps tab descriptors to actor targets with the two-id-space note", async () => {
    rdpTabs = [
      {
        actor: "server1.conn0.tabDescriptor4",
        url: "https://example.com/",
        title: "Example",
        selected: true,
        browserId: 1,
      },
      {
        actor: "server1.conn0.tabDescriptor7",
        url: "about:blank",
        title: "",
      },
    ];

    const result = JSON.parse(
      await domInspect.handler({
        projectPath: "/p",
        browser: "firefox",
        listTargets: true,
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.transport).toBe("rdp");
    expect(result.targets).toEqual([
      {
        actor: "server1.conn0.tabDescriptor4",
        type: "tab",
        url: "https://example.com/",
        title: "Example",
        selected: true,
      },
      {
        actor: "server1.conn0.tabDescriptor7",
        type: "tab",
        url: "about:blank",
        title: "",
      },
    ]);
    expect(result.note).toContain("NOT a chrome.tabs id");
  });

  it("explains the missing rdpPort instead of a generic refusal", async () => {
    rdpPort = null;

    const result = JSON.parse(
      await domInspect.handler({
        projectPath: "/p",
        browser: "firefox",
        listTargets: true,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.name).toBe("NoSession");
    expect(result.error.message).toContain("rdpPort");
  });

  it("surfaces an RDP failure with the bridge alternative in the hint", async () => {
    rdpError = new Error("ECONNREFUSED");

    const result = JSON.parse(
      await domInspect.handler({
        projectPath: "/p",
        browser: "firefox",
        listTargets: true,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error.name).toBe("RdpError");
    expect(result.hint).toContain("listTabs");
  });
});
