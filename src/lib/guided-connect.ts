// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { findManagedBinary, findSystemBinary } from "../tools/detect-browsers";
import { approvalPageUrl, autoOpenBlock } from "./approval-open";
import { credentialsPath, listCredentials, liveAt } from "./credentials";
import { targetServer } from "./credential-server";
import { envelope, isEnvelope } from "./envelope";
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
import { envIsHeadless } from "./launch-flags";
import { mcpOrigins } from "./origins";
import { withoutRedirects } from "./platform-fetch";
import { isRow, text } from "./row";
import { nextStep, storeLabel } from "./store-connection";
import { resolveToolsExtension, type ToolsExtension } from "./tools-extension";
import { userCacheDir } from "./user-cache-dir";

type Args = Record<string, unknown>;

export const WORKSPACE_CONNECT_STATUS = "workspace-connect-in-console";

export const HANDOFF_PATH = "/api/cli/console-handoff";

export interface LaunchPlan {
  choice: GuidedBrowserChoice;
  extensionDir: string;
  profileDir: string;
  url: string;
  headless: boolean;
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
  headless(): boolean;
  launch(plan: LaunchPlan): LaunchResult;
}

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

/* @invariant ONE GUIDED BROWSER PER PROFILE. A second connect while the
 * guided browser of that profile still runs hands the page to the running
 * browser through its own single-instance door, never a second launch on the
 * same profile.
 */
export function launchGuidedBrowser(plan: LaunchPlan): LaunchResult {
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

  fs.mkdirSync(plan.profileDir, { recursive: true });

  try {
    const spawned = spawnExtensionCli(previewArgs(plan), {
      cwd: plan.extensionDir,
      ...(plan.headless ? { env: { EXTENSION_HEADLESS: "1" } } : {}),
    });
    const pid = spawned.child.pid;

    if (pid === undefined) return { launched: false, reused: false, reason: spawned.spawnError?.()?.message ?? "the Extension.js process did not start" };

    fs.writeFileSync(marker, JSON.stringify({ pid, browser: plan.choice.browser }));

    return { launched: true, reused: false };
  } catch (err) {
    return { launched: false, reused: false, reason: err instanceof Error ? err.message : String(err) };
  }
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
  headless: () => /^(1|true)$/i.test(process.env.EXTENSION_HEADLESS ?? "") || envIsHeadless(process.env),
  launch: launchGuidedBrowser,
};

function workspaceToken(workspace: string, api?: string): string {
  const server = targetServer(api);
  const live = listCredentials().filter((entry) => entry.server === server && entry.workspaceSlug.toLowerCase() === workspace && liveAt(entry));
  const member = live.find((entry) => entry.kind === "member");

  return (member ?? live.sort((a, b) => b.expiresAt - a.expiresAt)[0])?.token ?? "";
}

export interface ConsoleLanding {
  openUrl: string;
  signedIn: boolean;
  note: string;
}

const SIGN_IN_ONCE = "The console opens signed out, so the person signs in to extension.dev there once; the profile keeps that sign-in.";

/* @invariant THE ONE-TIME CONSOLE HANDOFF NEVER LEAVES THIS PROCESS EXCEPT
 * INTO THE BROWSER IT OPENS. The platform answers POST /api/cli/console-handoff
 * with a single-use address that signs the profile in; it is opened and
 * forgotten, never logged and never put in the answer. A platform without the
 * door (404), a refusal or an address off the platform opens the plain
 * console page, and the answer says the person signs in there once.
 */
