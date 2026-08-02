import { beforeEach, describe, expect, it, vi } from "vitest";

const cdp = vi.hoisted(() => ({
  targets: [] as Array<{ id: string; type: string; url: string; title: string }>,
}));

const profile = vi.hoisted(() => ({ reused: false }));

vi.mock("../lib/cdp", () => ({
  CDPClient: class {
    static async discoverTargets() {
      return cdp.targets;
    }
    static async discoverBrowserWsUrl() {
      return "ws://127.0.0.1:1/browser";
    }
    async connect() {}
    async attachToTarget(id: string) {
      return `session-${id}`;
    }
    async enableDomains() {}
    async navigate() {}
    async evaluate(_sessionId: string, expr: string) {
      return expr === "location.href" ? undefined : {};
    }
    async getDocumentHtml() {
      return "";
    }
    async collectConsole() {
      return [];
    }
    disconnect() {}
  },
}));

vi.mock("../lib/cdp-port", () => ({
  resolveCdpPort: async () => ({ port: 9222 }),
  CDP_PORT_MISSING_HINT: "",
}));

vi.mock("../lib/profile-carryover", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/profile-carryover")>()),
  sessionProfileReused: () => profile.reused,
}));

import { handler } from "../tools/inspect";

const GUEST = {
  id: "guest",
  type: "page",
  url: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html",
  title: "Popup",
};
const WEB = { id: "web", type: "page", url: "https://site.test/", title: "Site" };

async function inspectNoTarget() {
  return JSON.parse(
    await handler({ projectPath: "/tmp/does-not-matter", browser: "chrome", include: [] }),
  );
}

beforeEach(() => {
  cdp.targets = [WEB, GUEST];
  profile.reused = false;
});

describe("extension_inspect with no target, on a profile that survives runs", () => {
  it("says the tab may be restored from a previous session", async () => {
    profile.reused = true;

    const out = await inspectNoTarget();

    expect(out.value.target.id).toBe("guest");
    expect(out.warnings.join(" ")).toMatch(/previous session/i);
    expect(out.warnings.join(" ")).toMatch(/extension_open|pass url/i);
  });

  it("warns about a plain web page the same way, not only extension surfaces", async () => {
    profile.reused = true;
    cdp.targets = [WEB];

    const out = await inspectNoTarget();

    expect(out.value.target.id).toBe("web");
    expect(out.warnings.join(" ")).toMatch(/previous session/i);
    expect(out.warnings.join(" ")).toMatch(/site\.test/);
  });

  it("stays quiet on a throwaway profile, which cannot carry a tab over", async () => {
    const out = await inspectNoTarget();

    expect(out.value.target.id).toBe("guest");
    expect(out.warnings.join(" ")).not.toMatch(/previous session/i);
  });

  it("stays quiet when the caller named the target itself", async () => {
    profile.reused = true;

    const out = JSON.parse(
      await handler({
        projectPath: "/tmp/does-not-matter",
        browser: "chrome",
        include: [],
        url: "https://site.test/",
      }),
    );

    expect(out.warnings.join(" ")).not.toMatch(/previous session/i);
  }, 10000);

  it("reports the carry-over on the session value so an agent can branch", async () => {
    profile.reused = true;

    const out = await inspectNoTarget();

    expect(out.value.profileReused).toBe(true);
  });
});
