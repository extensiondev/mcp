// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";

import { CDPConnection } from "./cdp-connection";
import { AGENT_GLOBAL, CHROME_PAGE_AGENT, DASHBOARD_HOME } from "./chrome-dashboard-agent";
import { chromePlan, type ChromePlan, type FetchBytes } from "./chrome-listing-plan";
import { chromeStep, itemUrl, newRun, openRows, saveNewItem, signInLine, type ChromePage, type ChromeRun, type ItemSave } from "./chrome-listing-run";
import { envelope } from "./envelope";
import { guidedEngine } from "./guided-browser";
import { guidedConnectRuntime, openGuided, readStoreAccount, type GuidedConnectRuntime } from "./guided-connect";
import { replacing } from "./guided-connect-account";
import { guidedProcess, launchWord, type GuidedProcess } from "./guided-window-end";
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
  image?(url: string): Promise<Buffer | null>;
}

const STORE_IMAGE_HOST = /^https:\/\/lh\d\.googleusercontent\.com\//i;
const STORE_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

export async function storeImage(url: string, fetchImpl: typeof fetch = fetch): Promise<Buffer | null> {
  if (!STORE_IMAGE_HOST.test(url)) return null;

  const res = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(15_000) }).catch(() => null);
  if (!res?.ok) return null;

  const bytes = Buffer.from(await res.arrayBuffer());

  return bytes.length <= STORE_IMAGE_MAX_BYTES ? bytes : null;
}

export interface ChromeListingDeps {
  plan(slug: string, api: string | undefined): Promise<{ plan: ChromePlan } | { refused: string }>;
  watch(args: { slug: string; plan: ChromePlan; profileDir: string; api: string | undefined }): ChromeRun;
}

const DASHBOARD_PAGE = /^https:\/\/chrome\.google\.com\/(?:u\/\d+\/)?webstore\/devconsole(?:[/?#]|$)/i;
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

  if (answer?.exceptionDetails) throw new Error("the dashboard page refused the fill script");

  return answer?.result?.value as T;
}

const callOf = (method: string, args: unknown[]) => `globalThis.${AGENT_GLOBAL}.${method}(${args.map((arg) => JSON.stringify(arg)).join(", ")})`;

/* @invariant THE FILL NEVER RUNS ON A GOOGLE SIGN-IN PAGE. Chrome keeps
 * extensions off the Chrome Web Store, so this page script is the panel
 * there; it goes only into a chrome.google.com developer dashboard tab, and
 * on accounts.google.com only the address is read, so no sign-in field is
 * ever read, typed into or pressed.
 */
export function cdpPage(session: CdpSession, url: () => string): ChromePage {
  const ready = async () => {
    if (!DASHBOARD_PAGE.test(url())) return;

    await evaluated(session, CHROME_PAGE_AGENT);
  };

  return {
    call: async <T>(method: string, ...args: unknown[]): Promise<T> => {
      if (!DASHBOARD_PAGE.test(url())) return (method === "where" ? { host: "", path: "", signIn: SIGN_IN_PAGE.test(url()), dashboard: false, publisherId: "", itemId: "", tab: "", dialog: null, dialogTakesZip: false } : null) as T;

      await ready();

      return evaluated<T>(session, callOf(method, args));
    },
    handle: async (method, ...args) => {
      await ready();

      const answer = (await session.send("Runtime.evaluate", { expression: callOf(method, args), returnByValue: false })) as { result?: { objectId?: string; subtype?: string } };

      return answer?.result?.subtype === "node" ? (answer.result.objectId ?? null) : null;
    },
    setFiles: async (objectId, files) => {
      await session.send("DOM.setFileInputFiles", { files, objectId });
    },
    click: async (x, y) => {
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await session.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: type === "mouseMoved" ? 0 : 1 });
    },
    type: async (typed) => {
      await session.send("Input.insertText", { text: typed });
    },
    navigate: async (to) => {
      await session.send("Page.navigate", { url: to });
    },
  };
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
  image: (url) => storeImage(url),
};

