// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { findManagedBinary, findSystemBinary } from "../tools/detect-browsers";
import { autoOpenBlock, openableUrl } from "./approval-open";
import { credentialsPath } from "./credentials";
import { envelope, isEnvelope } from "./envelope";
import { connectedAnswer, readStoreAccount, replacing, workspaceToken } from "./guided-connect-account";
import { spawnExtensionCli } from "./exec";
import {
  chooseGuidedBrowser,
  guidedBrowserLabel,
  guidedEngine,
  guidedProfileDir,
  type BrowserProbe,
  type GuidedBrowser,
  type GuidedBrowserChoice,
} from "./guided-browser";
import { windowCheck, type WindowCheck } from "./guided-window";
import { guidedCopy } from "./guided-copy-build";
import { headlessLaunch } from "./launch-flags";
import { mcpOrigins } from "./origins";
import { withoutRedirects } from "./platform-fetch";
import { isRow, text } from "./row";
import { nextStep, storeLabel } from "./store-connection";
import { resolveToolsExtension, type ToolsExtension } from "./tools-extension";
import { userCacheDir } from "./user-cache-dir";

type Args = Record<string, unknown>;

export const WORKSPACE_CONNECT_STATUS = "workspace-connect-in-console";

export const GUIDED_STATUS = "workspace-connect-guided";

export { CONNECTED_STATUS, readStoreAccount, replaceCall, type StoreAccountRead, type StoreAccountView } from "./guided-connect-account";

export const GUIDED_CONNECT_STORES = new Set(["edge"]);

export const HANDOFF_PATH = "/api/cli/console-handoff";

export const LAUNCH_HANDOFF_PAGE = "https://www.extension.dev/device/handoff";

export const GUIDED_KEY_PAGES: Record<string, { url: string; page: string }> = {
  edge: { url: "https://partner.microsoft.com/dashboard/microsoftedge/publishapi", page: "Edge Partner Center Publish API page" },
};

const LAUNCH_SECONDS = 15 * 60;

const LAUNCH_FILE = "launch.json";

export const LAUNCH_FILE_KEEP_MS = 120_000;

function scheduleLater(ms: number, run: () => void): void {
  const timer = setTimeout(run, ms);

  timer.unref();
  process.once("exit", () => {
    clearTimeout(timer);
    run();
  });
}

export interface LaunchPlan {
  choice: GuidedBrowserChoice;
  extensionDir: string;
  profileDir: string;
  url: string;
  env: Record<string, string>;
}

export interface LaunchResult {
  launched: boolean;
  reused: boolean;
  reason?: string;
}

export interface GuidedConnectRuntime {
  launchBlock(): string;
  probe(): BrowserProbe;
  fetch: typeof fetch;
  stateDir(): string;
  cacheDir(): string;
  launchEnv(): Record<string, string>;
  launch(plan: LaunchPlan): LaunchResult;
  windowCheck?(profileDir: string): Promise<WindowCheck>;
  schedule?(ms: number, run: () => void): void;
}

export type { WindowCheck } from "./guided-window";

function quietRun(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, { encoding: "utf8", timeout: 3_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

export function parseLastUsed(raw: string | null): number | null {
  const value = String(raw ?? "").trim();
  if (!value || value === "(null)") return null;

  const at = Date.parse(value.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{4})$/, "$1T$2$3"));

  return Number.isFinite(at) ? at : null;
}

export function parseUserChoice(raw: string | null): string | null {
  return /ProgId\s+REG_SZ\s+(\S+)/i.exec(String(raw ?? ""))?.[1] ?? null;
}

export function parseLaunchServicesHttp(raw: string | null): string | null {
  let role: string | null = null;

  for (const line of String(raw ?? "").split("\n")) {
    if (/^\s*\{\s*$/.test(line)) role = null;

    role = /LSHandlerRoleAll = "?([^";]+)"?;/.exec(line)?.[1] ?? role;
    if (/LSHandlerURLScheme = "?http"?;/.test(line)) return role;
  }

  return null;
}

function systemDefaultBrowser(platform: NodeJS.Platform): string | null {
  if (platform === "darwin") {
    return parseLaunchServicesHttp(quietRun("defaults", ["read", "com.apple.LaunchServices/com.apple.launchservices.secure", "LSHandlers"]));
  }

  if (platform === "win32") {
    return parseUserChoice(quietRun("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice", "/v", "ProgId"]));
  }

  return platform === "linux" ? quietRun("xdg-settings", ["get", "default-web-browser"]) : null;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

