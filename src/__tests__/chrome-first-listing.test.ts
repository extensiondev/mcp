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
import vm from "node:vm";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { chromeLocalesOf } from "../lib/chrome-listing-languages";
import { chromePlan, type ChromePlan } from "../lib/chrome-listing-plan";
import { answerPanel, DASHBOARD_HOME, mergeProgress, newRun, PAGE_HOST_GLOBAL, panelSource, panelTick, submitRow } from "../lib/chrome-panel";
import { type LaunchPlan } from "../lib/guided-connect";
import { chromeTick, guideChromeListing, liveRun, signInLine, watchChromeListing, type ChromeDriver, type ChromeListingDeps } from "../lib/guided-chrome-listing";
import { treeSha256 } from "../lib/tools-extension";
import { png, runtime, served, sha, sheet, ZIP, sheetAnswer } from "./fixtures/chrome-listing-sheet";

const ownerOnlyMode = (posix: number) => (process.platform === "win32" ? 0o666 : posix);
const WINDOWS_MODE = "Windows keeps no POSIX mode bits, so privacy there is the per-user folder's ACL";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chrome-listing-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

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

async function planned(): Promise<ChromePlan> {
  return chromePlan(sheet(), async (url) => ({ ok: true, bytes: served[url]! }), tmp);
}

const TRANSLATED = `# Store listing

## Listing

- Name: Shield
- Description: Hides personal data.

## Listing (pt-BR)

- Name: Escudo
- Description: Esconde dados pessoais.

## Listing (de)

- Description: Verbirgt persönliche Daten.
`;

function translatedProject(): string {
  const root = fs.mkdtempSync(path.join(tmp, "project-"));
  const shots = path.join(root, "store", "screenshots", "chrome", "pt-BR");

  fs.writeFileSync(path.join(root, "STORE.md"), TRANSLATED);
  fs.mkdirSync(shots, { recursive: true });
  fs.writeFileSync(path.join(shots, "1.png"), png(1280, 800));
  fs.writeFileSync(path.join(shots, "2.png"), png(1400, 800));

  return root;
}


const ITEM = "abcdefghijklmnopabcdefghijklmnop";

const FAKE_PANEL = `globalThis.${PAGE_HOST_GLOBAL} = (() => { const queue = []; const answers = {}; const pushed = []; return { queue, answers, pushed, take: () => queue.splice(0), answer: (id, value) => { answers[id] = value; return true; }, push: (message) => { pushed.push(message); return 1; } }; })();`;

type FakeHost = { queue: Array<{ id: number; message: Record<string, unknown> }>; answers: Record<number, any>; pushed: unknown[] };

function dashboardTab(password = false) {
  const context = vm.createContext({ location: { host: "chrome.google.com" }, document: { querySelectorAll: () => (password ? [{ offsetParent: {} }] : []) } });
  const evaluated: string[] = [];
  const methods: string[] = [];

  return {
    evaluated,
    methods,
    host: () => (context as Record<string, unknown>)[PAGE_HOST_GLOBAL] as FakeHost | undefined,
    page: { evaluate: async <T>(expression: string) => { evaluated.push(expression); return vm.runInContext(expression, context) as T; } },
    driver: (url: string): ChromeDriver => ({
      targets: async () => [{ type: "page", url, webSocketDebuggerUrl: "ws://fake" }],
      open: async () => ({
        send: async (method: string, params?: Record<string, unknown>) => {
          methods.push(method);
          if (method !== "Runtime.evaluate") return {};

          const expression = String(params?.expression ?? "");

          evaluated.push(expression);

          return { result: { value: vm.runInContext(expression, context) } };
        },
        close: () => undefined,
      }),
      sleep: async () => undefined,
      now: () => 0,
    }),
  };
}

