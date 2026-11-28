// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";

import { CDPConnection } from "./cdp-connection";
import { chromeLocalesOf } from "./chrome-listing-languages";
import { chromePlan, type ChromePlan, type FetchBytes } from "./chrome-listing-plan";
import { clientProjectDir } from "./client-roots";
import { DASHBOARD_HOME, DASHBOARD_PAGE, itemUrl, newRun, panelSource, panelTick, submitRow, type ChromeRun, type ItemSave } from "./chrome-panel";
import { envelope } from "./envelope";
import { guidedEngine } from "./guided-browser";
import { guidedConnectRuntime, openGuided, readStoreAccount, type GuidedConnectRuntime } from "./guided-connect";
import { replacing } from "./guided-connect-account";
import { guidedProcess, launchFacts, launchWord, type GuidedProcess } from "./guided-window-end";
import { projectApiBytes } from "./project-api-bytes";
import { openProjectApi, projectApiGet, projectApiSend, type ProjectApi } from "./project-api";
import { readStoreSettingsChange } from "./store-settings";
import { isRow, text } from "./row";
import { chromeItemLive, listingFillable, nextStep } from "./store-connection";

type Args = Record<string, unknown>;

export const CHROME_LISTING_STATUS = "first-listing-guided";

export type CdpTarget = { type: string; url: string; webSocketDebuggerUrl: string };

export interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

export interface ChromeDriver {
  targets(port: number): Promise<CdpTarget[]>;
  open(wsUrl: string): Promise<CdpSession>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface ChromeListingDeps {
  plan(slug: string, api: string | undefined): Promise<{ plan: ChromePlan } | { refused: string }>;
  watch(args: { slug: string; plan: ChromePlan; profileDir: string; api: string | undefined }): ChromeRun | null;
}

const SIGN_IN_PAGE = /^https:\/\/accounts\.google\.com\//i;

export function debugPortOf(profileDir: string, proc: GuidedProcess = guidedProcess): number | null {
  if (proc.platform === "win32") return null;

  const flag = `--user-data-dir=${profileDir}`;
  const words = (proc.list() ?? "").split("\n").map((line) => line.trim().split(/\s+/)).find((row) => row.includes(flag) && row.some((word) => word.startsWith("--remote-debugging-port=")));
  const port = Number(words?.find((word) => word.startsWith("--remote-debugging-port="))?.split("=")[1] ?? 0);

  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null;
}

export function dashboardTarget(targets: readonly CdpTarget[]): CdpTarget | null {
  const pages = targets.filter((target) => target.type === "page");

  return pages.find((target) => DASHBOARD_PAGE.test(target.url)) ?? pages.find((target) => SIGN_IN_PAGE.test(target.url)) ?? null;
}

async function evaluated<T>(session: CdpSession, expression: string): Promise<T> {
  const answer = (await session.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })) as { result?: { value?: unknown }; exceptionDetails?: unknown };

  if (answer?.exceptionDetails) throw new Error("the dashboard page refused the panel script");

  return answer?.result?.value as T;
}

