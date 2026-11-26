// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DASHBOARD_HOME } from "../lib/chrome-dashboard-agent";
import { chromePlan, type ChromePlan } from "../lib/chrome-listing-plan";
import { chromeStep, newRun, openRows, saveNewItem, SIGN_IN_LINE, type ChromePage, type Where } from "../lib/chrome-listing-run";
import { guidedConnectRuntime, type GuidedConnectRuntime, type LaunchPlan } from "../lib/guided-connect";
import { guideChromeListing, watchChromeListing, type ChromeListingDeps } from "../lib/guided-chrome-listing";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(60, 1)]);

function png(width: number, height: number): Buffer {
  const head = Buffer.alloc(16);

  head.writeUInt32BE(13, 0);
  head.write("IHDR", 4);
  head.writeUInt32BE(width, 8);
  head.writeUInt32BE(height, 12);

  return Buffer.concat([PNG, head, Buffer.alloc(32)]);
}

const ownerOnlyMode = (posix: number) => (process.platform === "win32" ? 0o666 : posix);
const WINDOWS_MODE = "Windows keeps no POSIX mode bits, so privacy there is the per-user folder's ACL";
const sha = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chrome-listing-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function sheet(extra: Record<string, unknown> = {}, visibility = "Unlisted") {
  return {
    dashboardUrl: "https://chrome.google.com/webstore/devconsole",
    package: { url: "/pkg", name: "chrome.zip", buildId: "abc1234", sha256: sha(ZIP) },
    left: [{ id: "chrome.item", label: "Chrome Web Store item" }],
    pages: [
      { page: "Store listing", fields: [{ id: "chrome.description", label: "Description", text: "Fills store pages." }], images: [{ id: "chrome.store_icon", files: [{ url: "/icon", name: "chrome-icon-128x128.png" }] }, { id: "chrome.screenshots", files: [{ url: "/shot", name: "chrome-screenshot-1-1280x800.png" }, { url: "/wide", name: "chrome-screenshot-2-1400x800.png" }] }], answers: [] },
      { page: "Privacy", fields: [{ id: "chrome.permission_justifications", label: "Permissions justification", text: "`storage`: keeps the session.\nhttps://*.extension.dev/*: downloads the package." }], images: [], answers: [{ id: "chrome.data_usage", label: "Data usage certifications", kind: "owner-certifies" }] },
      { page: "Distribution", fields: [{ id: "chrome.visibility", label: "Visibility", text: visibility }], images: [], answers: [] },
    ],
    ...extra,
  };
}

const served: Record<string, Buffer> = { "/pkg": ZIP, "/icon": png(128, 128), "/shot": png(1280, 800), "/wide": png(1400, 800) };

describe("the Chrome first-listing sheet", () => {
  it("keeps only the package whose SHA-256 the build recorded and images of the size each slot takes", async () => {
    const plan = await chromePlan(sheet(), async (url) => ({ ok: true, bytes: served[url]! }), tmp);

    expect(plan.pkg?.sha256).toBe(sha(ZIP));
    expect(fs.statSync(plan.pkg!.path).mode & 0o777, WINDOWS_MODE).toBe(ownerOnlyMode(0o600));
    expect(plan.icon.map((file) => file.name)).toEqual(["chrome-icon-128x128.png"]);
    expect(plan.screenshots.map((file) => file.name)).toEqual(["chrome-screenshot-1-1280x800.png"]);
    expect(plan.notes).toEqual(["chrome-screenshot-2-1400x800.png is 1400x800, and Chrome takes screenshots at 1280x800 or 640x400"]);
    expect(plan.justifications).toEqual([
      { permission: "storage", text: "keeps the session." },
      { permission: "https://*.extension.dev/*", text: "downloads the package." },
    ]);

    expect(plan.declarations).toEqual(["Data usage certifications"]);
    expect(plan.left).toEqual([]);
    expect(plan.item).toBeNull();
    expect(plan.visibility).toBe("unlisted");

    const swapped = await chromePlan(sheet(), async (url) => ({ ok: true, bytes: url === "/pkg" ? Buffer.concat([ZIP, Buffer.from("x")]) : served[url]! }), tmp);

    expect(swapped.pkg).toBeNull();
    expect(swapped.notes).toContain("the package bytes do not match the SHA-256 the build recorded, so it was not used");
  });

  it("never drafts Public and reads the item the project already names", async () => {
    const plan = await chromePlan(sheet({ dashboardUrl: "https://chrome.google.com/webstore/devconsole/pub-1/abcdefghijklmnopabcdefghijklmnop/edit" }, "Public"), async (url) => ({ ok: true, bytes: served[url]! }), tmp);

    expect(plan.visibility).toBe("unlisted");
    expect(plan.notes.some((note) => note.startsWith("STORE.md asks for Public"))).toBe(true);
    expect(plan.item).toEqual({ publisherId: "pub-1", itemId: "abcdefghijklmnopabcdefghijklmnop" });
  });
});