describe("the tools panel the MCP places on the Chrome dashboard (1277)", () => {
  it("places the bundled panel once per page, answers its session, progress and checked files, and sends the tab nothing but evaluations", async () => {
    const run = newRun({ slug: "ws/p", plan: await planned(), expiresAt: "2026-11-27T20:00:00.000Z" });
    const tab = dashboardTab();
    const driver = tab.driver(`${DASHBOARD_HOME}/pub-1`);

    expect(await chromeTick(run, { port: 9222, driver, source: FAKE_PANEL })).toBe("relayed");
    tab.host()!.queue.push({ id: 1, message: { type: "tools:panel", url: `${DASHBOARD_HOME}/pub-1` } }, { id: 2, message: { type: "tools:listing" } });
    await chromeTick(run, { port: 9222, driver, source: FAKE_PANEL });

    const session = tab.host()!.answers[1];

    expect(tab.evaluated.filter((expression) => expression === FAKE_PANEL)).toHaveLength(1);
    expect(new Set(tab.methods)).toEqual(new Set(["Runtime.evaluate"]));
    expect(session).toMatchObject({ kind: "first-submission", store: "chrome", guide: true, project: { slug: "ws/p" }, chrome: { visibility: "unlisted" }, package: { name: "chrome.zip", buildId: "abc1234", sha256: sha(ZIP) } });
    expect(tab.host()!.answers[2]).toMatchObject({ running: false, itemId: "", newPressed: false });

    tab.host()!.queue.push({ id: 3, message: { type: "tools:file", url: session.package.url } }, { id: 4, message: { type: "tools:file", url: "extension-dev-file:../../etc/passwd" } });
    await chromeTick(run, { port: 9222, driver, source: FAKE_PANEL });

    expect(Buffer.from(tab.host()!.answers[3].base64, "base64").equals(ZIP)).toBe(true);
    expect(tab.host()!.answers[4]).toMatchObject({ ok: false });

    fs.writeFileSync(run.plan.pkg!.path, Buffer.concat([ZIP, Buffer.from("x")]));
    expect(await answerPanel(run, { type: "tools:file", url: session.package.url }, { tabUrl: "" })).toMatchObject({ ok: false, message: expect.stringContaining("changed on disk") });
  });

  it("never places the panel on a Google sign-in or a dashboard tab showing a password field", async () => {
    const run = newRun({ slug: "ws/p", plan: await planned(), expiresAt: "2026-11-27T20:00:00.000Z" });
    const signIn = dashboardTab();

    expect(await chromeTick(run, { port: 9222, driver: signIn.driver("https://accounts.google.com/v3/signin/identifier"), source: FAKE_PANEL })).toBe("idle");
    expect(signIn.evaluated).toEqual([]);

    const password = dashboardTab(true);

    await chromeTick(run, { port: 9222, driver: password.driver(`${DASHBOARD_HOME}/pub-1`), source: FAKE_PANEL });
    expect(password.evaluated).not.toContain(FAKE_PANEL);
  });

  it("keeps the progress moving forward and saves only the item this run made, while the tab shows it", async () => {
    const run = newRun({ slug: "ws/p", plan: await planned(), expiresAt: "2026-11-27T20:00:00.000Z" });
    const saved: unknown[] = [];

    const save = async (ids: unknown) => {
      saved.push(ids);

      return { ok: true as const };
    };

    run.progress = mergeProgress(run.progress, { itemId: ITEM, publisherId: "pub-1", created: true });
    expect(run.progress.itemId).toBe("");

    run.progress = mergeProgress(run.progress, { newPressed: true, pressedAt: 5 });
    run.progress = mergeProgress(run.progress, { itemId: ITEM, publisherId: "pub-1", created: true, newPressed: false, done: ["listing", "bogus"] });
    run.progress = mergeProgress(run.progress, { itemId: "pppppppppppppppppppppppppppppppp", publisherId: "pub-2", pressedAt: 9 });

    expect(run.progress).toMatchObject({ itemId: ITEM, publisherId: "pub-1", newPressed: true, pressedAt: 5, created: true, done: ["listing"] });
    expect(await answerPanel(run, { type: "tools:product" }, { tabUrl: `${DASHBOARD_HOME}/pub-1/pppppppppppppppppppppppppppppppp/edit`, save })).toMatchObject({ ok: false });
    expect(saved).toEqual([]);
    expect(await answerPanel(run, { type: "tools:product" }, { tabUrl: `${DASHBOARD_HOME}/pub-1/${ITEM}/edit`, save })).toEqual({ ok: true, connectedAs: "" });
    expect(await answerPanel(run, { type: "tools:product" }, { tabUrl: `${DASHBOARD_HOME}/pub-1/${ITEM}/edit`, save })).toEqual({ ok: true, connectedAs: "" });
    expect(saved).toEqual([{ itemId: ITEM, publisherId: "pub-1" }]);
    expect(submitRow(run)).toMatch(/^Submit for review: this item was made in the dashboard/);
  });

  it("ends the panel when the person ends the session, and reads the panel only from a bundle whose files hash to its record", async () => {
    const run = newRun({ slug: "ws/p", plan: await planned(), expiresAt: "2026-11-27T20:00:00.000Z" });
    const tab = dashboardTab();

    await panelTick(run, tab.page, { tabUrl: `${DASHBOARD_HOME}/pub-1`, source: FAKE_PANEL });
    tab.host()!.queue.push({ id: 1, message: { type: "tools:cancel" } });
    await panelTick(run, tab.page, { tabUrl: `${DASHBOARD_HOME}/pub-1`, source: FAKE_PANEL });

    expect(run.ended).toBe(true);
    expect(tab.host()!.pushed).toEqual([{ type: "tools:ended" }]);

    const dir = path.join(tmp, "bundle");
    const file = path.join(dir, "chromium", "scripts", "store-panel-page.js");

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, FAKE_PANEL);
    fs.writeFileSync(path.join(dir, "bundle.json"), JSON.stringify({ version: "0.1.3", sha256: { chromium: treeSha256(path.join(dir, "chromium")) } }));
    expect(panelSource(dir)).toBe(FAKE_PANEL);

    fs.writeFileSync(file, `${FAKE_PANEL} globalThis.changed = true;`);
    expect(panelSource(dir)).toBeNull();
  });
});

