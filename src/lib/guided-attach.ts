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

import { CDPConnection } from "./cdp-connection";
import { guidedProcess, type GuidedProcess } from "./guided-window-end";
import { isRow, text } from "./row";

export const ATTACH_SLOTS: Record<string, RegExp> = {
  "edge.store_logo": /extension logo|store logo/i,
  "edge.screenshots": /screenshot\/s|\bscreenshots\b/i,
};

export const RELAY_GLOBAL = "extensionDevToolsAttach";

const PARTNER_LISTING = /^https:\/\/partner\.microsoft\.com\/(?:[a-z]{2}-[a-z]{2}\/)?dashboard\/microsoftedge\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/listings(?:[/?#]|$)/i;
const FILE_NAME = /^[a-z0-9][a-z0-9._-]{0,100}\.png$/i;
const NONCE = /^[\w-]{8,64}$/;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 10;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type SlotResult = { attached: string[]; missing: string[]; note?: string };

export type CheckedSlot = { id: string; files: Array<{ name: string; bytes: Buffer }>; refused: string[] };

export type CheckedRequest = { nonce: string; url: string; slots: CheckedSlot[] };

export interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

export type CdpTarget = { type: string; url: string; webSocketDebuggerUrl: string };

export interface AttachDriver {
  targets(port: number): Promise<CdpTarget[]>;
  browser?(port: number): Promise<string | null>;
  open(wsUrl: string): Promise<CdpSession>;
  sleep(ms: number): Promise<void>;
}

export function unpackedExtensionId(dir: string): string {
  let real = dir;

  try {
    real = fs.realpathSync(dir);
  } catch {
  }

  const hex = crypto.createHash("sha256").update(real).digest("hex").slice(0, 32);

  return [...hex].map((digit) => String.fromCharCode(97 + parseInt(digit, 16))).join("");
}

export function debugPortOf(profileDir: string, proc: GuidedProcess = guidedProcess): number | null {
  if (proc.platform === "win32") return null;

  const flag = `--user-data-dir=${profileDir}`;
  const words = (proc.list() ?? "").split("\n").map((line) => line.trim().split(/\s+/)).find((row) => row.includes(flag) && row.some((word) => word.startsWith("--remote-debugging-port=")));
  const port = Number(words?.find((word) => word.startsWith("--remote-debugging-port="))?.split("=")[1] ?? 0);

  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null;
}

/* @invariant THE MCP SETS ONLY CHECKED PNG BYTES, ON A PARTNER CENTER
 * LISTING PAGE, INTO THE TWO IMAGE SLOTS (MCP ledger 1171). The request comes
 * from extension.dev tools' worker, which only the panel and this debug port
 * reach; it is still read as untrusted. A file goes on only when its name is
 * a plain .png name, its bytes are a PNG under 4 MB and their SHA-256 is the
 * one the panel checked, so a request can neither name a path on this
 * machine nor swap the bytes between the panel and the slot. A file the
 * slot already shows, by its bytes or its exact name, is counted as attached
 * and never set again, so a second press never uploads the same image twice.
 */
export function checkRequest(raw: unknown): CheckedRequest | null {
  if (!isRow(raw) || !Array.isArray(raw.slots)) return null;

  const nonce = text(raw.nonce);
  const url = text(raw.url);
  if (!NONCE.test(nonce) || !PARTNER_LISTING.test(url) || raw.slots.length > Object.keys(ATTACH_SLOTS).length) return null;

  const slots: CheckedSlot[] = [];

  for (const slot of raw.slots) {
    if (!isRow(slot) || !ATTACH_SLOTS[text(slot.id)] || !Array.isArray(slot.files) || slot.files.length > MAX_FILES) return null;

    const checked: CheckedSlot = { id: text(slot.id), files: [], refused: [] };

    for (const file of slot.files) {
      const name = isRow(file) ? text(file.name) : "";
      const bytes = isRow(file) && typeof file.base64 === "string" ? Buffer.from(file.base64, "base64") : Buffer.alloc(0);
      const sha256 = isRow(file) ? text(file.sha256).toLowerCase() : "";

      if (!FILE_NAME.test(name)) checked.refused.push("a file without a plain .png name was refused");
      else if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.length > MAX_IMAGE_BYTES) checked.refused.push(`${name} is not a PNG under 4 MB`);
      else if (crypto.createHash("sha256").update(bytes).digest("hex") !== sha256) checked.refused.push(`${name} does not match the SHA-256 the panel checked`);
      else checked.files.push({ name, bytes });
    }

    slots.push(checked);
  }

  return { nonce, url, slots };
}

const SCOPE_JS = `const scopeOf = (input) => { let at = input; for (let i = 0; i < 6 && at.parentElement && at.parentElement !== document.body && at.parentElement.querySelectorAll("input[type=file]").length <= 1; i += 1) at = at.parentElement; return at; };
  const words = (scope) => [scope.textContent || "", ...Array.from(scope.querySelectorAll("[aria-label]")).map((node) => node.getAttribute("aria-label") || "")].join(" ");
  const shownOf = (scope) => Array.from(scope.querySelectorAll("img")).filter((img) => img.getAttribute("src") && !/uploadPlaceholder/i.test(img.getAttribute("src")) && !img.closest("[hidden], [aria-hidden=true], [aria-label*=uploading i]"));`;

function slotScript(pattern: RegExp, read: boolean): string {
  return `(async () => {
  const re = new RegExp(${JSON.stringify(pattern.source)}, "i");
  ${SCOPE_JS}
  const hits = Array.from(document.querySelectorAll("input[type=file]")).filter((input) => re.test(words(scopeOf(input))));
  if (hits.length !== 1) return null;
  if (!${read}) return hits[0];
  const shown = shownOf(scopeOf(hits[0]));
  const hashOf = async (img) => { try { const res = await fetch(img.currentSrc || img.src, { credentials: "omit" }); if (!res.ok) return ""; const digest = await crypto.subtle.digest("SHA-256", await res.arrayBuffer()); return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join(""); } catch { return ""; } };
  return { count: shown.length, alts: shown.map((img) => img.alt || ""), hashes: await Promise.all(shown.map(hashOf)), adds: Boolean(scopeOf(hits[0]).querySelector("[aria-label^='Add image for' i]")) };
})()`;
}

function removeScript(pattern: RegExp, index: number, alt: string): string {
  return `(() => {
  const re = new RegExp(${JSON.stringify(pattern.source)}, "i");
  ${SCOPE_JS}
  const hits = Array.from(document.querySelectorAll("input[type=file]")).filter((input) => re.test(words(scopeOf(input))));
  if (hits.length !== 1) return "no slot";
  const shown = shownOf(scopeOf(hits[0]));
  const img = shown[${index}];
  if (!img || (img.alt || "") !== ${JSON.stringify(alt)}) return "moved";
  let box = img;
  for (let i = 0; i < 5 && box.parentElement && shown.filter((other) => box.parentElement.contains(other)).length === 1; i += 1) box = box.parentElement;
  const label = (node) => (node.getAttribute("aria-label") || node.textContent || "").trim();
  const deletes = Array.from(box.querySelectorAll("button, [role=button]")).filter((node) => /^delete\\b/i.test(label(node)));
  if (deletes.length !== 1) return "no delete";
  deletes[0].click();
  return "pressed";
})()`;
}

const CONFIRM_SCRIPT = `(() => {
  const open = Array.from(document.querySelectorAll("[role=dialog], [role=alertdialog], dialog[open]")).filter((node) => node.getBoundingClientRect().width > 0);
  if (open.length === 0) return "none";
  if (open.length > 1) return "unsure";
  const words = (open[0].textContent || "").replace(/\\s+/g, " ");
  if (/\\ball\\b|listing|language|package|submission|publish|discard|draft/i.test(words) || !/image|screenshot|logo|delete|remove/i.test(words)) return "unsure";
  const said = (node) => /^(ok|yes|delete|confirm)$/i.test((node.textContent || "").trim());
  const oks = Array.from(open[0].querySelectorAll("button, [role=button], v6_he-button")).filter((node) => said(node) && !Array.from(node.querySelectorAll("button, [role=button], v6_he-button")).some(said));
  if (oks.length !== 1) return "unsure";
  oks[0].click();
  return "confirmed";
})()`;

type Shown = { count: number; alts: string[]; hashes: string[]; adds: boolean };

async function shownIn(page: CdpSession, pattern: RegExp): Promise<Shown | null> {
  const answer = (await page.send("Runtime.evaluate", { expression: slotScript(pattern, true), returnByValue: true, awaitPromise: true })) as { result?: { value?: unknown } };
  const value = answer?.result?.value;

  if (!isRow(value) || !Array.isArray(value.alts)) return null;

  const alts = value.alts.map((alt) => text(alt));
  const hashes = Array.isArray(value.hashes) ? value.hashes.map((hash) => text(hash).toLowerCase()) : [];

  return { count: Number(value.count) || 0, alts, hashes: alts.map((_, at) => hashes[at] ?? ""), adds: value.adds !== false };
}

function shownName(shown: Shown, at: number, files: CheckedSlot["files"]): string {
  const hash = shown.hashes[at];
  const byHash = hash ? files.find((file) => crypto.createHash("sha256").update(file.bytes).digest("hex") === hash) : undefined;
  if (byHash) return byHash.name;

  const alt = shown.alts[at] ?? "";

  return files.find((file) => alt === file.name || alt.endsWith(` ${file.name}`))?.name ?? "";
}

/* @invariant THE MCP REMOVES ONLY A SECOND COPY OF AN IMAGE IT IS ATTACHING
 * (Cezar's ruling, MCP ledger 1171). A shown image is named by the SHA-256 of
 * its bytes or, when the page does not hand the bytes over, by a thumbnail
 * text that ends in the file's exact name. The first copy of each file
 * stays; only later copies of that same file are removed, through that one
 * image's own Delete button, and a confirm is answered only when it is the
 * single open dialog and speaks of that image alone. Images that match no
 * file, and every other button on the page, are never touched.
 */
async function removeDuplicates(args: { page: CdpSession; pattern: RegExp; files: CheckedSlot["files"]; sleep: (ms: number) => Promise<void> }): Promise<{ removed: number; note?: string }> {
  let removed = 0;

  for (let round = 0; round < MAX_FILES; round += 1) {
    const shown = await shownIn(args.page, args.pattern);
    if (!shown) return { removed };

    const seen = new Set<string>();
    const extra = shown.alts.findIndex((_, at) => {
      const name = shownName(shown, at, args.files);
      if (!name) return false;
      if (seen.has(name)) return true;

      seen.add(name);

      return false;
    });

    if (extra < 0) return { removed };

    const pressed = await evaluate(args.page, removeScript(args.pattern, extra, shown.alts[extra] ?? ""));
    if (pressed !== "pressed") return { removed, note: `a second copy of ${shownName(shown, extra, args.files)} has no Delete button of its own, so it was left on the page` };

    let gone = false;

    for (let waited = 0; waited < 15_000 && !gone; waited += 500) {
      await args.sleep(500);

      const confirm = await evaluate(args.page, CONFIRM_SCRIPT);
      if (confirm === "unsure") return { removed, note: "Partner Center asked a confirm that does not speak of that one image, so it was left open for you" };

      gone = (await shownIn(args.page, args.pattern))?.count === shown.count - 1;
    }

    if (!gone) return { removed, note: "a second copy did not leave the slot after its Delete was pressed" };

    removed += 1;
  }

  return { removed };
}

export async function attachSlot(args: { page: CdpSession; slot: CheckedSlot; dir: string; sleep: (ms: number) => Promise<void>; waitMs?: number }): Promise<SlotResult> {
  const pattern = ATTACH_SLOTS[args.slot.id]!;
  const names = args.slot.files.map((file) => file.name);
  const first = await shownIn(args.page, pattern);

  if (!first) return { attached: [], missing: names, note: [...args.slot.refused, "Partner Center shows no single slot for these images on this page"].join("; ") };
  if (args.slot.id === "edge.store_logo" && first.count > 0) return { attached: [], missing: [], note: [...args.slot.refused, "the slot already shows a logo, so it was left as it is"].join("; ") };

  const attached: string[] = [];
  const missing: string[] = [];
  const notes: string[] = [...args.slot.refused];
  const cleaned = await removeDuplicates({ page: args.page, pattern, files: args.slot.files, sleep: args.sleep });

  if (cleaned.removed > 0) notes.push(`removed ${cleaned.removed} second ${cleaned.removed === 1 ? "copy" : "copies"} of the same image`);
  if (cleaned.note) notes.push(cleaned.note);

  const before = cleaned.removed > 0 ? ((await shownIn(args.page, pattern)) ?? first) : first;
  const has = (shown: Shown, name: string) => shown.alts.some((_, at) => shownName(shown, at, args.slot.files) === name);
  let count = before.count;

  for (const file of args.slot.files) {
    if (has(before, file.name)) {
      attached.push(file.name);
      continue;
    }

    if (count > 0 && !(await shownIn(args.page, pattern))?.adds) {
      missing.push(file.name);
      notes.push(`the slot takes no more images (it shows ${count}); remove the extra ones on the page, then press again`);
      continue;
    }

    const target = path.join(args.dir, file.name);

    fs.writeFileSync(target, file.bytes, { mode: 0o600 });

    const located = (await args.page.send("Runtime.evaluate", { expression: slotScript(pattern, false), returnByValue: false, awaitPromise: true })) as { result?: { objectId?: string; subtype?: string } };
    const objectId = located?.result?.subtype === "node" ? located.result.objectId : undefined;

    if (!objectId) {
      missing.push(file.name);
      continue;
    }

    await args.page.send("DOM.setFileInputFiles", { files: [target], objectId });

    let landed = false;

    for (let waited = 0; waited < (args.waitMs ?? 45_000) && !landed; waited += 1000) {
      await args.sleep(1000);

      const now = await shownIn(args.page, pattern);
      landed = Boolean(now && (has(now, file.name) || now.count > count));
      if (landed && now) count = now.count;
    }

    (landed ? attached : missing).push(file.name);
  }

  const after = attached.length > 1 ? await shownIn(args.page, pattern) : null;
  const order = after ? after.alts.map((_, at) => shownName(after, at, args.slot.files)).filter((name) => attached.includes(name)) : [];

  if (order.length === attached.length && order.some((name, at) => name !== names.filter((one) => attached.includes(one))[at])) notes.push(`the slot shows them in this order: ${order.join(", ")}`);

  const note = [...new Set(notes)].join("; ");

  return { attached, missing, ...(note ? { note } : {}) };
}

async function evaluate(session: CdpSession, expression: string): Promise<unknown> {
  const answer = (await session.send("Runtime.evaluate", { expression, returnByValue: true })) as { result?: { value?: unknown } };

  return answer?.result?.value ?? null;
}

/* @invariant THE MCP SERVES ONLY ITS OWN GUIDED WINDOW'S EXTENSION (MCP
 * ledger 1171). The debug port is read from the browser running this very
 * profile, the worker is the one whose extension id is derived from the
 * folder this MCP loaded, and the page is the tab whose address the request
 * names, so no other extension, profile or tab is read or written.
 */
export async function serveAttachOnce(args: { port: number; extensionId: string; driver: AttachDriver; tempRoot?: string; waitMs?: number }): Promise<"idle" | "served"> {
  const targets = await args.driver.targets(args.port);
  const worker = targets.find((target) => target.type === "service_worker" && target.url.startsWith(`chrome-extension://${args.extensionId}/`));
  if (!worker) return "idle";

  const session = await args.driver.open(worker.webSocketDebuggerUrl);

  try {
    const raw = await evaluate(session, `globalThis.${RELAY_GLOBAL}?.take() ?? null`);
    if (raw === null) return "idle";

    const request = checkRequest(raw);
    const nonce = isRow(raw) && NONCE.test(text(raw.nonce)) ? text(raw.nonce) : "";
    const slots: Record<string, SlotResult> = {};
    const page = request ? targets.find((target) => target.type === "page" && target.url === request.url) : undefined;

    if (request && page) {
      const dir = fs.mkdtempSync(path.join(args.tempRoot ?? os.tmpdir(), "extension-dev-attach-"));
      const tab = await args.driver.open(page.webSocketDebuggerUrl);

      try {
        for (const slot of request.slots) slots[slot.id] = await attachSlot({ page: tab, slot, dir, sleep: args.driver.sleep, waitMs: args.waitMs });
      } finally {
        tab.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } else if (request) {
      for (const slot of request.slots) slots[slot.id] = { attached: [], missing: slot.files.map((file) => file.name), note: "the MCP did not find the Partner Center tab that asked" };
    }

    if (nonce) await evaluate(session, `globalThis.${RELAY_GLOBAL}?.done(${JSON.stringify({ nonce, slots })}) ?? false`);

    return "served";
  } finally {
    session.close();
  }
}

const TEAM_KEYS = /^https:\/\/appstoreconnect\.apple\.com\/access\/(?:integrations\/)?api(?:[/?#]|$)/i;
const P8 = /^-----BEGIN PRIVATE KEY-----[\s\S]{16,4096}-----END PRIVATE KEY-----\s*$/;
const MAX_P8_BYTES = 64 * 1024;
const KEY_WAIT_MS = 60_000;

type KeyAnswer = { nonce: string; p8?: string; note?: string };

async function landedKey(args: { dir: string; sleep: (ms: number) => Promise<void>; open: () => Promise<boolean>; waitMs: number }): Promise<Omit<KeyAnswer, "nonce">> {
  for (let waited = 0; waited < args.waitMs; waited += 500) {
    await args.sleep(500);

    if (!(await args.open())) return { note: "the panel withdrew the download before a .p8 landed" };

    const names = fs.readdirSync(args.dir);
    const keys = names.filter((name) => /\.p8$/i.test(name));

    if (names.some((name) => /\.crdownload$/i.test(name)) || !keys.length) continue;
    if (keys.length > 1) return { note: "more than one .p8 landed, so none was read" };

    const file = path.join(args.dir, keys[0]!);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_P8_BYTES) return { note: "the file that landed is not a .p8 key" };

    const key = fs.readFileSync(file, "utf8").trim();

    return P8.test(key) ? { p8: key } : { note: "the file that landed is not a .p8 key" };
  }

  return { note: "no .p8 landed within 60 seconds" };
}

/* @invariant THE MCP TAKES APPLE'S .P8 ONLY THROUGH A DOWNLOAD FOLDER OF ITS
 * OWN, FOR ITS OWN GUIDED WINDOW, AND KEEPS NOTHING (MCP ledger 1292). The
 * ask comes from the extension.dev tools worker of the folder this MCP
 * loaded, for an App Store Connect Team Keys tab; the MCP sets that browser's
 * downloads to a fresh 0700 folder with Browser.setDownloadBehavior (browser
 * configuration, never a page press), tells the worker, and the panel presses
 * Apple's Download. The one .p8 that lands is read, the folder is removed and
 * the browser's own download setting is restored whatever happens; a second
 * file, a non-key file or a withdrawn ask hands nothing over.
 */
export async function serveKeyOnce(args: { port: number; extensionId: string; driver: AttachDriver; tempRoot?: string; waitMs?: number }): Promise<"idle" | "served"> {
  if (!args.driver.browser) return "idle";

  const targets = await args.driver.targets(args.port);
  const worker = targets.find((target) => target.type === "service_worker" && target.url.startsWith(`chrome-extension://${args.extensionId}/`));
  if (!worker) return "idle";

  const session = await args.driver.open(worker.webSocketDebuggerUrl);

  try {
    const raw = await evaluate(session, `globalThis.${RELAY_GLOBAL}?.takeKey?.() ?? null`);
    if (!isRow(raw)) return "idle";

    const nonce = text(raw.nonce);
    const url = text(raw.url);
    if (!NONCE.test(nonce)) return "served";

    const answer = async (result: Omit<KeyAnswer, "nonce">) => {
      await evaluate(session, `globalThis.${RELAY_GLOBAL}?.doneKey?.(${JSON.stringify({ nonce, ...result })}) ?? false`);
    };

    if (!TEAM_KEYS.test(url) || !targets.some((target) => target.type === "page" && target.url === url)) {
      await answer({ note: "the MCP did not find the App Store Connect tab that asked" });

      return "served";
    }

    const browserUrl = await args.driver.browser(args.port);

    if (!browserUrl) {
      await answer({ note: "the MCP could not reach this browser's download setting" });

      return "served";
    }

    const dir = fs.mkdtempSync(path.join(args.tempRoot ?? os.tmpdir(), "extension-dev-key-"));
    const browser = await args.driver.open(browserUrl);
    let result: Omit<KeyAnswer, "nonce"> = { note: "the download folder could not be set" };

    try {
      fs.chmodSync(dir, 0o700);
      await browser.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dir, eventsEnabled: false });

      if ((await evaluate(session, `globalThis.${RELAY_GLOBAL}?.armedKey?.(${JSON.stringify(nonce)}) ?? false`)) === true) {
        result = await landedKey({ dir, sleep: args.driver.sleep, open: async () => (await evaluate(session, `globalThis.${RELAY_GLOBAL}?.keyOpen?.(${JSON.stringify(nonce)}) ?? false`)) === true, waitMs: args.waitMs ?? KEY_WAIT_MS });
      }
    } finally {
      await browser.send("Browser.setDownloadBehavior", { behavior: "default" }).catch(() => undefined);
      browser.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }

    await answer(result);

    return "served";
  } finally {
    session.close();
  }
}

export const cdpAttachDriver: AttachDriver = {
  targets: async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`);

    return res.ok ? ((await res.json()) as CdpTarget[]) : [];
  },
  browser: async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    const body: unknown = res.ok ? await res.json() : null;

    return isRow(body) && /^ws:\/\/(?:127\.0\.0\.1|localhost):\d+\/devtools\/browser\//.test(text(body.webSocketDebuggerUrl)) ? text(body.webSocketDebuggerUrl) : null;
  },
  open: async (wsUrl) => {
    const connection = new CDPConnection();

    await connection.connect(wsUrl);

    return { send: (method, params) => connection.sendCommand(method, params ?? {}), close: () => connection.disconnect() };
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const watchers = new Map<string, () => void>();

export function watchGuidedAttach(args: { profileDir: string; extensionDir: string; minutes?: number; driver?: AttachDriver; proc?: GuidedProcess }): () => void {
  watchers.get(args.profileDir)?.();

  const extensionId = unpackedExtensionId(args.extensionDir);
  const driver = args.driver ?? cdpAttachDriver;
  const until = Date.now() + (args.minutes ?? 60) * 60_000;
  let busy = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const stop = () => {
    if (timer) clearInterval(timer);
    if (watchers.get(args.profileDir) === stop) watchers.delete(args.profileDir);
  };

  timer = setInterval(() => {
    if (Date.now() > until) return stop();
    if (busy) return;

    const port = debugPortOf(args.profileDir, args.proc);
    if (!port) return;

    busy = true;
    serveAttachOnce({ port, extensionId, driver })
      .then((served) => (served === "idle" ? serveKeyOnce({ port, extensionId, driver }) : served))
      .catch(() => "idle")
      .finally(() => {
        busy = false;
      });
  }, 1500);

  timer.unref?.();

  watchers.set(args.profileDir, stop);

  return stop;
}
