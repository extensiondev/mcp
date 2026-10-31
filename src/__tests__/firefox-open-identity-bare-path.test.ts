// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, afterEach, vi } from "vitest";

import { controlledIdentity, resolveLoadedId, sessionIdentityWarnings } from "../lib/controlled-identity";
import { envelope } from "../lib/envelope";
import { readyContractPath } from "../lib/session-paths";
import { actFrame, actVerbAnswer, evalRefusal, tabRows } from "./fixtures/engine-answers";

import type { RdpTab } from "../lib/rdp";
import type * as ActModule from "../lib/act";
import type * as CdpPortModule from "../lib/cdp-port";
import type * as RdpModule from "../lib/rdp";

const calls: string[][] = [];
let respond: (cli: string[]) => string = () => envelope({ ok: true, command: "x", status: "ok", value: 1 });

vi.mock("../lib/act", async (importOriginal) => {
  const actual = await importOriginal<typeof ActModule>();

  return {
    ...actual,
    runActVerb: async (cli: string[]) => {
      calls.push(cli);

      return respond(cli);
    },
  };
});

vi.mock("../lib/cdp-port", async (importOriginal) => {
  const actual = await importOriginal<typeof CdpPortModule>();

  return {
    ...actual,
    resolveCdpPort: async () => null,
    resolveRdpPort: async () => ({ port: 9222, source: "contract" as const }),
  };
});

const WEB_TAB: RdpTab = { actor: "tab3", url: "https://www.youtube.com/watch?v=1", title: "YouTube", selected: true };

vi.mock("../lib/rdp", async (importOriginal) => {
  const actual = await importOriginal<typeof RdpModule>();

  return {
    ...actual,
    rdpListTabs: async () => [WEB_TAB],
    rdpEvaluateInTab: async (_port: number, options: { select: (tabs: RdpTab[]) => RdpTab | null | undefined }) => {
      const picked = options.select([WEB_TAB]);

      return picked
        ? { ok: true, value: "web", tab: { url: String(picked.url), title: "YouTube" } }
        : { ok: false, name: "TargetNotFound", message: "no open tab matches" };
    },
  };
});

const evalTool = await import("../tools/eval");
const openTool = await import("../tools/open");

const BASE = "moz-extension://4a93ac70-455d-4566-af3c-7a794be7f33e/";
const dirs: string[] = [];

function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-ff-open-identity-"));
  dirs.push(dir);
  const dist = path.join(dir, "dist", "firefox");
  fs.mkdirSync(path.join(dist, "sidebar"), { recursive: true });
  fs.writeFileSync(
    path.join(dist, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "Lens",
      sidebar_action: { default_panel: "sidebar/index.html" },
      background: { scripts: ["background.js"] },
      browser_specific_settings: { gecko: { id: "lens@example.com" } },
    }),
  );

  fs.writeFileSync(path.join(dist, "sidebar", "index.html"), "<!doctype html>");
  const contract = readyContractPath(dir, "firefox");
  fs.mkdirSync(path.dirname(contract), { recursive: true });
  fs.writeFileSync(contract, JSON.stringify({ schema: 1, status: "ready", command: "dev", browser: "firefox", rdpPort: 9222, pid: process.pid }));

  return dir;
}

const contextOf = (cli: string[]) => (cli.includes("--context") ? cli[cli.indexOf("--context") + 1] : "");