/* @invariant ONE TICK READS ONE TAB OF THE MCP'S OWN GUIDED WINDOW. The
 * debug port comes from the browser running this very profile, the tab is
 * the developer dashboard (or the Google sign-in it sent the person to), and
 * nothing but the fill itself is written into that tab.
 */
export async function chromeTick(run: ChromeRun, args: { port: number; driver: ChromeDriver }): Promise<string> {
  const target = dashboardTarget(await args.driver.targets(args.port));
  if (!target) return "idle";

  const session = await args.driver.open(target.webSocketDebuggerUrl);
  let address = target.url;

  try {
    const page = cdpPage(session, () => address);
    const track: ChromePage = {
      ...page,
      navigate: async (to) => {
        await page.navigate(to);
        address = to;
      },
    };

    if (run.finished) {
      run.marks = (await page.call<Record<string, string>>("marks").catch(() => null)) ?? run.marks;

      return "checklist";
    }

    const outcome = await chromeStep(run, { page: track, sleep: args.driver.sleep, now: args.driver.now, ...(args.driver.image ? { image: (url: string) => args.driver.image!(url) } : {}) }).catch((err: unknown) => {
      run.line = `The dashboard tab changed under the fill (${err instanceof Error ? err.message : String(err)}); it tries again.`;

      return "retry";
    });

    return outcome;
  } finally {
    session.close();
  }
}

const runs = new Map<string, { run: ChromeRun; stop: () => void; profileDir: string }>();

export function liveRun(slug: string): ChromeRun | null {
  return runs.get(slug)?.run ?? null;
}

export function watchChromeListing(args: { slug: string; plan: ChromePlan; profileDir: string; save?: ItemSave; minutes?: number; driver?: ChromeDriver; proc?: GuidedProcess }): ChromeRun {
  runs.get(args.slug)?.stop();

  const driver = args.driver ?? cdpChromeDriver;
  const run = newRun(args.slug, args.plan, driver.now());
  const until = driver.now() + (args.minutes ?? 60) * 60_000;
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
    chromeTick(run, { port, driver })
      .catch(() => "idle")
      .then(() => (args.save ? saveNewItem(run, args.save) : undefined))
      .finally(() => {
        busy = false;
      });
  }, 1500);

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
  const read = await projectApiGet<Record<string, unknown>>(api, "stores/chrome/first-submission");
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

export function chromeListingSay(args: { label: string; itemId: string; slug: string; live?: boolean; account?: string }): string {
  const signIn = signInLine(args.account ?? "");

  const start = args.itemId ? `item ${args.itemId}` : "the dashboard home";

  if (args.live) {
    return `The ${args.label} window opened on the Chrome Web Store developer dashboard (${start}) for ${args.slug}, an item Chrome already serves. ${signIn} Then it fills the update's Store listing (description, category, language, homepage, icon and screenshots) and Privacy (single purpose, permission justifications, privacy policy) from the listing on extension.dev, pressing only "Save draft" on each, and leaves Distribution as Chrome serves it. It stops with a checklist: the remote code answer, when the page asks it, and any data usage certification not already ticked are yours, and Submit for review stays with you.`;
  }

  return `The ${args.label} window opened on the Chrome Web Store developer dashboard (${start}) for ${args.slug}. ${signIn} Then it ${args.itemId ? "" : "presses \"New item\" once and uploads the platform's verified package (its SHA-256 checked), which makes a draft item and saves its ID on the project; it "}fills Store listing (description, category, language, homepage, icon and screenshots), Privacy (single purpose, permission justifications, privacy policy) and Distribution (Unlisted, the least public option), pressing only "Save draft" on each. It stops with a checklist: the remote code answer, when the page asks it, and any data usage certification not already ticked are yours, and Submit for review stays with you.`;
}

function progressOf(run: ChromeRun): Record<string, unknown> {
  return {
    itemId: run.itemId || null,
    publisherId: run.publisherId || null,
    created: run.created,
    ...(run.created ? { itemSaved: run.itemSaved === "saved" ? true : run.itemSaved || "saving" } : {}),
    done: run.done,
    filled: run.filled,
    line: run.line,
    ...(run.stopped ? { stopped: run.stopped } : {}),
    checklist: run.finished ? openRows(run, run.marks) : run.rows.map((row) => row.line),
    notes: run.plan.notes,
  };
}