export const cdpChromeDriver: ChromeDriver = {
  targets: async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`);

    return res.ok ? ((await res.json()) as CdpTarget[]) : [];
  },
  open: async (wsUrl) => {
    const connection = new CDPConnection();

    await connection.connect(wsUrl);

    return { send: (method, params) => connection.sendCommand(method, params ?? {}), close: () => connection.disconnect() };
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/* @invariant ONE TICK RELAYS FOR ONE TAB OF THE MCP'S OWN GUIDED WINDOW, AND
 * PRESSES NOTHING (MCP ledger 1277). The debug port comes from the browser
 * running this very profile and the tab is its developer dashboard tab. The
 * only things the MCP sends that tab are Runtime.evaluate calls that place
 * the bundled tools panel and read or answer its queue; it sends no click,
 * no key, no file and no navigation, so every step on the page is the
 * panel's own, after the person's press. A Google sign-in tab is never
 * evaluated at all.
 */
export async function chromeTick(run: ChromeRun, args: { port: number; driver: ChromeDriver; source: string; save?: ItemSave }): Promise<string> {
  const target = dashboardTarget(await args.driver.targets(args.port));
  if (!target || !DASHBOARD_PAGE.test(target.url)) return "idle";

  const session = await args.driver.open(target.webSocketDebuggerUrl);

  try {
    const placed = await panelTick(run, { evaluate: (expression) => evaluated(session, expression) }, { tabUrl: target.url, source: args.source, ...(args.save ? { save: args.save } : {}) });

    return placed ? "relayed" : "idle";
  } finally {
    session.close();
  }
}

const runs = new Map<string, { run: ChromeRun; stop: () => void; profileDir: string }>();

export function liveRun(slug: string): ChromeRun | null {
  return runs.get(slug)?.run ?? null;
}

export function watchChromeListing(args: { slug: string; plan: ChromePlan; profileDir: string; save?: ItemSave; minutes?: number; driver?: ChromeDriver; proc?: GuidedProcess; source?: string | null }): ChromeRun | null {
  const source = args.source === undefined ? panelSource() : args.source;

  if (!source) return null;

  runs.get(args.slug)?.stop();

  const driver = args.driver ?? cdpChromeDriver;
  const until = driver.now() + (args.minutes ?? 60) * 60_000;
  const run = newRun({ slug: args.slug, plan: args.plan, expiresAt: new Date(until).toISOString() });
  let busy = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const stop = () => {
    if (timer) clearInterval(timer);
    if (runs.get(args.slug)?.run === run) runs.delete(args.slug);

    fs.rmSync(args.plan.dir, { recursive: true, force: true });
  };

  timer = setInterval(() => {
    if (driver.now() > until) return stop();
    if (busy) return;

    const port = debugPortOf(args.profileDir, args.proc);
    if (!port) return;

    busy = true;
    chromeTick(run, { port, driver, source, ...(args.save ? { save: args.save } : {}) })
      .catch(() => "idle")
      .then(() => {
        if (run.ended) stop();
      })
      .finally(() => {
        busy = false;
      });
  }, 1000);

  timer.unref?.();
  runs.set(args.slug, { run, stop, profileDir: args.profileDir });

  return run;
}

function artifactRoute(api: ProjectApi, url: string): string {
  const relative = url.replace(/^https?:\/\/[^/]+/i, "");
  const prefix = `/api/projects/${encodeURIComponent(api.projectId)}/`;

  return relative.startsWith(prefix) ? relative.slice(prefix.length) : "";
}

export async function platformPlan(slug: string, apiBase: string | undefined): Promise<{ plan: ChromePlan } | { refused: string }> {
  const opened = await openProjectApi({ command: "extension_submit", project: slug, api: apiBase });
  if (!opened.ok) return { refused: opened.message };

  const api = opened.api;
  const read = await projectApiGet<Record<string, unknown>>(api, "stores/chrome/first-submission?reviewer=1");
  if (!read.ok) return { refused: read.message };

  const pkg = isRow(read.json.package) ? read.json.package : null;
  const buildId = text(pkg?.buildId);

  const fetchBytes: FetchBytes = async (url, maxBytes) => {
    const route = pkg && url === text(pkg.url) && /^[0-9a-f]{7,40}$/i.test(buildId) ? `builds/${encodeURIComponent(buildId)}/artifacts/chrome.zip` : artifactRoute(api, url);

    if (!route) return { ok: false, message: "the file is not served by this project's platform routes" };

    const got = await projectApiBytes(api, route, { maxBytes });

    return got.ok ? { ok: true, bytes: got.bytes } : { ok: false, message: got.message };
  };

  const plan = await chromePlan(read.json, fetchBytes);

  if (plan.account) return { plan };

  const account = await readStoreAccount({ workspace: slug.split("/")[0] ?? "", store: "chrome", api: apiBase, fetchImpl: fetch }).catch(() => null);

  return { plan: { ...plan, account: account && "account" in account ? (account.account?.connectedAs ?? "") : "" } };
}

export function platformSave(slug: string, apiBase: string | undefined): ItemSave {
  return async (ids) => {
    const read = readStoreSettingsChange("chrome", { chromeItemId: ids.itemId, publisherId: ids.publisherId });
    if (!("patch" in read)) return { ok: false, message: "problem" in read ? read.problem : "the ids were not read as Chrome store settings" };

    const opened = await openProjectApi({ command: "extension_submit", project: slug, api: apiBase });
    if (!opened.ok) return { ok: false, message: opened.message };

    const sent = await projectApiSend(opened.api, "PUT", "stores/config", { chrome: read.patch });

    return sent.ok ? { ok: true } : { ok: false, message: sent.message };
  };
}

export const chromeListingDeps: ChromeListingDeps = {
  plan: platformPlan,
  watch: (args) => watchChromeListing({ ...args, save: platformSave(args.slug, args.api) }),
};

function chromeOnly(runtime: GuidedConnectRuntime): GuidedConnectRuntime {
  return {
    ...runtime,
    probe: () => {
      const probe = runtime.probe();

      return { ...probe, systemBinary: (browser) => (guidedEngine(browser) === "gecko" ? null : probe.systemBinary(browser)), managedBinary: (browser) => probe.managedBinary(browser), lastUsed: (app) => probe.lastUsed(app), defaultBrowser: () => probe.defaultBrowser() };
    },
  };
}

function languagesSaid(locales: string[]): string {
  if (!locales.length) return "";

  const list = locales.length > 1 ? `${locales.slice(0, -1).join(", ")} and ${locales[locales.length - 1]}` : locales[0]!;

  return ` After the default language it picks ${list} on Store listing's language picker and fills ${locales.length === 1 ? "that language's" : "each language's"} description and screenshots from STORE.md; a language the package does not ship is named, not typed.`;
}

