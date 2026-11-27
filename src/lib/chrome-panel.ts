// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import { stillSame, type ChromePlan, type PlanFile } from "./chrome-listing-plan";
import { bundledToolsDir, readBundleRecord, treeSha256 } from "./tools-extension";

export const PAGE_HOST_GLOBAL = "__extensionDevToolsPage";

export const PANEL_PAGE_SCRIPT = "scripts/store-panel-page.js";

export const DASHBOARD_HOME = "https://chrome.google.com/webstore/devconsole";

export const CHROME_TABS = ["listing", "privacy", "distribution", "test"] as const;

export type ChromeTab = (typeof CHROME_TABS)[number];

export type ChromeProgress = {
  running: boolean;
  publisherId: string;
  itemId: string;
  created: boolean;
  newPressed: boolean;
  pressedAt: number;
  zipSet: boolean;
  uploadPressed: boolean;
  itemSaved: boolean;
  authUser: number;
  opens: number;
  tried: string[];
  done: ChromeTab[];
  languages: Array<{ locale: string; line: string }>;
  filled: string[];
  missing: string[];
  finished: boolean;
};

export type ItemSave = (ids: { itemId: string; publisherId: string }) => Promise<{ ok: true } | { ok: false; message: string }>;

export type ChromeRun = {
  slug: string;
  title: string;
  plan: ChromePlan;
  progress: ChromeProgress;
  expiresAt: string;
  ended: boolean;
  saveError: string;
  files: Map<string, PlanFile>;
};

const ITEM_ID = /^[a-p]{32}$/;

const PUBLISHER_ID = /^[A-Za-z0-9_-]{1,80}$/;

