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
 * slot already shows by name is counted as attached and never set again, so
 * a second press never uploads the same image twice.
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

function slotScript(pattern: RegExp, read: boolean): string {
  return `(() => {
  const re = new RegExp(${JSON.stringify(pattern.source)}, "i");
  const scopeOf = (input) => { let at = input; for (let i = 0; i < 6 && at.parentElement && at.parentElement !== document.body && at.parentElement.querySelectorAll("input[type=file]").length <= 1; i += 1) at = at.parentElement; return at; };
  const words = (scope) => [scope.textContent || "", ...Array.from(scope.querySelectorAll("[aria-label]")).map((node) => node.getAttribute("aria-label") || "")].join(" ");
  const hits = Array.from(document.querySelectorAll("input[type=file]")).filter((input) => re.test(words(scopeOf(input))));
  if (hits.length !== 1) return null;
  if (!${read}) return hits[0];
  const shown = Array.from(scopeOf(hits[0]).querySelectorAll("img")).filter((img) => img.getAttribute("src") && !/uploadPlaceholder/i.test(img.getAttribute("src")) && !img.closest("[hidden], [aria-hidden=true], [aria-label*=uploading i]"));
  return { count: shown.length, alts: shown.map((img) => img.alt || ""), adds: Boolean(scopeOf(hits[0]).querySelector("[aria-label^='Add image for' i]")) };
})()`;
}

async function shownIn(page: CdpSession, pattern: RegExp): Promise<{ count: number; alts: string[]; adds: boolean } | null> {
  const answer = (await page.send("Runtime.evaluate", { expression: slotScript(pattern, true), returnByValue: true })) as { result?: { value?: unknown } };
  const value = answer?.result?.value;

  return isRow(value) && Array.isArray(value.alts) ? { count: Number(value.count) || 0, alts: value.alts.map((alt) => text(alt)), adds: value.adds !== false } : null;
}

export async function attachSlot(args: { page: CdpSession; slot: CheckedSlot; dir: string; sleep: (ms: number) => Promise<void>; waitMs?: number }): Promise<SlotResult> {
  const pattern = ATTACH_SLOTS[args.slot.id]!;
  const names = args.slot.files.map((file) => file.name);
  const before = await shownIn(args.page, pattern);

  if (!before) return { attached: [], missing: names, note: [...args.slot.refused, "Partner Center shows no single slot for these images on this page"].join("; ") };
  if (args.slot.id === "edge.store_logo" && before.count > 0) return { attached: [], missing: [], note: [...args.slot.refused, "the slot already shows a logo, so it was left as it is"].join("; ") };

  const attached: string[] = [];
  const missing: string[] = [];
  const notes: string[] = [...args.slot.refused];
  let count = before.count;

  for (const file of args.slot.files) {
    if (before.alts.some((alt) => alt.includes(file.name))) {
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

    const located = (await args.page.send("Runtime.evaluate", { expression: slotScript(pattern, false), returnByValue: false })) as { result?: { objectId?: string; subtype?: string } };
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
      landed = Boolean(now && (now.alts.some((alt) => alt.includes(file.name)) || now.count > count));
      if (landed && now) count = now.count;
    }

    (landed ? attached : missing).push(file.name);
  }

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

export const cdpAttachDriver: AttachDriver = {
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
      .catch(() => "idle")
      .finally(() => {
        busy = false;
      });
  }, 1500);

  timer.unref?.();

  watchers.set(args.profileDir, stop);

  return stop;
}