export async function consoleLanding(options: { workspace: string; next: string; plainUrl: string; api?: string; fetchImpl: typeof fetch }): Promise<ConsoleLanding> {
  const token = workspaceToken(options.workspace, options.api);
  if (!token) return { openUrl: options.plainUrl, signedIn: false, note: SIGN_IN_ONCE };

  try {
    const res = await withoutRedirects(options.fetchImpl)(`${mcpOrigins(options.api).www}${HANDOFF_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ next: options.next }),
      signal: AbortSignal.timeout(10_000),
    });

    if (res.status === 200) {
      const body: unknown = await res.json().catch(() => null);
      const url = isRow(body) ? approvalPageUrl(text(body.url)) : "";
      if (url) return { openUrl: url, signedIn: true, note: "" };
    }
  } catch {
  }

  return { openUrl: options.plainUrl, signedIn: false, note: SIGN_IN_ONCE };
}

function readBack(workspace: string): string {
  return `extension_workspace {action:"info", workspace:"${workspace}", include:["storeAccounts"]}`;
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
  const base = text(value.storeAccountsUrl);
  if (!workspace || !base) return result;

  const store = Array.isArray(args.browsers) ? args.browsers.map(text).find(Boolean) ?? "" : "";
  const query = store ? `?store=${encodeURIComponent(store)}` : "";
  const plainUrl = `${base}${query}`;
  const answer = { command: parsed.command, value, hint: text(parsed.hint) };

  const block = runtime.launchBlock();
  if (block) return plainAnswer(answer, `No browser was opened: ${block}.`);

  const choice = chooseGuidedBrowser(runtime.probe());
  const label = choice.browser === "chrome" ? "Chrome for Testing" : guidedBrowserLabel(choice.browser);

  if (choice.install) {
    return envelope({
      ok: true,
      command: parsed.command,
      status: WORKSPACE_CONNECT_STATUS,
      value: { ...value, storeAccountsUrl: plainUrl, guidedBrowser: { opened: false, browser: choice.browser, why: choice.why, install: choice.install } },
      hint: `${choice.why} It is not installed: install it with extension_browsers {action:"install", browser:"${choice.install}"}, then call this connect again to open it with extension.dev tools loaded.`,
    });
  }

  const extension: ToolsExtension | { failed: string } = await resolveToolsExtension({
    engine: guidedEngine(choice.browser),
    edge: choice.browser === "edge",
    cacheDir: runtime.cacheDir(),
    fetchImpl: runtime.fetch,
  });

  if ("failed" in extension) return plainAnswer(answer, `No browser was opened: ${extension.failed}.`);

  const next = `${new URL(base).pathname}${query}`;
  const landing = await consoleLanding({ workspace, next, plainUrl, api: text(args.api) || undefined, fetchImpl: runtime.fetch });
  const profileDir = guidedProfileDir(runtime.stateDir(), choice.browser as GuidedBrowser);
  const headless = runtime.headless();
  const launched = runtime.launch({ choice, extensionDir: extension.dir, profileDir, url: landing.openUrl, headless });

  if (!launched.launched) return plainAnswer(answer, `No browser was opened: ${label} did not start (${launched.reason ?? "no reason given"}).`);

  const storeName = store ? storeLabel(store) : "the store";
  const signIn = landing.signedIn ? "" : "sign in to extension.dev once, then ";
  const say = `In the ${label} window that just opened on the ${workspace} Store accounts page, ${signIn}follow the extension.dev tools panel: it takes you to the ${storeName} key page, captures the values when you press it and hands them to the console, so no key passes through this chat. Tell me when the page says connected.`;
  const opened = launched.reused ? "The guided browser already running took the page:" : "Opened";

  return envelope({
    ok: true,
    command: parsed.command,
    status: "workspace-connect-guided",
    value: {
      workspace,
      ...(store ? { store } : {}),
      storeAccountsUrl: plainUrl,
      guidedBrowser: { opened: true, browser: choice.browser, why: choice.why, profile: profileDir, reused: launched.reused, headless },
      toolsExtension: { source: extension.source, version: extension.version, note: extension.note },
      signedIn: landing.signedIn,
      sayToPerson: say,
      nextStep: nextStep("connect", say, plainUrl),
    },
    hint: [
      `${opened} ${choice.why} Profile: ${profileDir}.`,
      extension.source === "bundled" ? extension.note : "",
      landing.note,
      `Tell the person: "${say}" When they say done, call ${readBack(workspace)} and report whether ${storeName} is connected.`,
    ].filter(Boolean).join(" "),
  });
}