function saveItemStep(run: ChromeRun, slug: string): string {
  return run.created && run.itemId && run.itemSaved && run.itemSaved !== "saved" ? ` The new item was not saved on the project (${run.itemSaved}); call extension_submit {action: "configure-store", store: "chrome", project: "${slug}", storeSettings: {chromeItemId: "${run.itemId}", publisherId: "${run.publisherId}"}}.` : "";
}

/* @invariant A FIRST CHROME LISTING IS FILLED BY THE MCP OVER ITS GUIDED
 * WINDOW'S DEBUG PORT, AND ENDS AS A DRAFT. Chrome runs no extension on the
 * Chrome Web Store, so the tools panel cannot work there; the MCP reads the
 * project's first-submission sheet and its verified files with the login's
 * own token, opens the dashboard in a Chromium guided window, and drives it
 * step by step. A second call while the run lives reports its progress
 * instead of opening another window.
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
  const restart = Boolean(prior && (prior.stopped || prior.finished)) && (replacing(args) || args.refill === true);
  const live = prior && !restart ? prior : null;
  const restarted = !restart ? "" : prior!.stopped ? `The earlier run had stopped (${prior!.stopped}); a fresh fill started in the same window and profile, keeping its sign-in.` : "The earlier run had finished; a fresh fill started in the same window and profile from the listing as it is now, keeping its sign-in.";

  if (live) {
    const say = live.stopped ? live.line : live.finished ? `The Chrome draft is filled and saved. ${openRows(live, live.marks).join("; ")}.` : live.line;
    const again = `extension_submit {action: "first-submission", store: "chrome", project: "${slug}", replace: true}`;
    const hint = live.stopped
      ? `The guided Chrome run stopped and this read changed nothing: ${live.stopped} Once the cause is fixed on the page, call ${again} to start a fresh fill in the same window, keeping its sign-in.`
      : live.finished
        ? `The guided Chrome run finished and this read changed nothing. To fill the dashboard again from the listing as it is now (for example after sync-listing changed it), call ${again}.`
        : `The guided window already runs this Chrome listing; nothing new was opened.`;

    return envelope({
      ok: true,
      command,
      status: CHROME_LISTING_STATUS,
      value: { ...kept, opened: true, progress: progressOf(live), sayToPerson: say, nextStep: nextStep("dashboard", say, live.itemId ? itemUrl(live) : DASHBOARD_HOME) },
      hint: `${hint}${saveItemStep(live, slug)}`,
    });
  }

  const planned = await deps.plan(slug, text(args.api) || undefined);

  if ("refused" in planned) {
    const note = `No guided window was opened, since the first-submission sheet could not be read: ${planned.refused}`;

    return envelope({ ok: true, command, status, value: { ...kept, opened: false, guidedBrowser: { opened: false, note } }, hint: [note, text(parsed.hint)].filter(Boolean).join(" ") });
  }

  const plan = { ...planned.plan, live: planned.plan.live || updating };
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
  const say = chromeListingSay({ label: opened.label, itemId: plan.item?.itemId ?? "", slug, live: plan.live, account: plan.account });

  return envelope({
    ok: true,
    command,
    status: CHROME_LISTING_STATUS,
    value: {
      ...kept,
      opened: true,
      guidedBrowser: { opened: true, browser: opened.choice.browser, why: opened.choice.why, profile: opened.profileDir, reused: opened.launched.reused, ...(opened.launched.replaced ? { replaced: true } : {}) },
      landedOn: start,
      progress: progressOf(run),
      sayToPerson: say,
      nextStep: nextStep("dashboard", say, start),
    },
    hint: [
      restarted,
      `${launchWord(opened.launched)} ${opened.choice.why} Profile: ${opened.profileDir}.`,
      plan.notes.length ? `Left out: ${plan.notes.join("; ")}.` : "",
      `Tell the person: "${say}" Call extension_submit {action: "first-submission", store: "chrome", project: "${slug}"} again to read the run's progress and checklist; a new item is saved on the project by itself, as its Edge product is.`,
    ].filter(Boolean).join(" "),
  });
}