function runningFile(profileDir: string): string {
  return path.join(path.dirname(profileDir), "running.json");
}

function reuseArgs(plan: LaunchPlan): string[] {
  return guidedEngine(plan.choice.browser) === "gecko" ? ["--profile", plan.profileDir, "--new-tab", plan.url] : [`--user-data-dir=${plan.profileDir}`, plan.url];
}

function previewArgs(plan: LaunchPlan): string[] {
  const binaryFlag = guidedEngine(plan.choice.browser) === "gecko" ? "--gecko-binary" : "--chromium-binary";

  return [
    "preview",
    plan.extensionDir,
    "--browser",
    plan.choice.browser,
    "--profile",
    plan.profileDir,
    "--starting-url",
    plan.url,
    ...(plan.choice.binary ? [binaryFlag, plan.choice.binary] : []),
  ];
}

export function privateProfile(profileDir: string): void {
  const browserDir = path.dirname(profileDir);

  for (const dir of [path.dirname(browserDir), browserDir, profileDir]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  }
}

/* @invariant ONE GUIDED BROWSER PER PROFILE, KEPT PRIVATE AND RUN BY THE
 * MCP'S OWN ENGINE. A second connect while the guided browser of that profile
 * still runs hands the page to the running browser through its own
 * single-instance door, never a second launch on the same profile. The
 * profile holds the person's console and store sessions, so its folders are
 * 0700 and the running marker 0600, and the engine is never resolved from the
 * extension folder.
 */