const ITEM_PAGE = /^https:\/\/chrome\.google\.com\/(?:u\/\d+\/)?webstore\/devconsole\/([^/?#]+)\/([a-p]{32})(?:[/?#]|$)/i;

export const DASHBOARD_PAGE = /^https:\/\/chrome\.google\.com\/(?:u\/\d+\/)?webstore\/devconsole(?:[/?#]|$)/i;

export function itemUrl(item: { publisherId: string; itemId: string }): string {
  return `${DASHBOARD_HOME}/${item.publisherId}/${item.itemId}/edit`;
}

export function freshProgress(plan: Pick<ChromePlan, "item">): ChromeProgress {
  return {
    running: false,
    publisherId: plan.item?.publisherId ?? "",
    itemId: plan.item?.itemId ?? "",
    created: false,
    newPressed: false,
    pressedAt: 0,
    zipSet: false,
    uploadPressed: false,
    itemSaved: false,
    authUser: 0,
    opens: 0,
    tried: [],
    done: [],
    languages: [],
    filled: [],
    missing: [],
    finished: false,
  };
}

const shortList = (value: unknown, max = 60): string[] =>
  Array.isArray(value) ? [...new Set(value.filter((row): row is string => typeof row === "string").map((row) => row.replace(/\s+/g, " ").trim().slice(0, 600)).filter(Boolean))].slice(0, max) : [];

const small = (value: unknown, max: number): number | null => (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max ? value : null);

/* @invariant THE PROGRESS OF A CHROME FIRST LISTING ONLY MOVES FORWARD, AND
 * THE MCP KEEPS IT (MCP ledger 1277). The panel the MCP places on the
 * dashboard dies with every page load, so its progress lives here. "New
 * item" once recorded as pressed is never pressed again, an item id once
 * taken never changes, and every value the page sends is cut to plain text,
 * so no reload, second panel or page script turns the flow onto another item.
 */
export function mergeProgress(current: ChromeProgress, raw: unknown): ChromeProgress {
  const patch = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const next: ChromeProgress = { ...current };
  const itemId = typeof patch.itemId === "string" ? patch.itemId.toLowerCase() : "";

  if (typeof patch.running === "boolean") next.running = patch.running;

  if (!next.itemId && ITEM_ID.test(itemId) && typeof patch.publisherId === "string" && PUBLISHER_ID.test(patch.publisherId) && next.newPressed) {
    next.itemId = itemId;
    next.publisherId = patch.publisherId;
  }

  for (const key of ["created", "newPressed", "zipSet", "uploadPressed", "finished"] as const) if (patch[key] === true) next[key] = true;

  if (!next.pressedAt && small(patch.pressedAt, Number.MAX_SAFE_INTEGER)) next.pressedAt = patch.pressedAt as number;
  if (small(patch.authUser, 9) !== null) next.authUser = patch.authUser as number;
  if (small(patch.opens, 9) !== null) next.opens = patch.opens as number;
  if (patch.tried !== undefined) next.tried = shortList(patch.tried, 10);
  if (Array.isArray(patch.done)) next.done = CHROME_TABS.filter((tab) => next.done.includes(tab) || (patch.done as unknown[]).includes(tab));

  if (Array.isArray(patch.languages)) {
    for (const row of patch.languages) {
      const locale = row && typeof row === "object" ? String((row as Record<string, unknown>).locale ?? "").slice(0, 20) : "";
      const line = shortList([(row as Record<string, unknown>)?.line])[0] ?? "";

      if (locale && line && !next.languages.some((have) => have.locale === locale)) next.languages = [...next.languages, { locale, line }].slice(0, 50);
    }
  }

  if (patch.filled !== undefined) next.filled = shortList([...next.filled, ...shortList(patch.filled)]);
  if (patch.missing !== undefined) next.missing = shortList(patch.missing);

  return next;
}

/* @invariant THE PANEL THE MCP PLACES IS THE BUNDLED BUILD AND NOTHING ELSE.
 * The page script is read only from the tools build this package ships,
 * and only while every file of that build hashes to the digest its record
 * names, so no edited or swapped file is ever evaluated in the dashboard.
 */
export function panelSource(dir: string | null = bundledToolsDir()): string | null {
  if (!dir) return null;

  const record = readBundleRecord(dir) as { sha256?: Record<string, string> } | null;
  const root = path.join(dir, "chromium");
  const expected = record?.sha256?.chromium;

  try {
    if (!expected || treeSha256(root) !== expected) return null;

    return fs.readFileSync(path.join(root, PANEL_PAGE_SCRIPT), "utf8");
  } catch {
    return null;
  }
}

const fileRef = (run: ChromeRun, file: PlanFile, key: string) => {
  const url = `extension-dev-file:${key}`;

  run.files.set(url, file);

  return { url, name: file.name, sha256: file.sha256 };
};

export function newRun(args: { slug: string; plan: ChromePlan; expiresAt: string }): ChromeRun {
  return { slug: args.slug, title: `First Chrome Web Store listing for ${args.slug}`, plan: args.plan, progress: freshProgress(args.plan), expiresAt: args.expiresAt, ended: false, saveError: "", files: new Map() };
}

export function panelSession(run: ChromeRun): Record<string, unknown> {
  const { plan } = run;
  const [workspace = "", project = ""] = run.slug.split("/");

  return {
    kind: "first-submission",
    store: "chrome",
    storeName: "Chrome Web Store",
    project: { id: `project:${run.slug}`, name: project || workspace, slug: run.slug },
    title: run.title,
    expiresAt: run.expiresAt,
    guide: true,
    pages: [],
    ...(plan.pkg && plan.pkgBuild ? { package: { ...fileRef(run, plan.pkg, "package"), buildId: plan.pkgBuild } } : {}),
    chrome: {
      item: plan.item,
      fields: plan.fields,
      labels: plan.labels,
      justifications: plan.justifications,
      declarations: plan.declarations,
      visibility: plan.visibility,
      live: plan.live,
      account: plan.account,
      icon: plan.icon.map((file, at) => fileRef(run, file, `icon-${at}`)),
      screenshots: plan.screenshots.map((file, at) => fileRef(run, file, `shot-${at}`)),
      locales: plan.locales.map((row) => ({ locale: row.locale, description: row.description, from: row.from, folder: row.folder, screenshots: row.screenshots.map((file, at) => fileRef(run, file, `${row.locale}-${at}`)) })),
      left: plan.left,
    },
  };
}

const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".zip": "application/zip" };

export type PanelContext = { tabUrl: string; save?: ItemSave };

/* @invariant THE MCP ONLY ANSWERS THE PANEL, NEVER DRIVES THE PAGE (MCP
 * ledger 1277, Cezar's ruling of 2026-11-27). Each request the panel queued
 * gets the session, the progress, the bytes of a file the plan checked (its
 * SHA-256 read again first) or the item save; the save writes only an item
 * this run made, and only when the dashboard tab really shows that item.
 * Nothing here presses, types into, attaches to or navigates the page.
 */
export async function answerPanel(run: ChromeRun, message: unknown, context: PanelContext): Promise<unknown> {
  const body = message && typeof message === "object" ? (message as Record<string, unknown>) : {};

  if (run.ended) return null;

  switch (body.type) {
    case "tools:panel":
      return DASHBOARD_PAGE.test(String(body.url ?? "")) ? panelSession(run) : null;
    case "tools:listing":
      return run.progress;
    case "tools:listing-update":
      run.progress = mergeProgress(run.progress, body.patch);

      return run.progress;

    case "tools:file": {
      const file = run.files.get(String(body.url ?? ""));

      if (!file) return { ok: false, message: "the file is not one the MCP checked for this listing" };
      if (!stillSame(file)) return { ok: false, message: `${file.name} changed on disk after its check, so it was not handed over` };

      const bytes = fs.readFileSync(file.path);

      return { ok: true, base64: bytes.toString("base64"), type: IMAGE_TYPES[path.extname(file.name).toLowerCase()] ?? "application/octet-stream", sha256: file.sha256, bytes: bytes.length };
    }

    case "tools:product": {
      const { progress } = run;
      const shown = ITEM_PAGE.exec(context.tabUrl);

      if (!progress.created || !progress.itemId) return { ok: false, message: "This run made no item, so nothing is saved." };
      if (!shown || shown[2]!.toLowerCase() !== progress.itemId || shown[1] !== progress.publisherId) return { ok: false, message: "The dashboard tab does not show the item this run made, so it was not saved." };
      if (progress.itemSaved) return { ok: true, connectedAs: "" };
      if (!context.save) return { ok: false, message: "No platform save is wired for this run." };

      const saved = await context.save({ itemId: progress.itemId, publisherId: progress.publisherId }).catch((err: unknown) => ({ ok: false as const, message: err instanceof Error ? err.message : String(err) }));

      if (saved.ok) run.progress = { ...run.progress, itemSaved: true };

      run.saveError = saved.ok ? "" : saved.message;

      return saved.ok ? { ok: true, connectedAs: "" } : { ok: false, message: saved.message };
    }

    case "tools:cancel":
    case "tools:end":
      run.ended = true;

      return { ok: true };
    default:
      return null;
  }
}

export type PanelPage = { evaluate<T>(expression: string): Promise<T> };

const hostCall = (method: string, args: unknown[] = []) => `globalThis.${PAGE_HOST_GLOBAL}.${method}(${args.map((arg) => JSON.stringify(arg)).join(", ")})`;

const GUARD = `(() => location.host === "chrome.google.com" && !Array.from(document.querySelectorAll("input[type=password]")).some((el) => el.offsetParent !== null))()`;

/* @invariant THE PANEL GOES ONLY INTO A DASHBOARD TAB OF THE MCP'S OWN
 * GUIDED WINDOW, NEVER A SIGN-IN. It is placed only on a
 * chrome.google.com developer dashboard address that shows no password
 * field, once per page load, and the tick then only takes the panel's
 * requests and answers them by id.
 */
export async function panelTick(run: ChromeRun, page: PanelPage, context: PanelContext & { source: string }): Promise<boolean> {
  if (!DASHBOARD_PAGE.test(context.tabUrl)) return false;

  const placed = await page.evaluate<boolean>(`typeof globalThis.${PAGE_HOST_GLOBAL} === "object"`);

  if (!placed) {
    if (run.ended || !(await page.evaluate<boolean>(GUARD))) return false;

    await page.evaluate(context.source);
  }

  const asked = (await page.evaluate<Array<{ id: number; message: unknown }> | null>(hostCall("take"))) ?? [];

  for (const row of asked.slice(0, 64)) {
    if (!Number.isInteger(row?.id)) continue;

    await page.evaluate(hostCall("answer", [row.id, await answerPanel(run, row.message, context)]));
  }

  if (run.ended) await page.evaluate(hostCall("push", [{ type: "tools:ended" }])).catch(() => 0);

  return true;
}

export function submitRow(run: Pick<ChromeRun, "slug" | "progress">): string {
  const publish = `extension_approvals_request {act: "extension_submit", args: {action: "publish", project: "${run.slug}", browsers: ["chrome"]}}`;

  if (run.progress.created) return `Submit for review: this item was made in the dashboard, so the platform holds no draft record of it to send yet; extension_approvals_request {act: "extension_submit", args: {action: "submit", project: "${run.slug}", browsers: ["chrome"], buildSha: "<the build's sha>"}} records the build as the item's draft once a workspace owner approves it, and then ${publish} sends it to review the same way`;

  return `Submit for review: ${publish} asks a workspace owner to approve it on extension.dev, and extension_submit with the same arguments and that approvalId sends this saved draft to Chrome's review through the Chrome Web Store API under the project's saved Chrome mode, then reads the review state back; nothing is pressed on the page`;
}