describe("the guided Chrome first listing answer", () => {
  it("opens the dashboard in a Chromium window even when Firefox was used last, a second call reads the run instead of opening again, never replaces a running panel, and replace: true or a sync-listing refill starts a fresh one once it rests", async () => {
    const launches: LaunchPlan[] = [];
    const read: string[] = [];
    const deps: ChromeListingDeps = {
      plan: async (slug) => {
        read.push(slug);

        return { plan: await planned() };
      },
      watch: (args) => watchChromeListing({ ...args, minutes: 0, source: FAKE_PANEL, proc: { table: () => null, list: () => "", signal: () => false, wait: () => undefined, platform: "darwin" } }),
    };

    expect(await guideChromeListing(sheetAnswer("first-submission-to-do", "edge"), {}, runtime(launches, tmp), deps)).toBeNull();
    expect(await guideChromeListing(sheetAnswer("first-submission-done"), {}, runtime(launches, tmp), deps)).toBeNull();

    const out = JSON.parse((await guideChromeListing(sheetAnswer("first-submission-to-do"), {}, runtime(launches, tmp), deps))!);

    expect(launches.map((plan) => [plan.choice.browser, plan.url])).toEqual([["chromium", DASHBOARD_HOME]]);
    expect(out).toMatchObject({ status: "first-listing-guided", value: { opened: true, landedOn: DASHBOARD_HOME, guidedBrowser: { browser: "chromium" }, nextStep: { kind: "dashboard", url: DASHBOARD_HOME } } });
    expect(out.value).not.toHaveProperty("openPages");
    expect(out.value.sayToPerson).toContain(signInLine(""));
    expect(out.value.sayToPerson).toContain("the next step is to press \"Create and fill the Chrome listing\" in the panel");
    expect(out.value.sayToPerson).toContain("presses \"New item\" once");
    expect(out.value.sayToPerson).toContain("Submit for review is one approval-gated extension_submit publish call afterwards");
    expect(out.hint).toContain("it presses nothing on the page");

    const running = liveRun("extensiondev/extension-dev-tools")!;

    running.progress.running = true;

    const again = JSON.parse((await guideChromeListing(sheetAnswer("first-submission-to-do"), { replace: true }, runtime(launches, tmp), deps))!);

    expect(launches).toHaveLength(1);
    expect(read).toEqual(["extensiondev/extension-dev-tools"]);
    expect(again.hint).toMatch(/^The guided window already holds the tools panel for this Chrome listing/);
    expect(again.value.progress).toMatchObject({ itemId: null, created: false, done: [], running: true });
    expect(liveRun("extensiondev/extension-dev-tools")).toBe(running);

    running.progress.running = false;

    const waiting = JSON.parse((await guideChromeListing(sheetAnswer("first-submission-to-do"), {}, runtime(launches, tmp), deps))!);

    expect(waiting.hint).toMatch(/the person presses Continue on it; extension_submit \{action: "first-submission", store: "chrome", project: "extensiondev\/extension-dev-tools", replace: true\} starts a fresh run\.$/);

    const finished = liveRun("extensiondev/extension-dev-tools")!;

    finished.progress.finished = true;

    const after = JSON.parse((await guideChromeListing(sheetAnswer("first-submission-to-do"), {}, runtime(launches, tmp), deps))!);

    expect(launches).toHaveLength(1);
    expect(after.value.nextStep).toMatchObject({ kind: "publish", say: expect.stringMatching(/^Submit for review: extension_approvals_request \{act: "extension_submit", args: \{action: "publish", project: "extensiondev\/extension-dev-tools", browsers: \["chrome"\]\}\}/) });
    expect(after.hint).toMatch(/^The guided Chrome run finished and this read changed nothing\. To send the saved draft to review, extension_approvals_request/);

    for (const args of [{ replace: true }, { refill: true }]) {
      const done = liveRun("extensiondev/extension-dev-tools")!;

      done.progress.finished = true;

      const refilled = JSON.parse((await guideChromeListing(sheetAnswer("first-submission-to-do"), args, runtime(launches, tmp), deps))!);

      expect(refilled.hint).toMatch(/^The earlier panel run was replaced; a fresh panel run started in the same window and profile/);
      expect(liveRun("extensiondev/extension-dev-tools")).not.toBe(done);
    }

    expect(launches).toHaveLength(3);
  });

  it("1239: fills the update of an item Chrome already serves, from a published sheet or the lane's already-live refusal, and leaves Distribution alone", async () => {
    const launches: LaunchPlan[] = [];
    const watched: ChromePlan[] = [];
    const live = { state: "done", read: { word: "published", storeWord: "PUBLISHED", readAt: "2026-11-26T10:40:46.456Z", source: "poll" }, dashboardUrl: "https://chrome.google.com/webstore/devconsole/pub1/abcdefghijklmnopabcdefghijklmnop/edit" };
    const deps: ChromeListingDeps = {
      plan: async () => ({ plan: await chromePlan(sheet(live), async (url) => ({ ok: true, bytes: served[url]! }), tmp) }),
      watch: (args) => {
        watched.push(args.plan);

        return watchChromeListing({ ...args, minutes: 0, source: FAKE_PANEL, proc: { table: () => null, list: () => "", signal: () => false, wait: () => undefined, platform: "darwin" } });
      },
    };
    const published = (status: string, project: string, word = "published") => JSON.stringify({ ...JSON.parse(sheetAnswer(status, "chrome", project)), value: { ...JSON.parse(sheetAnswer(status, "chrome", project)).value, read: { word } } });

    expect(await guideChromeListing(published("first-submission-done", "in-review", "submitted"), {}, runtime(launches, tmp), deps)).toBeNull();

    const projectPath = translatedProject();

    for (const [status, project] of [["first-submission-done", "live-a"], ["first-submission-already-live", "live-b"]]) {
      const out = JSON.parse((await guideChromeListing(published(status!, project!), { projectPath }, runtime(launches, tmp), deps))!);

      expect(out).toMatchObject({ status: "first-listing-guided", value: { opened: true } });
      expect(out.value.sayToPerson).toContain("an item Chrome already serves");
      expect(out.value.sayToPerson).toContain("leaves Distribution as Chrome serves it");
      expect(out.value.sayToPerson).not.toContain("New item");
      expect(out.value.sayToPerson).toContain("it picks pt-BR and de on Store listing's language picker");
      expect(out.value.progress.languages).toEqual(["pt-BR: waiting for the default language's Store listing to be saved", "de: waiting for the default language's Store listing to be saved"]);
    }

    expect(watched.map((plan) => [plan.live, plan.item?.itemId, plan.locales.map((row) => row.locale)])).toEqual([[true, "abcdefghijklmnopabcdefghijklmnop", ["pt-BR", "de"]], [true, "abcdefghijklmnopabcdefghijklmnop", ["pt-BR", "de"]]]);
  });

  it("opens nothing when the first-submission sheet cannot be read, and says why", async () => {
    const launches: LaunchPlan[] = [];
    const deps: ChromeListingDeps = { plan: async () => ({ refused: "the login expired" }), watch: () => { throw new Error("no watch"); } };
    const out = JSON.parse((await guideChromeListing(sheetAnswer("first-submission-waiting", "chrome", "unread"), {}, runtime(launches, tmp), deps))!);

    expect(launches).toEqual([]);
    expect(out).toMatchObject({ status: "first-submission-waiting", value: { opened: false, guidedBrowser: { opened: false } } });
    expect(out.hint).toMatch(/^No guided window was opened, since the first-submission sheet could not be read: the login expired/);
  });
});