export function launchGuidedBrowser(plan: LaunchPlan): LaunchResult {
  privateProfile(plan.profileDir);

  const marker = runningFile(plan.profileDir);
  let running: { pid?: number } = {};

  try {
    running = JSON.parse(fs.readFileSync(marker, "utf8"));
  } catch {
  }

  if (typeof running.pid === "number" && processAlive(running.pid) && plan.choice.binary) {
    try {
      const child = spawn(plan.choice.binary, reuseArgs(plan), { detached: true, stdio: "ignore" });
      child.on("error", () => undefined);
      child.unref();

      return { launched: true, reused: true };
    } catch (err) {
      return { launched: false, reused: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  try {
    const spawned = spawnExtensionCli(previewArgs(plan), {
      cwd: path.dirname(plan.profileDir),
      ownEngine: true,
      env: plan.env,
    });
    const pid = spawned.child.pid;

    if (pid === undefined) return { launched: false, reused: false, reason: spawned.spawnError?.()?.message ?? "the Extension.js process did not start" };

    fs.writeFileSync(marker, JSON.stringify({ pid, browser: plan.choice.browser }), { mode: 0o600 });
    fs.chmodSync(marker, 0o600);

    return { launched: true, reused: false };
  } catch (err) {
    return { launched: false, reused: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/* @invariant THE GUIDED BROWSER IS THE PERSON'S OWN WINDOW, SO IT IS NEVER
 * HEADLESS. EXTENSION_HEADLESS and a --headless in EXTENSION_BROWSER_FLAGS
 * keep automated launches off the screen, and they are dropped for this one
 * launch only; every other browser flag stays. An answer says a window
 * opened only when the launch it describes was visible.
 */
export function visibleLaunchEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined>): Record<string, string> {
  return headlessLaunch({ headless: false }, env).env ?? {};
}

export const guidedConnectRuntime: GuidedConnectRuntime = {
  launchBlock: () => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "EXTENSION_HEADLESS" && key !== "EXTENSION_BROWSER_FLAGS"));

    return autoOpenBlock({ noShip: false }, env);
  },
  probe: () => ({
    platform: process.platform,
    systemBinary: (browser) => findSystemBinary(browser),
    managedBinary: (browser) => findManagedBinary(browser),
    lastUsed: (appPath) => parseLastUsed(quietRun("mdls", ["-raw", "-name", "kMDItemLastUsedDate", appPath])),
    defaultBrowser: () => systemDefaultBrowser(process.platform),
  }),
  fetch: (input, init) => globalThis.fetch(input, init),
  stateDir: () => path.dirname(credentialsPath()),
  cacheDir: () => path.join(userCacheDir(), "extension-dev-tools"),
  launchEnv: () => visibleLaunchEnv(process.env),
  launch: launchGuidedBrowser,
  windowCheck,
  schedule: scheduleLater,
};

export interface ConsoleLanding {
  openUrl: string;
  signedIn: boolean;
  note: string;
  launchBound?: boolean;
  expiresAt?: string;
}

const SIGN_IN_ONCE = "The console opens signed out, so the person signs in to extension.dev there once; the profile keeps that sign-in.";

function originOf(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    return "";
  }
}

export function handoffUrl(raw: string, api?: string): string {
  const href = openableUrl(raw);
  const origins = mcpOrigins(api);
  const origin = originOf(href);

  return origin && (origin === originOf(origins.www) || origin === originOf(origins.console)) ? href : "";
}

export const HANDOFF_STORES = new Set(["chrome", "edge", "firefox"]);

export function handoffNext(workspace: string, store: string): string {
  return `/${workspace}/settings/store-accounts${HANDOFF_STORES.has(store) ? `?store=${store}` : ""}`;
}

/* @invariant THE ONE-TIME CONSOLE HANDOFF NEVER LEAVES THIS PROCESS EXCEPT
 * INTO THE BROWSER IT OPENS. The platform answers POST /api/cli/console-handoff
 * with a single-use address that signs the profile in; it is opened and
 * forgotten, never logged and never put in the answer. It opens only on the
 * platform origin this MCP calls or on its console. A platform without the
 * door (404), any other answer or any other origin opens the plain console
 * page, and the answer says the person signs in there once.
 */
export async function consoleLanding(options: { workspace: string; next: string; plainUrl: string; api?: string; launchHash?: string; fetchImpl: typeof fetch }): Promise<ConsoleLanding> {
  const token = workspaceToken(options.workspace, options.api);
  if (!token) return { openUrl: options.plainUrl, signedIn: false, note: SIGN_IN_ONCE };

  try {
    const res = await withoutRedirects(options.fetchImpl)(`${mcpOrigins(options.api).www}${HANDOFF_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ next: options.next, ...(options.launchHash ? { launchHash: options.launchHash } : {}) }),
      signal: AbortSignal.timeout(10_000),
    });

    if (res.status === 200) {
      const body: unknown = await res.json().catch(() => null);
      const url = isRow(body) ? handoffUrl(text(body.url), options.api) : "";
      const row = isRow(body) ? body : {};
      const launchBound = Boolean(options.launchHash && row.launchBound === true);
      if (url) return { openUrl: url, signedIn: true, note: "", ...(launchBound ? { launchBound, expiresAt: text(row.launchExpiresAt) } : {}) };
    }
  } catch {
  }

  return { openUrl: options.plainUrl, signedIn: false, note: SIGN_IN_ONCE };
}

function launchFile(extensionDir: string): string {
  return path.join(extensionDir, LAUNCH_FILE);
}

function launchExpiry(raw: string | undefined): string {
  const now = Date.now();
  const at = Date.parse(String(raw ?? ""));

  return new Date(Number.isFinite(at) && at > now && at <= now + LAUNCH_SECONDS * 1000 ? at : now + 60_000).toISOString();
}

/* @invariant THE LAUNCH SECRET REACHES ONLY THE BROWSER THIS MCP OPENS (MCP
 * ledger 1114). Its sha256 goes to the platform with the handoff mint; the
 * secret itself and the one-time handoff address are written 0600 into the
 * extension folder this MCP loads and nowhere else, never into argv, a log or
 * the answer. The extension takes them once, opens the handoff in a background
 * tab and gives the secret to that tab alone, so the confirm press is skipped
 * there and kept for any link opened anywhere else. The file is removed two
 * minutes after the launch, when this process exits, and on the next guided
 * connect, whichever comes first.
 */
export function writeLaunchFile(extensionDir: string, launch: { handoff: string; secret: string; expiresAt: string }): void {
  const file = launchFile(extensionDir);
  const staging = `${file}.${process.pid}.${Date.now()}`;
  const body = { id: crypto.randomBytes(12).toString("base64url"), ...launch };

  fs.writeFileSync(staging, JSON.stringify(body), { mode: 0o600 });
  fs.chmodSync(staging, 0o600);
  fs.renameSync(staging, file);
}

export function clearLaunchFile(extensionDir: string): void {
  fs.rmSync(launchFile(extensionDir), { force: true });
}

function readBack(workspace: string): string {
  return `extension_workspace_read {action:"info", workspace:"${workspace}", include:["storeAccounts"]}`;
}

function plainAnswer(parsed: { command: string; value: Args; hint: string }, note: string): string {
  return envelope({
    ok: true,
    command: parsed.command,
    status: WORKSPACE_CONNECT_STATUS,
    value: { ...parsed.value, guidedBrowser: { opened: false, note } },
    hint: `${note} ${parsed.hint}`,
  });
}

/* @invariant A WORKSPACE STORE CONNECT OPENS THE MCP'S OWN BROWSER WITH
 * EXTENSION.DEV TOOLS LOADED (Cezar, 2026-11-24, "go A"). On the person's
 * machine the connect answer is turned into a launch: the browser the person
 * uses, a profile the MCP keeps for it, the tools extension from its store
 * (or the bundled copy), and the console's Store accounts page for that store,
 * signed in through the one-time handoff when the platform has it. The answer
 * says what the person does in that window and that the agent reads the
 * connection back once they say they are done.
 */
export async function guideStoreConnect(result: string, args: Args, runtime: GuidedConnectRuntime = guidedConnectRuntime): Promise<string> {
  try {
    return await guidedAnswer(result, args, runtime);
  } catch (err) {
    const parsed: unknown = JSON.parse(result);
    if (!isEnvelope(parsed) || !isRow(parsed.value)) return result;

    return plainAnswer({ command: parsed.command, value: parsed.value, hint: text(parsed.hint) }, `No browser was opened: ${err instanceof Error ? err.message : String(err)}.`);
  }
}

export type GuidedOpen =
  | { install: GuidedBrowserChoice & { install: string } }
  | { opened: false; note: string }
  | { opened: true; choice: GuidedBrowserChoice; label: string; extension: ToolsExtension; landing: ConsoleLanding; launched: LaunchResult; profileDir: string; onStorePage: boolean };

export async function openGuided(options: { workspace: string; next: string | null; plainUrl: string; storePage: string | null; api?: string; runtime: GuidedConnectRuntime }): Promise<GuidedOpen> {
  const { runtime } = options;
  const block = runtime.launchBlock();
  if (block) return { opened: false, note: `No browser was opened: ${block}.` };

  const choice = chooseGuidedBrowser(runtime.probe());
  const label = choice.browser === "chrome" ? "Chrome for Testing" : guidedBrowserLabel(choice.browser);

  if (choice.install) return { install: { ...choice, install: choice.install } };

  const engine = guidedEngine(choice.browser);
  const extension: ToolsExtension | { failed: string } = await resolveToolsExtension({ engine, edge: choice.browser === "edge", cacheDir: runtime.cacheDir(), fetchImpl: runtime.fetch });

  if ("failed" in extension) return { opened: false, note: `No browser was opened: ${extension.failed}.` };

  const secret = options.storePage ? crypto.randomBytes(32).toString("base64url") : "";
  const launchHash = secret ? crypto.createHash("sha256").update(secret).digest("hex") : undefined;
  const landing: ConsoleLanding = options.next === null ? { openUrl: options.plainUrl, signedIn: false, note: "" } : await consoleLanding({ workspace: options.workspace, next: options.next, plainUrl: options.plainUrl, api: options.api, launchHash, fetchImpl: runtime.fetch });
  const onStorePage = Boolean(options.storePage && landing.launchBound && landing.openUrl.split("#")[0] === LAUNCH_HANDOFF_PAGE);
  const extensionDir = guidedCopy(extension.dir, runtime.cacheDir(), engine);

  if (onStorePage) writeLaunchFile(extensionDir, { handoff: landing.openUrl, secret, expiresAt: launchExpiry(landing.expiresAt) });

  const profileDir = guidedProfileDir(runtime.stateDir(), choice.browser as GuidedBrowser);
  const launched = runtime.launch({ choice, extensionDir, profileDir, url: onStorePage && options.storePage ? options.storePage : landing.openUrl, env: runtime.launchEnv() });

  if (!launched.launched) {
    clearLaunchFile(extensionDir);

    return { opened: false, note: `No browser was opened: ${label} did not start (${launched.reason ?? "no reason given"}).` };
  }

  if (onStorePage) (runtime.schedule ?? scheduleLater)(LAUNCH_FILE_KEEP_MS, () => clearLaunchFile(extensionDir));

  const shown = runtime.windowCheck ? await runtime.windowCheck(profileDir) : "unknown";

  if (shown === "headless") {
    clearLaunchFile(extensionDir);

    return { opened: false, note: `No window is showing: ${label} started headless, since a --headless flag reached it from this machine's own browser setup, not from this MCP.` };
  }

  return { opened: true, choice, label, extension, landing, launched, profileDir, onStorePage };
}

async function guidedAnswer(result: string, args: Args, runtime: GuidedConnectRuntime): Promise<string> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(result);
  } catch {
    return result;
  }

  if (!isEnvelope(parsed) || parsed.status !== WORKSPACE_CONNECT_STATUS || !isRow(parsed.value)) return result;

  const value = parsed.value;
  const workspace = text(value.workspace);
  const project = text(value.project);
  const base = text(value.storeAccountsUrl);
  if (!workspace || !base) return result;

  const store = Array.isArray(args.browsers) ? args.browsers.map(text).find(Boolean) ?? "" : "";
  const query = store ? `?store=${encodeURIComponent(store)}` : "";
  const plainUrl = `${base}${query}`;
  const read = store && !replacing(args) ? await readStoreAccount({ workspace, store, api: text(args.api) || undefined, fetchImpl: runtime.fetch }) : null;

  if (read && "account" in read && read.account) return connectedAnswer(parsed.command, { workspace, project, store, url: plainUrl }, read.account);

  const unread = read && "unread" in read ? `The ${storeLabel(store)} account of ${workspace} could not be read (${read.unread}), so this connect goes on as if it were not connected.` : "";
  const accountState = unread ? { storeAccount: { read: false, reason: (read as { unread: string }).unread } } : {};
  const answer = { command: parsed.command, value: { ...value, ...accountState }, hint: [unread, text(parsed.hint)].filter(Boolean).join(" ") };

  const keyPage = GUIDED_KEY_PAGES[store];
  const opened = await openGuided({ workspace, next: handoffNext(workspace, store), plainUrl, storePage: keyPage?.url ?? null, api: text(args.api) || undefined, runtime });

  if ("install" in opened) {
    return envelope({
      ok: true,
      command: parsed.command,
      status: WORKSPACE_CONNECT_STATUS,
      value: { ...answer.value, storeAccountsUrl: plainUrl, guidedBrowser: { opened: false, browser: opened.install.browser, why: opened.install.why, install: opened.install.install } },
      hint: `${unread ? `${unread} ` : ""}${opened.install.why} It is not installed: install it with extension_browsers_install {action:"install", browser:"${opened.install.install}"}, then call this connect again to open it with extension.dev tools loaded.`,
    });
  }

  if (!opened.opened) return plainAnswer(answer, opened.note);

  const { choice, label, extension, landing, launched, profileDir, onStorePage: onKeyPage } = opened;

  const storeName = store ? storeLabel(store) : "the store";
  const signIn = landing.signedIn ? "" : "sign in to extension.dev once, then ";
  const say = onKeyPage && keyPage
    ? `In front, the ${label} window shows the ${keyPage.page}; sign in to Partner Center there if it asks. Within a few seconds the extension.dev tools panel shows on that page (the ${workspace} console signs in by itself in a background tab) with one button to press, "Create a new API key and connect": it presses Partner Center's "New API key" for you, names the key extension.dev if asked, and sends the Client ID and the new key to the console, which checks them with ${storeName} before it keeps them, so no key passes through this chat. If the panel asks for "Turn on API" first, press that on the page. ${storeName} is connected only when the panel says so.`
    : `In the ${label} window that just opened on the ${workspace} Store accounts page, ${signIn}follow the extension.dev tools panel: it takes you to the ${storeName} key page, captures the values when you press it and hands them to the console, so no key passes through this chat. Tell me when the page says connected.`;
  const openedWord = launched.reused ? "The guided browser already running took the page:" : "Opened";

  return envelope({
    ok: true,
    command: parsed.command,
    status: GUIDED_STATUS,
    value: {
      workspace,
      ...(project ? { project } : {}),
      ...(store ? { store } : {}),
      storeAccountsUrl: plainUrl,
      guidedBrowser: { opened: true, browser: choice.browser, why: choice.why, profile: profileDir, reused: launched.reused },
      toolsExtension: { source: extension.source, version: extension.version, note: extension.note },
      signedIn: landing.signedIn,
      ...(onKeyPage && keyPage ? { landedOn: keyPage.url } : {}),
      ...accountState,
      sayToPerson: say,
      nextStep: nextStep("connect", say, plainUrl),
    },
    hint: [
      unread,
      `${openedWord} ${choice.why} Profile: ${profileDir}.`,
      extension.source === "bundled" ? extension.note : "",
      landing.note,
      project ? `${project} uses the workspace's ${storeName} account once it is connected, unless it holds a key of its own.` : "",
      `Tell the person: "${say}" When they say done, call ${readBack(workspace)} and report whether ${storeName} is connected.`,
    ].filter(Boolean).join(" "),
  });
}