afterEach(() => {
  calls.length = 0;
  respond = () => envelope({ ok: true, command: "x", status: "ok", value: 1 });
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("the Firefox start warning names Firefox addresses, not Chromium ids (ledger 332)", () => {
  it("names the gecko id and moz-extension, never chrome-extension or chrome://extensions", () => {
    const dir = project();
    const identity = controlledIdentity({ projectPath: dir, browser: "firefox", outputPath: null, allowControl: true });
    const lines = sessionIdentityWarnings(identity, resolveLoadedId(identity, null), dir, "firefox").filter(Boolean).join(" ");

    expect(lines).toContain("lens@example.com");
    expect(lines).toContain("moz-extension://");
    expect(lines).toContain("temporary add-on");
    expect(lines).not.toContain("chrome-extension://");
    expect(lines).not.toContain("chrome://extensions");
    expect(lines).not.toContain(identity.copyId!);
  });

  it("keeps the Chromium id warning on Chrome", () => {
    const dir = project();
    const identity = controlledIdentity({ projectPath: dir, browser: "chrome", outputPath: null, allowControl: true });
    const lines = sessionIdentityWarnings(identity, resolveLoadedId(identity, null), dir, "chrome").filter(Boolean).join(" ");

    expect(lines).toContain("chrome-extension://");
  });
});

describe("extension_open {url} on Firefox opens a background tab unless foreground (ledger 333)", () => {
  const navigateReply = (active: boolean) => (cli: string[]) =>
    cli[0] === "navigate"
      ? JSON.stringify({ ok: true, command: "navigate", status: "ok", value: { tabId: 7, url: "https://a.test/", created: true } })
      : JSON.stringify(actFrame("inspect", tabRows([{ id: 7, url: "https://a.test/", title: "A", active }])));

  it("asks the engine for an inactive new tab by default", async () => {
    respond = navigateReply(false);

    const result = JSON.parse(await openTool.handler({ projectPath: project(), browser: "firefox", url: "https://a.test/", timeout: 600 }));
    const navigate = calls.find((cli) => cli[0] === "navigate")!;

    expect(result.ok).toBe(true);
    expect(navigate).toContain("--new-tab");
    expect(navigate).toContain("--background");
  });

  it("opens an active tab with foreground: true and says the window was not raised", async () => {
    respond = navigateReply(true);

    const result = JSON.parse(
      await openTool.handler({ projectPath: project(), browser: "firefox", url: "https://a.test/", foreground: true, timeout: 600 }),
    );
    const navigate = calls.find((cli) => cli[0] === "navigate")!;

    expect(navigate).not.toContain("--background");
    expect(result.value.foreground).toMatchObject({ activated: true, windowRaised: false });
  });
});

describe("extension_eval page accepts the bare extension path extension_open accepted (ledger 334)", () => {
  it("resolves sidebar/index.html against the moz-extension origin when no tab matched it", async () => {
    const dir = project();

    respond = (cli) => {
      const context = contextOf(cli);

      if (context === "page") {
        return actVerbAnswer(
          evalRefusal({ code: "E_TARGET_NOT_FOUND", name: "TargetNotFound", message: "no open tab matches url: sidebar/index.html", engine: "firefox" }),
          "extension_eval",
        );
      }

      if (context === "background") return envelope({ ok: true, command: "extension_eval", status: "ok", value: BASE });
      if (context === "sidebar") return envelope({ ok: true, command: "extension_eval", status: "ok", value: "Sidebar" });

      return envelope({ ok: true, command: "x", status: "ok", value: null });
    };

    const result = JSON.parse(
      await evalTool.handler({ projectPath: dir, browser: "firefox", context: "page", url: "sidebar/index.html", expression: "document.title" }),
    );

    expect(result.ok).toBe(true);
    expect(result.value).toBe("Sidebar");
    expect(calls.some((cli) => contextOf(cli) === "sidebar")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("no open tab matches");
  });

  it("leaves a bare web address alone", async () => {
    const dir = project();
    respond = () =>
      actVerbAnswer(
        evalRefusal({ code: "E_TARGET_NOT_FOUND", name: "TargetNotFound", message: "no open tab matches url: example.org/x", engine: "firefox" }),
        "extension_eval",
      );

    const result = JSON.parse(
      await evalTool.handler({ projectPath: dir, browser: "firefox", context: "page", url: "example.org/x", expression: "1" }),
    );

    expect(result.ok).toBe(false);
    expect(calls.some((cli) => contextOf(cli) === "background")).toBe(false);
  });
});