type Call = { method: string; args: unknown[] };

function page(where: Partial<Where>, gates: Record<string, unknown> = {}): { page: ChromePage; calls: Call[]; clicks: number } {
  const calls: Call[] = [];
  const state = { clicks: 0 };
  const base: Where = { host: "chrome.google.com", path: "/webstore/devconsole/pub-1", signIn: false, dashboard: true, publisherId: "pub-1", itemId: "", tab: "", dialog: null, dialogTakesZip: false, ...where };

  return {
    calls,
    get clicks() {
      return state.clicks;
    },
    page: {
      call: async <T>(method: string, ...args: unknown[]) => {
        calls.push({ method, args });

        return (method === "where" ? base : (gates[String(args[0])] ?? { ok: false, reason: "no-button" })) as T;
      },
      handle: async () => null,
      setFiles: async () => undefined,
      click: async () => {
        state.clicks += 1;
      },
      type: async () => undefined,
      navigate: async () => undefined,
    },
  };
}

async function planned(): Promise<ChromePlan> {
  return chromePlan(sheet(), async (url) => ({ ok: true, bytes: served[url]! }), tmp);
}

describe("one step of the guided Chrome first listing", () => {
  it("only waits on a Google sign-in page and reads nothing on it", async () => {
    const run = newRun("ws/p", await planned(), 0);
    const fake = page({ host: "accounts.google.com", signIn: true, dashboard: false });

    expect(await chromeStep(run, { page: fake.page, sleep: async () => undefined, now: () => 0 })).toBe("wait");
    expect(run.line).toBe(SIGN_IN_LINE);
    expect(fake.calls.map((call) => call.method)).toEqual(["where"]);
    expect(fake.clicks).toBe(0);
  });

  it("presses New item once, never again when no item comes back, and stops after two minutes", async () => {
    let now = 0;
    const run = newRun("ws/p", await planned(), now);
    const fake = page({}, { newItem: { ok: true, label: "New item", x: 1, y: 1 } });
    const deps = { page: fake.page, sleep: async () => undefined, now: () => now };

    expect(await chromeStep(run, deps)).toBe("moved");
    expect(await chromeStep(run, deps)).toBe("wait");

    now = 121_000;

    expect(await chromeStep(run, deps)).toBe("stopped");
    expect(fake.clicks).toBe(1);
    expect(run.stopped).toContain("is not pressed again");
    expect(await chromeStep(run, deps)).toBe("stopped");
    expect(fake.clicks).toBe(1);
  });

  it("stops at a dialog or a guarded control and presses nothing", async () => {
    const dialog = page({ dialog: "Submit for review?" });
    const guarded = page({}, { newItem: { ok: false, reason: "guarded" } });

    for (const fake of [dialog, guarded]) {
      const run = newRun("ws/p", await planned(), 0);

      expect(await chromeStep(run, { page: fake.page, sleep: async () => undefined, now: () => 0 })).toBe("stopped");
      expect(fake.clicks).toBe(0);
      expect(run.stopped).toContain("Nothing else was pressed.");
    }
  });

  it("refuses to fill an item the run did not make when the project names none", async () => {
    const run = newRun("ws/p", await planned(), 0);
    const fake = page({ itemId: "abcdefghijklmnopabcdefghijklmnop" });

    expect(await chromeStep(run, { page: fake.page, sleep: async () => undefined, now: () => 0 })).toBe("stopped");
    expect(run.itemId).toBe("");
    expect(fake.clicks).toBe(0);
  });

  it("saves only an item the run made on the project, once, and reports a refused save after a few tries", async () => {
    const asked: Array<{ itemId: string; publisherId: string }> = [];

    const saving = (answer: { ok: true } | { ok: false; message: string }) => async (ids: { itemId: string; publisherId: string }) => {
      asked.push(ids);

      return answer;
    };

    const run = newRun("ws/p", await planned(), 0);

    await saveNewItem(run, saving({ ok: true }));
    expect(asked).toEqual([]);

    Object.assign(run, { created: true, itemId: "abcdefghijklmnopabcdefghijklmnop", publisherId: "pub-1" });
    await saveNewItem(run, saving({ ok: true }));
    await saveNewItem(run, saving({ ok: true }));

    expect(asked).toEqual([{ itemId: "abcdefghijklmnopabcdefghijklmnop", publisherId: "pub-1" }]);
    expect(run.itemSaved).toBe("saved");

    const refused = newRun("ws/q", await planned(), 0);

    Object.assign(refused, { created: true, itemId: "abcdefghijklmnopabcdefghijklmnop", publisherId: "pub-1" });

    for (let i = 0; i < 7; i += 1) await saveNewItem(refused, saving({ ok: false, message: "403 not an owner" }));

    expect(asked).toHaveLength(6);
    expect(refused.itemSaved).toBe("403 not an owner");
  });

  it("drops a checklist line once the dashboard marks its tab complete and always leaves Submit for review", async () => {
    const run = newRun("ws/p", await planned(), 0);

    run.rows = [
      { tab: "privacy", line: "Data usage certifications on Privacy: yours to answer" },
      { tab: "listing", line: "Category on Store listing: choose Developer Tools yourself" },
    ];

    expect(openRows(run, { privacy: "incomplete" })).toEqual([...run.rows.map((row) => row.line), expect.stringMatching(/^Submit for review: yours to press/)]);
    expect(openRows(run, { privacy: "complete", listing: "unknown" })).toEqual(["Category on Store listing: choose Developer Tools yourself", expect.stringMatching(/^Submit for review: yours to press/)]);
  });
});