export function signInLine(account: string): string {
  return account ? `Sign in as ${account}, the Google account that holds the Chrome Web Store item, in this window.` : "Sign in to the Chrome Web Store developer dashboard in this window.";
}

export function chromeListingSay(args: { label: string; itemId: string; slug: string; live?: boolean; account?: string; locales?: string[] }): string {
  const start = args.itemId ? `item ${args.itemId}` : "the dashboard home";
  const make = args.itemId ? "" : "presses \"New item\" once, attaches the platform's verified package after checking its SHA-256 and saves the new item on the project; it ";
  const distribution = args.live ? "and leaves Distribution as Chrome serves it" : "and Distribution (Unlisted, the least public option)";

  return `The ${args.label} window opened on the Chrome Web Store developer dashboard (${start}) for ${args.slug}${args.live ? ", an item Chrome already serves" : ""}. ${signInLine(args.account ?? "")} The extension.dev tools panel then opens on the dashboard with its one button; the next step is to press ${args.itemId ? '"Fill the Chrome listing"' : '"Create and fill the Chrome listing"'} in the panel, and the panel ${make}fills Store listing and Privacy from the listing on extension.dev ${distribution}, pressing only "Save draft" on each tab.${languagesSaid(args.locales ?? [])} It ends with a checklist: certifications are yours, and Submit for review is one approval-gated extension_submit publish call afterwards, through the Chrome Web Store API.`;
}

function progressOf(run: ChromeRun): Record<string, unknown> {
  const { progress } = run;

  return {
    itemId: progress.itemId || null,
    publisherId: progress.publisherId || null,
    created: progress.created,
    ...(progress.created ? { itemSaved: progress.itemSaved ? true : run.saveError || "saving" } : {}),
    running: progress.running,
    finished: progress.finished,
    done: progress.done,
    filled: progress.filled,
    ...(run.plan.locales.length ? { languages: run.plan.locales.map((row) => progress.languages.find((done) => done.locale === row.locale)?.line ?? `${row.locale}: waiting for the default language's Store listing to be saved`) } : {}),
    checklist: progress.missing,
    notes: run.plan.notes,
  };
}

function lineOf(run: ChromeRun): string {
  if (run.progress.finished) return "The Chrome draft is filled and saved, and it stays a draft; the panel's checklist names what is left.";
  if (run.progress.running) return "The panel on the dashboard is filling the listing.";

  return "The panel on the dashboard waits for the person's press on its button.";
}

function saveItemStep(run: ChromeRun, slug: string): string {
  const { progress } = run;

  return progress.created && progress.itemId && !progress.itemSaved && run.saveError ? ` The new item was not saved on the project (${run.saveError}); call extension_submit {action: "configure-store", store: "chrome", project: "${slug}", storeSettings: {chromeItemId: "${progress.itemId}", publisherId: "${progress.publisherId}"}}.` : "";
}

/* @invariant A FIRST CHROME LISTING IS FILLED BY THE SHARED TOOLS PANEL,
 * WHICH THE MCP PLACES IN ITS GUIDED WINDOW, AND ENDS AS A DRAFT (MCP ledger
 * 1277). Chrome runs no extension on the Chrome Web Store, so the MCP reads
 * the project's first-submission sheet and its verified files with the
 * login's own token, opens the dashboard in a Chromium guided window, places
 * the bundled panel there and answers its requests; the person presses the
 * panel's button and the panel does the steps. A second call while the run
 * lives reports its progress instead of opening another window.
 */
