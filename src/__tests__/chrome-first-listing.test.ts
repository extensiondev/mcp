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

import { CHROME_PAGE_AGENT, CHROME_SELECTORS, DASHBOARD_HOME, DIALOG_RULES, type DialogFacts } from "../lib/chrome-dashboard-agent";
import { attach } from "../lib/chrome-listing-fill";
import { chromeLocalesOf } from "../lib/chrome-listing-languages";
import { chromePlan, type ChromePlan } from "../lib/chrome-listing-plan";
import { chromeStep, fitHostLines, newRun, openRows, RENDER_WAIT_MS, saveNewItem, SIGN_IN_LINE, signInLine, tabsOf, type ChromePage, type PrivacyAsks, type Where } from "../lib/chrome-listing-run";
import { type LaunchPlan } from "../lib/guided-connect";
import { guideChromeListing, liveRun, watchChromeListing, type ChromeListingDeps } from "../lib/guided-chrome-listing";
import { painted, png, runtime, served, sha, sheet, ZIP, sheetAnswer, fakePage, stepDeps } from "./fixtures/chrome-listing-sheet";

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

describe("one step of the guided Chrome first listing", () => {
  it("only waits on a Google sign-in page and reads nothing on it", async () => {
    const run = newRun("ws/p", await planned(), 0);
    const fake = fakePage({ host: "accounts.google.com", signIn: true, dashboard: false });

    expect(await chromeStep(run, { page: fake.page, sleep: async () => undefined, now: () => 0 })).toBe("wait");
    expect(run.line).toBe(SIGN_IN_LINE);
    expect(fake.calls.map((call) => call.method)).toEqual(["where"]);
    expect(fake.clicks).toBe(0);
  });

  it("presses New item once, never again when no item comes back, and stops after two minutes", async () => {
    let now = 0;
    const run = newRun("ws/p", await planned(), now);
    const fake = fakePage({}, { newItem: { ok: true, label: "New item", x: 1, y: 1 } });
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
    const dialog = fakePage({ dialog: "Submit for review?" });
    const guarded = fakePage({}, { newItem: { ok: false, reason: "guarded" } });

    for (const fake of [dialog, guarded]) {
      const run = newRun("ws/p", await planned(), 0);

      expect(await chromeStep(run, { page: fake.page, sleep: async () => undefined, now: () => 0 })).toBe("stopped");
      expect(fake.clicks).toBe(0);
      expect(run.stopped).toContain("Nothing else was pressed.");
    }
  });

  it("refuses to fill an item the run did not make when the project names none", async () => {
    const run = newRun("ws/p", await planned(), 0);
    const fake = fakePage({ itemId: "abcdefghijklmnopabcdefghijklmnop" });

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

  it("1241: opens the item as the signed-in account that holds its publisher, asks for that account only when none does, and fills nothing on an Items list", async () => {
    const item = "omndndgipeomhfdobfbhpfemempnnpjp";
    const plan = { ...(await chromePlan(sheet({ dashboardUrl: `https://chrome.google.com/webstore/devconsole/pub-owner/${item}/edit` }), async (url) => ({ ok: true, bytes: served[url]! }), tmp)), account: "owner@example.com" };
    const capture: Where = { host: "chrome.google.com", path: "/webstore/devconsole/pub-other", heading: "Items", itemsList: true, signedInAs: "person@example.com", signIn: false, dashboard: true, publisherId: "pub-other", itemId: "", tab: "", dialog: null, dialogTakesZip: false };
    const form = (index: number): Where => ({ ...capture, path: `/u/${index}/webstore/devconsole/pub-owner/${item}/edit`, heading: "Store listing", itemsList: false, signedInAs: "owner@example.com", publisherId: "pub-owner", itemId: item, tab: "listing" });
    const at = (url: string) => Number(/\/u\/(\d+)\//.exec(url)?.[1] ?? 0);

    const drive = (owner: number | null) => {
      const calls: string[] = [];
      const visits: string[] = [];
      const state = { clicks: 0 };
      const fake: ChromePage = {
        call: async <T>(method: string) => {
          calls.push(method);

          if (method !== "where") return { ok: false, reason: "no-button" } as T;

          const last = visits[visits.length - 1];

          return (last && owner !== null && at(last) === owner ? form(owner) : capture) as T;
        },
        handle: async () => null,
        setFiles: async () => undefined,
        click: async () => {
          state.clicks += 1;
        },
        type: async () => undefined,
        navigate: async (to) => {
          visits.push(to);
        },
      };

      return { calls, visits, state, deps: { page: fake, sleep: async () => undefined, now: () => 0 } };
    };

    const found = drive(1);
    const run = newRun("extensiondev/extension-dev-tools", plan, 0);

    expect(await chromeStep(run, found.deps)).toBe("moved");
    expect(found.visits).toEqual([`https://chrome.google.com/u/1/webstore/devconsole/pub-owner/${item}/edit`]);
    expect(found.calls).toEqual(["where"]);
    expect(await chromeStep(run, found.deps)).toBe("stopped");
    expect(run.stopped).toContain("The page shows \"Store listing\" at /u/1/webstore/devconsole/pub-owner");
    expect(found.calls).toContain("inventory");

    const none = drive(null);
    const lost = newRun("extensiondev/extension-dev-tools", plan, 0);

    for (let i = 0; i < 4; i += 1) expect(await chromeStep(lost, none.deps)).toBe("moved");

    expect(await chromeStep(lost, none.deps)).toBe("wait");
    expect(await chromeStep(lost, none.deps)).toBe("wait");
    expect(none.visits.map(at)).toEqual([1, 2, 3, 4]);
    expect(lost.line).toMatch(new RegExp(`^No account signed in to this window opens item ${item} of publisher pub-owner \\(tried /u/0/ the Items list at /webstore/devconsole/pub-other, signed in as person@example.com of publisher pub-other, `));
    expect(lost.line).toContain("Sign in as owner@example.com in this window");
    expect(none.calls.every((method) => method === "where")).toBe(true);
    expect(none.state.clicks).toBe(0);
    expect(lost).toMatchObject({ stopped: "", filled: [], done: [] });

    const listed = drive(0);
    const race = newRun("extensiondev/extension-dev-tools", plan, 0);
    const itemsAtItem: Where = { ...form(0), heading: "Items", itemsList: true };

    race.publisherId = "pub-owner";
    listed.deps.page.call = (async <T>(method: string) => (method === "where" ? itemsAtItem : { ok: false, reason: "no-button" }) as T) as ChromePage["call"];

    for (let i = 0; i < 4; i += 1) expect(await chromeStep(race, listed.deps)).toBe("moved");

    expect(listed.visits.map(at)).toEqual([0, 0, 0, 1]);

    const refused = newRun("extensiondev/extension-dev-tools", plan, 0);
    const deniedAt: Where = { ...form(0), heading: "", itemsList: false, denied: true };
    const seen: string[] = [];

    listed.deps.page.call = (async <T>(method: string) => {
      seen.push(method);

      return (method === "where" ? deniedAt : { ok: false, reason: "no-button" }) as T;
    }) as ChromePage["call"];

    expect(await chromeStep(refused, listed.deps)).toBe("moved");
    expect(listed.visits.map(at).slice(4)).toEqual([1]);
    expect(refused.tried).toEqual([`/u/0/ a 403 page (this account has no access to it) at /u/0/webstore/devconsole/pub-owner/${item}/edit, signed in as owner@example.com`]);
    expect(seen).toEqual(["where"]);
    expect(race.filled).toEqual([]);
    expect(signInLine("owner@example.com")).toMatch(/^Sign in as owner@example.com, the Google account that holds the Chrome Web Store item/);
    expect(signInLine("")).toBe(SIGN_IN_LINE);
  });

  it("1243 and 1244: reads a label Chrome repeats, replaces an icon the item holds, names screenshots already there, fits host reasons whole and never opens Distribution on a live item", async () => {
    const item = "omndndgipeomhfdobfbhpfemempnnpjp";
    const reason = "downloads the build package and the listing images of the project from the platform with the person's sign-in, only the files the session names, and checks each package against its SHA-256.";
    const hosts = ["https://*.extension.dev/*", "https://*.extension.land/*", "https://console.extension.dev/*", "https://www.extension.dev/device/handoff*", "https://partner.microsoft.com/*", "https://chrome.google.com/*", "https://addons.mozilla.org/*"];
    const live = { state: "done", read: { word: "published" }, dashboardUrl: `https://chrome.google.com/webstore/devconsole/pub-owner/${item}/edit` };
    const long = sheet(live);

    long.pages[1]!.fields[0]!.text = ["`storage`: keeps the session.", ...hosts.map((host) => `${host}: ${reason}`)].join("\n");
    long.pages[0]!.fields.push({ id: "chrome.category", label: "Category", text: "Developer Tools" }, { id: "chrome.homepage_url", label: "Official URL", text: "https://extension.dev" });

    const plan = await chromePlan(long, async (url) => ({ ok: true, bytes: served[url]! }), tmp);

    expect("DescriptionDescriptionDescription".replace(CHROME_SELECTORS.repeated, "$1")).toBe("Description");
    expect("Homepage URLHomepage URLHomepage URL".replace(CHROME_SELECTORS.repeated, "$1")).toBe("Homepage URL");
    expect(plan.notes.some((note) => /^the host reasons under Permissions justification join to [\d,]+ characters and Chrome's Host permission justification takes at most 1,000/.test(note))).toBe(true);

    const fit = fitHostLines(plan.justifications.filter((line) => line.permission.includes("://")));

    expect(fit.length).toBeGreaterThan(1000);
    expect(fit.kept.map((line) => `${line.permission}: ${line.text}`).join("\n").length).toBeLessThanOrEqual(1000);
    expect([...fit.kept.map((line) => line.permission), ...fit.left]).toEqual(hosts);
    expect(tabsOf({ plan })).toEqual(["listing", "privacy"]);

    let tab = "listing";
    let icon = ["https://lh3.example/old-icon"];
    const justified: Array<Array<{ permission: string }>> = [];
    const set: string[] = [];
    const calls: string[] = [];
    const fake: ChromePage = {
      call: async <T>(method: string, ...args: unknown[]) => {
        calls.push(method);

        const answers: Record<string, unknown> = {
          where: { host: "chrome.google.com", path: `/u/1/webstore/devconsole/pub-owner/${item}/edit`, heading: "Store listing", itemsList: false, signedInAs: "owner@example.com", signIn: false, dashboard: true, publisherId: "pub-owner", itemId: item, tab, dialog: null, dialogTakesZip: false },
          setText: "filled",
          fieldRead: { found: true, value: "English (United States)" },
          choose: { outcome: "open", x: 5, y: 5 },
          option: { found: 0, seen: ["Productivity", "Workflow & Planning"] },
          thumbs: 1,
          images: icon,
          justify: [{ key: "storage", outcome: "filled" }, { key: "host", outcome: "filled" }],
          gate: args[0] === "save" ? { ok: true, label: "Save draft", x: 1, y: 1 } : { ok: true, label: "Privacy", x: 2, y: 2 },
          marks: {},
        };

        if (method === "justify") justified.push(args[0] as Array<{ permission: string }>);
        if (method === "gate" && String(args[0]).startsWith("tab:")) tab = String(args[0]).slice(4);

        return answers[method] as T;
      },
      handle: async () => "input-1",
      setFiles: async (_id, files) => {
        set.push(...files.map((file) => path.basename(file)));
        icon = ["https://lh3.example/new-icon"];
      },
      click: async () => undefined,
      type: async () => undefined,
      navigate: async () => undefined,
    };
    const run = newRun("extensiondev/extension-dev-tools", plan, 0);
    const deps = { page: fake, sleep: async () => undefined, now: () => 0 };

    for (let i = 0; i < 6 && !run.finished && !run.stopped; i += 1) await chromeStep(run, deps);

    expect(run).toMatchObject({ finished: true, stopped: "", done: ["listing", "privacy"] });
    expect(calls.filter((method) => method === "gate").length).toBe(3);
    expect(run.filled).toEqual(expect.arrayContaining(["Description", "Homepage URL", "Store icon: chrome-icon-128x128.png (replaced the icon the item had)", `Host permission justification (${fit.kept.length} of 7 host reasons)`]));
    expect(set).toEqual(["chrome-icon-128x128.png"]);
    expect(justified[0]!.map((line) => line.permission)).toEqual(["storage", ...fit.kept.map((line) => line.permission)]);
    expect(run.rows.map((row) => row.line)).toEqual(expect.arrayContaining([
      'Category on Store listing: choose Developer Tools yourself; the open list shows no option reading "Developer Tools" (it shows "Productivity", "Workflow & Planning")',
      "Screenshots on Store listing: the slot already holds images that could not be compared with the listing's files, so nothing was attached; compare them on the page yourself",
      expect.stringMatching(new RegExp(`^Host permission justification on Privacy: the host reasons in STORE\\.md join to [\\d,]+ characters and Chrome takes at most 1,000, so ${fit.left.join(", ").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} were left out whole`)),
    ]));
  });

  it("1247: removes only the slot's copies of the listing's own screenshots, by pixels, confirming each Remove Image dialog before the next, keeps a foreign image and attaches the listing in order", async () => {
    const shots = [1, 2, 3, 4].map((n) => painted(1280, 800, n * 40));
    const four = sheet();

    four.pages[0]!.images[1]!.files = shots.map((_, i) => ({ url: `/s${i + 1}`, name: `chrome-screenshot-${i + 1}-1280x800.png` }));

    const plan = await chromePlan(four, async (url) => ({ ok: true, bytes: /^\/s\d$/.test(url) ? shots[Number(url.slice(2)) - 1]! : served[url]! }), tmp);
    const store: Record<string, Buffer> = { "https://lh3.example/old": Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), ...Object.fromEntries([1, 2, 3].map((i) => [`https://lh3.example/k${i + 1}`, painted(1280, 800, (i + 1) * 40, true)])) };
    let tiles = ["https://lh3.example/old", "https://lh3.example/k2", "https://lh3.example/k3", "https://lh3.example/k4"];
    let pending = "";
    let confirming = "";
    let most = 0;
    const removed: string[] = [];
    const attached: string[] = [];
    const fake: ChromePage = {
      call: async <T>(method: string, ...args: unknown[]) => {
        if (method === "thumbs") return tiles.length as T;
        if (method === "slotImages") return tiles.map((key, i) => ({ key, label: `Screenshot ${i + 1}`, removable: true })) as T;
        if (method === "dialogShown") return (confirming ? { count: 1, text: "Remove Image Are you sure you want to remove this image? This cannot be undone. Cancel Remove", removeImage: true } : null) as T;
        if (method === "dialogButton") return (confirming && args[0] === "remove" ? { x: 9, y: 9 } : null) as T;

        if (method === "removeAt") {
          pending = confirming ? "" : String(args[1]);

          return (confirming ? null : { x: 1, y: 1 }) as T;
        }

        return null as T;
      },
      handle: async () => "input-1",
      setFiles: async (_id, files) => void (attached.push(path.basename(files[0]!)), (tiles = [...tiles, `https://lh3.example/new-${attached.length}`])),
      click: async (x) => {
        if (x === 9 && confirming) {
          removed.push(confirming);
          tiles = tiles.filter((key) => key !== confirming);
          confirming = "";
        } else if (x === 1 && pending) {
          confirming = pending;
          most += 1;
        }
      },
      type: async () => undefined,
      navigate: async () => undefined,
    };
    const fetched: string[] = [];
    const run = newRun("extensiondev/extension-dev-tools", plan, 0);

    expect(shots[1]!.equals(store["https://lh3.example/k2"]!)).toBe(false);

    await attach(run, stepDeps(fake, async (url) => {
      fetched.push(url);

      return store[url.replace(/=s0$/, "")] ?? null;
    }), "screenshots", plan.screenshots, "Screenshots");

    expect(fetched).toEqual(["https://lh3.example/old=s0", "https://lh3.example/k2=s0", "https://lh3.example/k3=s0", "https://lh3.example/k4=s0"]);
    expect(removed).toEqual(["https://lh3.example/k2", "https://lh3.example/k3", "https://lh3.example/k4"]);
    expect(attached).toEqual([1, 2, 3, 4].map((n) => `chrome-screenshot-${n}-1280x800.png`));
    expect([most, confirming, tiles[0]]).toEqual([3, "", "https://lh3.example/old"]);
    expect(run.filled).toEqual(["Screenshots: removed 3 copies of the listing's own files so they go back in order", ...attached.map((name) => `Screenshots: ${name}`)]);
    expect(run.rows.map((row) => row.line)).toEqual(["Screenshots on Store listing: Screenshot 1 on the page is not one of the listing's files, so it stays; remove it yourself if it is outdated"]);
  });

  it("1247: cancels a Remove Image confirmation left open at the start and stops at any other dialog", async () => {
    for (const [text, cancel, outcome] of [["Remove Image Are you sure you want to remove this image? This cannot be undone. Cancel Remove", { x: 3, y: 3 }, "moved"], ["Discard changes? Cancel Discard", null, "stopped"]] as const) {
      const fake = fakePage({ dialog: text, itemId: "abcdefghijklmnopabcdefghijklmnop" }, { cancel });
      const run = newRun("ws/p", await planned(), 0);

      run.itemId = "abcdefghijklmnopabcdefghijklmnop";

      expect(await chromeStep(run, stepDeps(fake.page))).toBe(outcome);
      expect(fake.clicks).toBe(cancel ? 1 : 0);
      expect(cancel ? run.line : run.stopped).toMatch(cancel ? /^Canceled a Remove Image confirmation left open/ : /^The dashboard shows a dialog: "Discard changes\? Cancel Discard"/);
    }
  });

  it("1260: confirms the Remove Image dialog beside Chrome's open nav drawer, read as the page renders it, and nothing else", () => {
    const rules = new Function(`return ${DIALOG_RULES}`)()(CHROME_SELECTORS.removeImageDialog) as { live: (d: DialogFacts) => boolean; pick: (all: DialogFacts[], which: string) => number };
    const drawer: DialogFacts = { modal: "false", text: "", buttons: ["Items", "Settings", "Profile", "Notifications"] };
    const confirm: DialogFacts = { modal: "true", text: "Remove Image Are you sure you want to remove this image? This cannot be undone. Cancel Remove", buttons: ["Cancel", "Remove"] };
    const discard: DialogFacts = { modal: "true", text: "Discard changes? Cancel Discard", buttons: ["Cancel", "Discard"] };

    expect(CHROME_SELECTORS.removeImageDialog.test("Remove ImageAre you sure you want to remove this image? This cannot be undone.")).toBe(true);
    expect(rules.live(drawer)).toBe(false);
    expect([rules.pick([drawer, confirm], "remove"), rules.pick([confirm, drawer], "remove"), rules.pick([drawer, confirm], "cancel")]).toEqual([1, 0, 1]);
    expect([rules.pick([drawer, confirm, { ...confirm }], "remove"), rules.pick([drawer, confirm, { ...confirm }], "cancel")]).toEqual([-1, 2]);
    expect([rules.pick([drawer, discard], "cancel"), rules.pick([confirm, discard], "remove"), rules.pick([drawer], "cancel"), rules.pick([{ ...confirm, buttons: ["Remove"] }], "remove")]).toEqual([-1, -1, -1, -1]);
  });

  it("1259: waits for a newly opened dashboard to render before filling, then names a page that never does", async () => {
    let now = 0;
    const fake = fakePage({ itemId: "abcdefghijklmnopabcdefghijklmnop", path: "/u/1/webstore/devconsole/pub-1/abcdefghijklmnopabcdefghijklmnop/edit", rendered: false });
    const run = newRun("ws/p", await planned(), now);
    const deps = { page: fake.page, sleep: async () => undefined, now: () => now };

    run.itemId = "abcdefghijklmnopabcdefghijklmnop";

    expect(await chromeStep(run, deps)).toBe("wait");
    now = RENDER_WAIT_MS;
    expect(await chromeStep(run, deps)).toBe("wait");
    expect(run.line).toMatch(/^Waiting for the Chrome Web Store dashboard to finish loading/);
    now = RENDER_WAIT_MS + 1;
    expect(await chromeStep(run, deps)).toBe("stopped");
    expect(run.stopped).toMatch(/^The Chrome Web Store dashboard never rendered at \/u\/1\/webstore\/devconsole\/pub-1\/abcdefghijklmnopabcdefghijklmnop\/edit: after 60 seconds/);
    expect(fake.calls.map((call) => call.method)).toEqual(["where", "where", "where"]);
    expect(fake.clicks).toBe(0);
  });

  it("1261: asks on Privacy only for the remote code and data usage answers the page shows and has not already ticked", async () => {
    const asked = sheet();

    (asked.pages[1]!.answers as unknown[]).push({ id: "chrome.remote_code", label: "Remote code", kind: "owner-certifies" });

    const plan = await chromePlan(asked, async (url) => ({ ok: true, bytes: served[url]! }), tmp);
    const cases: Array<[PrivacyAsks | null, string[], string[]]> = [
      [{ remoteCode: false, dataUsage: true, certified: 3, certifications: 3, types: ["Authentication information"] }, ["Data usage certifications: already answered on the page (3 certifications ticked; data types Authentication information); change them on Privacy if STORE.md says otherwise", "Remote code: Chrome does not ask about remote code for this item, so there is nothing to answer"], []],
      [{ remoteCode: true, dataUsage: true, certified: 2, certifications: 3, types: [] }, [], ["Data usage certifications", "Remote code"]],
      [null, [], ["Data usage certifications", "Remote code"]],
    ];

    for (const [asks, filled, rows] of cases) {
      const run = newRun("ws/p", plan, 0);
      const base = fakePage({ itemId: "abcdefghijklmnopabcdefghijklmnop", tab: "privacy" }, { save: { ok: true, label: "Save draft", x: 1, y: 1 } });
      const page: ChromePage = { ...base.page, call: async <T>(method: string, ...args: unknown[]) => (method === "privacyAsks" ? (asks as T) : method === "justify" ? ([] as T) : base.page.call<T>(method, ...args)) };

      Object.assign(run, { itemId: "abcdefghijklmnopabcdefghijklmnop", publisherId: "pub-1", done: ["listing"] });

      expect(await chromeStep(run, stepDeps(page))).toBe("moved");
      expect(run.filled.filter((line) => /^(?:Remote code|Data usage)/.test(line))).toEqual(filled);
      expect(run.rows.map((row) => row.line.split(" on Privacy")[0]).filter((line) => /^(?:Remote code|Data usage)/.test(line!))).toEqual(rows);
    }
  });

  it("1258: the page script the fill injects parses, so the dashboard never refuses it", () => {
    expect(() => new vm.Script(CHROME_PAGE_AGENT)).not.toThrow();
  });

  it("1258: after the default language, picks each STORE.md language, fills its description and screenshots, saves the draft and names a language the package does not ship", async () => {
    const base = await planned();
    const local = chromeLocalesOf(translatedProject(), base.dir);
    const plan = { ...base, locales: local.locales };

    expect(local.locales.map((row) => [row.locale, row.description, row.screenshots.map((file) => file.name)])).toEqual([["pt-BR", "Esconde dados pessoais.", ["pt-BR-1.png"]], ["de", "Verbirgt persönliche Daten.", []]]);
    expect(local.notes).toEqual(["pt-BR/2.png is 1400x800, and Chrome takes screenshots at 1280x800 or 640x400"]);

    let tab = "listing";
    let language = "English (United States)";
    let slot = "";
    const thumbs: Record<string, number> = {};
    const typed: Array<[string, string]> = [];
    const saves: string[] = [];
    const item = "abcdefghijklmnopabcdefghijklmnop";
    const fake: ChromePage = {
      call: async <T>(method: string, ...args: unknown[]) => {
        if (method === "where") return { host: "chrome.google.com", path: `/webstore/devconsole/pub-1/${item}/edit`, signIn: false, dashboard: true, publisherId: "pub-1", itemId: item, tab, dialog: null, dialogTakesZip: false } as T;
        if (method === "languagePicker") return { state: "picker", value: language } as T;

        if (method === "pickLanguage") {
          if (args[0] !== "Portuguese (Brazil)") return { outcome: "no-option" } as T;

          language = "Portuguese (Brazil)";

          return { outcome: "filled" } as T;
        }

        if (method === "setText") {
          typed.push([language, String(args[1])]);

          return "filled" as T;
        }

        if (method === "thumbs") return (thumbs[`${language}/${String(args[0])}`] ?? 0) as T;
        if (method === "fieldRead") return { found: true, value: "English (United States)" } as T;
        if (method === "visibility") return { read: "unlisted", offers: {} } as T;
        if (method === "justify") return [] as T;

        if (method === "gate") {
          if (args[0] === "save") saves.push(language);
          if (String(args[0]).startsWith("tab:")) tab = String(args[0]).slice(4);

          return { ok: true, label: "Save draft", x: 1, y: 1 } as T;
        }

        return null as T;
      },
      handle: async (_method, ...args) => {
        slot = String(args[0]);

        return "input-1";
      },
      setFiles: async () => void (thumbs[`${language}/${slot}`] = (thumbs[`${language}/${slot}`] ?? 0) + 1),
      click: async () => undefined,
      type: async () => undefined,
      navigate: async () => undefined,
    };
    const run = newRun("ws/p", plan, 0);

    Object.assign(run, { itemId: item, publisherId: "pub-1" });

    for (let i = 0; i < 12 && !run.finished && !run.stopped; i += 1) await chromeStep(run, stepDeps(fake));

    expect(run).toMatchObject({ finished: true, stopped: "", done: ["listing", "privacy", "distribution"], defaultLanguage: "English (United States)" });
    expect(typed).toEqual([["English (United States)", "Fills store pages."], ["Portuguese (Brazil)", "Esconde dados pessoais."]]);
    expect(saves).toEqual(["English (United States)", "Portuguese (Brazil)", "Portuguese (Brazil)", "Portuguese (Brazil)"]);
    expect(run.languages.map((row) => row.line)).toEqual([
      "pt-BR (Portuguese (Brazil)): Description, Screenshots: pt-BR-1.png saved as a draft",
      expect.stringMatching(/^de on Store listing: the language picker offers no German \(the list has no option reading "German"\); Chrome lists only the languages the package ships, so add _locales\/de\/messages\.json, upload a new package and run the fill again$/),
    ]);

    expect(openRows(run, { listing: "complete" })).toContain(run.languages[1]!.line);

    const single = newRun("ws/p", plan, 0);
    const all: ChromePage = { ...fake, call: async <T>(method: string, ...args: unknown[]) => (method === "languagePicker" ? ({ state: "all" } as T) : fake.call<T>(method, ...args)) };

    Object.assign(single, { itemId: item, publisherId: "pub-1", done: ["listing"] });
    tab = "listing";

    expect(await chromeStep(single, stepDeps(all))).toBe("moved");
    expect(single.languages.map((row) => row.line)).toEqual(["pt-BR", "de"].map((tag) => `${tag} on Store listing: Chrome shows this item's listing "For all languages", so the package it holds ships one language; Chrome adds ${tag} only from _locales/${tag.replace("-", "_")}/messages.json in the package, so add it, upload a new package and run the fill again`));

    const over = newRun("ws/p", plan, 0);

    Object.assign(over, { itemId: item, publisherId: "pub-1" });
    language = "Portuguese (Brazil)";
    tab = "listing";
    typed.length = 0;

    expect(await chromeStep(over, stepDeps(fake))).toBe("stopped");
    expect(over.stopped).toMatch(/^Store listing shows the pt-BR listing \("Portuguese \(Brazil\)"\), not the default language's, so the default description is not typed over it/);
    expect(typed).toEqual([]);
  });

  it("1262: drops a checklist line once the dashboard marks its tab complete and always ends on the approval-gated publish call, never a hand press", async () => {
    const run = newRun("ws/p", await planned(), 0);

    run.rows = [
      { tab: "privacy", line: "Data usage certifications on Privacy: yours to answer" },
      { tab: "listing", line: "Category on Store listing: choose Developer Tools yourself" },
    ];

    const publish = 'Submit for review: extension_approvals_request {act: "extension_submit", args: {action: "publish", project: "ws/p", browsers: ["chrome"]}} asks a workspace owner to approve it on extension.dev, and extension_submit with the same arguments and that approvalId sends this saved draft to Chrome\'s review through the Chrome Web Store API under the project\'s saved Chrome mode, then reads the review state back; nothing is pressed on the page';

    expect(openRows(run, { privacy: "incomplete" })).toEqual([...run.rows.map((row) => row.line), publish]);
    expect(openRows(run, { privacy: "complete", listing: "unknown" })).toEqual(["Category on Store listing: choose Developer Tools yourself", publish]);

    run.created = true;

    expect(openRows(run, {}).slice(-1)[0]).toMatch(/^Submit for review: this item was made in the dashboard, so the platform holds no draft record of it to send yet; extension_approvals_request \{act: "extension_submit", args: \{action: "submit", project: "ws\/p", browsers: \["chrome"\], buildSha: "<the build's sha>"\}\}/);
  });
});

describe("the guided Chrome first listing answer", () => {
  it("opens the dashboard in a Chromium window even when Firefox was used last, a second call reads the run instead of opening again, a read after it stopped or finished changes nothing, and replace: true or a sync-listing refill starts a fresh one", async () => {
    const launches: LaunchPlan[] = [];
    const read: string[] = [];
    const deps: ChromeListingDeps = {
      plan: async (slug) => {
        read.push(slug);

        return { plan: await planned() };
      },
      watch: (args) => watchChromeListing({ ...args, minutes: 0, proc: { table: () => null, list: () => "", signal: () => false, wait: () => undefined, platform: "darwin" } }),
    };

    expect(await guideChromeListing(sheetAnswer("first-submission-to-do", "edge"), {}, runtime(launches, tmp), deps)).toBeNull();
    expect(await guideChromeListing(sheetAnswer("first-submission-done"), {}, runtime(launches, tmp), deps)).toBeNull();

    const out = JSON.parse((await guideChromeListing(sheetAnswer("first-submission-to-do"), {}, runtime(launches, tmp), deps))!);

    expect(launches.map((plan) => [plan.choice.browser, plan.url])).toEqual([["chromium", DASHBOARD_HOME]]);
    expect(out).toMatchObject({ status: "first-listing-guided", value: { opened: true, landedOn: DASHBOARD_HOME, guidedBrowser: { browser: "chromium" }, nextStep: { kind: "dashboard", url: DASHBOARD_HOME } } });
    expect(out.value).not.toHaveProperty("openPages");
    expect(out.value.sayToPerson).toContain(SIGN_IN_LINE);
    expect(out.value.sayToPerson).toContain("presses \"New item\" once");
    expect(out.value.sayToPerson).toContain("Submit for review is one approval-gated extension_submit publish call afterwards");

    const again = JSON.parse((await guideChromeListing(sheetAnswer("first-submission-to-do"), {}, runtime(launches, tmp), deps))!);

    expect(launches).toHaveLength(1);
    expect(read).toEqual(["extensiondev/extension-dev-tools"]);
    expect(again.hint).toMatch(/^The guided window already runs this Chrome listing/);
    expect(again.value.progress).toMatchObject({ itemId: null, created: false, done: [] });

    const stopped = liveRun("extensiondev/extension-dev-tools")!;

    stopped.stopped = "\"Save draft\" was not pressed on Store listing. Nothing else was pressed.";

    const read2 = JSON.parse((await guideChromeListing(sheetAnswer("first-submission-to-do"), {}, runtime(launches, tmp), deps))!);

    expect(launches).toHaveLength(1);
    expect(read2.hint).toMatch(/^The guided Chrome run stopped and this read changed nothing: "Save draft" was not pressed on Store listing\. Nothing else was pressed\. Once the cause is fixed on the page, call extension_submit \{action: "first-submission", store: "chrome", project: "extensiondev\/extension-dev-tools", replace: true\}/);
    expect(liveRun("extensiondev/extension-dev-tools")).toBe(stopped);

    const fresh = JSON.parse((await guideChromeListing(sheetAnswer("first-submission-to-do"), { replace: true }, runtime(launches, tmp), deps))!);

    expect(launches).toHaveLength(2);
    expect(read).toHaveLength(2);
    expect(fresh.hint).toMatch(/^The earlier run had stopped \("Save draft" was not pressed on Store listing\. Nothing else was pressed\.\); a fresh fill started in the same window/);
    expect(fresh.value.progress).not.toHaveProperty("stopped");
    expect(liveRun("extensiondev/extension-dev-tools")).not.toBe(stopped);

    const finished = liveRun("extensiondev/extension-dev-tools")!;

    finished.finished = true;

    const after = JSON.parse((await guideChromeListing(sheetAnswer("first-submission-to-do"), {}, runtime(launches, tmp), deps))!);

    expect(launches).toHaveLength(2);
    expect(after.value.nextStep).toMatchObject({ kind: "publish", say: expect.stringMatching(/^Submit for review: extension_approvals_request \{act: "extension_submit", args: \{action: "publish", project: "extensiondev\/extension-dev-tools", browsers: \["chrome"\]\}\}/) });
    expect(after.hint).toMatch(/^The guided Chrome run finished and this read changed nothing\. To send the saved draft to review, extension_approvals_request \{act: "extension_submit", args: \{action: "publish"/);
    expect(after.hint).toMatch(/\. To fill the dashboard again from the listing as it is now \(for example after sync-listing changed it\), call extension_submit \{action: "first-submission", store: "chrome", project: "extensiondev\/extension-dev-tools", replace: true\}/);

    for (const args of [{ replace: true }, { refill: true }]) {
      const done = liveRun("extensiondev/extension-dev-tools")!;

      done.finished = true;

      const refilled = JSON.parse((await guideChromeListing(sheetAnswer("first-submission-to-do"), args, runtime(launches, tmp), deps))!);

      expect(refilled.hint).toMatch(/^The earlier run had finished; a fresh fill started in the same window and profile from the listing as it is now/);
      expect(liveRun("extensiondev/extension-dev-tools")).not.toBe(done);
    }

    expect(launches).toHaveLength(4);
  });

  it("1239: fills the update of an item Chrome already serves, from a published sheet or the lane's already-live refusal, and leaves Distribution alone", async () => {
    const launches: LaunchPlan[] = [];
    const watched: ChromePlan[] = [];
    const live = { state: "done", read: { word: "published", storeWord: "PUBLISHED", readAt: "2026-11-26T10:40:46.456Z", source: "poll" }, dashboardUrl: "https://chrome.google.com/webstore/devconsole/pub1/abcdefghijklmnopabcdefghijklmnop/edit" };
    const deps: ChromeListingDeps = {
      plan: async () => ({ plan: await chromePlan(sheet(live), async (url) => ({ ok: true, bytes: served[url]! }), tmp) }),
      watch: (args) => {
        watched.push(args.plan);

        return watchChromeListing({ ...args, minutes: 0, proc: { table: () => null, list: () => "", signal: () => false, wait: () => undefined, platform: "darwin" } });
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