describe("the guided Chrome first listing answer", () => {
  function answer(status: string, store = "chrome", project = "extension-dev-tools"): string {
    return JSON.stringify({
      ok: true,
      command: "extension_submit",
      status,
      value: { action: "first-submission", store, project: `extensiondev/${project}`, pageUrl: `https://console.extension.dev/extensiondev/${project}/submissions/chrome`, dashboardUrl: null, opened: true, openPages: [{ url: "https://console.extension.dev/x" }] },
      hint: "lane words",
    });
  }

  function runtime(launches: LaunchPlan[]): GuidedConnectRuntime {
    const binary = (name: string) => `/Applications/${name}.app/Contents/MacOS/${name}`;

    return {
      ...guidedConnectRuntime,
      launchBlock: () => "",
      probe: () => ({ platform: "darwin", systemBinary: (name) => (name === "firefox" || name === "chromium" ? binary(name) : null), managedBinary: () => null, lastUsed: (app) => (app.includes("firefox") ? 9 : 1), defaultBrowser: () => null }),
      fetch: (async () => Promise.reject(new Error("offline"))) as unknown as typeof fetch,
      stateDir: () => tmp,
      cacheDir: () => path.join(tmp, "cache"),
      launch: (plan) => {
        launches.push(plan);

        return { launched: true, reused: false };
      },
      windowCheck: async () => "visible",
      schedule: () => undefined,
    };
  }

  it("opens the dashboard in a Chromium window even when Firefox was used last, and a second call reads the run instead of opening again", async () => {
    const launches: LaunchPlan[] = [];
    const read: string[] = [];
    const deps: ChromeListingDeps = {
      plan: async (slug) => {
        read.push(slug);

        return { plan: await planned() };
      },
      watch: (args) => watchChromeListing({ ...args, minutes: 0, proc: { table: () => null, list: () => "", signal: () => false, wait: () => undefined, platform: "darwin" } }),
    };

    expect(await guideChromeListing(answer("first-submission-to-do", "edge"), {}, runtime(launches), deps)).toBeNull();
    expect(await guideChromeListing(answer("first-submission-done"), {}, runtime(launches), deps)).toBeNull();

    const out = JSON.parse((await guideChromeListing(answer("first-submission-to-do"), {}, runtime(launches), deps))!);

    expect(launches.map((plan) => [plan.choice.browser, plan.url])).toEqual([["chromium", DASHBOARD_HOME]]);
    expect(out).toMatchObject({ status: "first-listing-guided", value: { opened: true, landedOn: DASHBOARD_HOME, guidedBrowser: { browser: "chromium" }, nextStep: { kind: "dashboard", url: DASHBOARD_HOME } } });
    expect(out.value).not.toHaveProperty("openPages");
    expect(out.value.sayToPerson).toContain(SIGN_IN_LINE);
    expect(out.value.sayToPerson).toContain("presses \"New item\" once");
    expect(out.value.sayToPerson).toContain("Submit for review stays with you");

    const again = JSON.parse((await guideChromeListing(answer("first-submission-to-do"), {}, runtime(launches), deps))!);

    expect(launches).toHaveLength(1);
    expect(read).toEqual(["extensiondev/extension-dev-tools"]);
    expect(again.hint).toMatch(/^The guided window already runs this Chrome listing/);
    expect(again.value.progress).toMatchObject({ itemId: null, created: false, done: [] });
  });

  it("opens nothing when the first-submission sheet cannot be read, and says why", async () => {
    const launches: LaunchPlan[] = [];
    const deps: ChromeListingDeps = { plan: async () => ({ refused: "the login expired" }), watch: () => { throw new Error("no watch"); } };
    const out = JSON.parse((await guideChromeListing(answer("first-submission-waiting", "chrome", "unread"), {}, runtime(launches), deps))!);

    expect(launches).toEqual([]);
    expect(out).toMatchObject({ status: "first-submission-waiting", value: { opened: false, guidedBrowser: { opened: false } } });
    expect(out.hint).toMatch(/^No guided window was opened, since the first-submission sheet could not be read: the login expired/);
  });
});