export async function guideChromeListing(result: string, args: Args, runtime: GuidedConnectRuntime = guidedConnectRuntime, deps: ChromeListingDeps = chromeListingDeps): Promise<string | null> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(result);
  } catch {
    return null;
  }

  if (!isRow(parsed) || !isRow(parsed.value)) return null;

  const value = parsed.value;
  const status = text(parsed.status);
  const slug = text(value.project);
  const [workspace = "", project = ""] = slug.split("/");

  if (value.action !== "first-submission" || value.store !== "chrome" || !workspace || !project) return null;
  if (!listingFillable("chrome", status, value)) return null;

  const updating = chromeItemLive(status, value);

  const command = text(parsed.command) || "extension_submit";
  const kept = Object.fromEntries(Object.entries(value).filter(([key]) => !["opened", "openedNote", "openPages", "nextStep", "sayToPerson"].includes(key)));
  const prior = liveRun(slug);
  const restart = Boolean(prior && !prior.progress.running) && (replacing(args) || args.refill === true);
  const live = prior && !restart ? prior : null;
  const restarted = !restart ? "" : "The earlier panel run was replaced; a fresh panel run started in the same window and profile from the listing as it is now, keeping its sign-in.";

  if (live) {
    const say = lineOf(live);
    const again = `extension_submit {action: "first-submission", store: "chrome", project: "${slug}", replace: true}`;
    const hint = live.progress.finished
      ? `The guided Chrome run finished and this read changed nothing. To send the saved draft to review, ${submitRow(live).replace(/^Submit for review: /, "")}. To fill the dashboard again from the listing as it is now (for example after sync-listing changed it), call ${again}.`
      : `The guided window already holds the tools panel for this Chrome listing; nothing new was opened. ${live.progress.running ? "" : `If the panel stopped, the person presses Continue on it; ${again} starts a fresh run.`}`.trim();

    return envelope({
      ok: true,
      command,
      status: CHROME_LISTING_STATUS,
      value: { ...kept, opened: true, progress: progressOf(live), sayToPerson: say, nextStep: live.progress.finished ? nextStep("publish", submitRow(live)) : nextStep("dashboard", say, live.progress.itemId ? itemUrl(live.progress) : DASHBOARD_HOME) },
      hint: `${hint}${saveItemStep(live, slug)}`,
    });
  }

  const planned = await deps.plan(slug, text(args.api) || undefined);

  if ("refused" in planned) {
    const note = `No guided window was opened, since the first-submission sheet could not be read: ${planned.refused}`;

    return envelope({ ok: true, command, status, value: { ...kept, opened: false, guidedBrowser: { opened: false, note } }, hint: [note, text(parsed.hint)].filter(Boolean).join(" ") });
  }

  const localDir = text(args.projectPath) || clientProjectDir() || "";
  const local = chromeLocalesOf(localDir, planned.plan.dir);
  const plan = { ...planned.plan, live: planned.plan.live || updating, locales: local.locales, notes: [...planned.plan.notes, ...local.notes] };
  const start = plan.item ? itemUrl(plan.item) : DASHBOARD_HOME;
  const opened = await openGuided({ workspace, next: null, plainUrl: start, storePage: null, api: text(args.api) || undefined, runtime: chromeOnly(runtime) });

  if ("install" in opened || !opened.opened) {
    fs.rmSync(plan.dir, { recursive: true, force: true });

    const note = "install" in opened
      ? `No guided window was opened: ${opened.install.why} It is not installed; install it with extension_browsers_install {action: "install", browser: "${opened.install.install}"}, then call this again.`
      : `No guided window was opened, so nothing on the Chrome Web Store was filled: ${opened.note.replace(/^No (?:browser was opened|window is showing): /, "")}`;

    return envelope({ ok: true, command, status, value: { ...kept, opened: false, guidedBrowser: { opened: false, note } }, hint: [note, text(parsed.hint)].filter(Boolean).join(" ") });
  }

  const run = deps.watch({ slug, plan, profileDir: opened.profileDir, api: text(args.api) || undefined });

  if (!run) {
    fs.rmSync(plan.dir, { recursive: true, force: true });

    const note = "The guided window opened, but this MCP holds no verified copy of the extension.dev tools panel, so nothing was placed on the dashboard; update @extension.dev/mcp, then call this again.";

    return envelope({ ok: true, command, status, value: { ...kept, opened: true, guidedBrowser: { opened: true, browser: opened.choice.browser, note } }, hint: [note, text(parsed.hint)].filter(Boolean).join(" ") });
  }

  const say = chromeListingSay({ label: opened.label, itemId: plan.item?.itemId ?? "", slug, live: plan.live, account: plan.account, locales: plan.locales.map((row) => row.locale) });

  return envelope({
    ok: true,
    command,
    status: CHROME_LISTING_STATUS,
    value: {
      ...kept,
      opened: true,
      guidedBrowser: { opened: true, browser: opened.choice.browser, why: opened.choice.why, profile: opened.profileDir, reused: opened.launched.reused, ...launchFacts(opened.launched) },
      landedOn: start,
      progress: progressOf(run),
      sayToPerson: say,
      nextStep: nextStep("dashboard", say, start),
    },
    hint: [
      restarted,
      `${launchWord(opened.launched)} ${opened.choice.why} Profile: ${opened.profileDir}.`,
      plan.notes.length ? `Left out: ${plan.notes.join("; ")}.` : "",
      `Tell the person: "${say}" Call extension_submit {action: "first-submission", store: "chrome", project: "${slug}"} again to read the run's progress and checklist; a new item is saved on the project by itself, as its Edge product is. The MCP only places the panel and answers it; it presses nothing on the page.`,
    ].filter(Boolean).join(" "),
  });
}
