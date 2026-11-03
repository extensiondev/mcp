// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";

import { browserDisplayName, type CaptureBrowser, type CapturedIn } from "./browser-captures";
import { CDPClient } from "./cdp";
import { RdpSession } from "./rdp";
import { readyContractPath } from "./session-paths";

import type { ReadyContract } from "./types";
import type { WebDriverClient } from "./webdriver";

const PRODUCT = /^[A-Za-z]+\/(\d[\w.]*)/;
const UA_VERSION = /\bVersion\/(\d[\w.]*)/;

function version(browser: CaptureBrowser, raw: unknown): CapturedIn | null {
  const text = typeof raw === "string" ? raw.trim() : "";
  const parsed = /^\d/.test(text) ? text : (PRODUCT.exec(text)?.[1] ?? "");

  return parsed ? { name: browserDisplayName(browser), version: parsed } : null;
}

/* @invariant THE BROWSER THAT MADE A CAPTURE IS READ FROM THE LIVE SESSION,
 * NEVER GUESSED FROM THE BINARY NAME. The version lands on the public build
 * page as "captured in Chrome 142", so it comes from the running browser's
 * own answer: Browser.getVersion over the browser-level CDP socket (the
 * /json/version Browser field when that socket refuses), the device actor's
 * getDescription on Firefox's debugger server (the ready contract's
 * browserVersion when the engine stamps one), and safaridriver's session
 * capabilities (the automation window's own user agent when the session
 * read refuses). A read that fails leaves capturedIn out rather than
 * inventing one. */
export async function capturedInChromium(port: number, browser: CaptureBrowser, timeoutMs: number): Promise<CapturedIn | null> {
  const client = new CDPClient();

  try {
    await client.connect(await CDPClient.discoverBrowserWsUrl(port));
    const answer = (await client.sendCommand("Browser.getVersion", {}, undefined, timeoutMs)) as { product?: unknown } | null;
    const read = version(browser, answer?.product);
    if (read) return read;
  } catch {
    void 0;
  } finally {
    client.disconnect();
  }

  return version(browser, await CDPClient.discoverBrowserVersion(port));
}

function contractBrowserVersion(projectPath: string, browser: CaptureBrowser): CapturedIn | null {
  try {
    const contract = JSON.parse(fs.readFileSync(readyContractPath(projectPath, browser), "utf8")) as ReadyContract & { browserVersion?: unknown };

    return version(browser, contract.browserVersion);
  } catch {
    return null;
  }
}

export async function capturedInGecko(port: number, browser: CaptureBrowser, projectPath: string, timeoutMs: number): Promise<CapturedIn | null> {
  let session: RdpSession | null = null;

  try {
    session = await RdpSession.connect(port, timeoutMs);
    const root = await session.request("root", { type: "getRoot" }, timeoutMs);
    const device = typeof root.deviceActor === "string" ? root.deviceActor : "";

    if (device) {
      const described = await session.request(device, { type: "getDescription" }, timeoutMs);
      const value = (described.value ?? {}) as { version?: unknown };
      const read = version(browser, value.version);
      if (read) return read;
    }
  } catch {
    void 0;
  } finally {
    session?.close();
  }

  return contractBrowserVersion(projectPath, browser);
}

export async function capturedInWebKit(client: WebDriverClient, browser: CaptureBrowser, timeoutMs: number): Promise<CapturedIn | null> {
  try {
    const session = (await client.capabilities(timeoutMs)) as { browserVersion?: unknown; capabilities?: { browserVersion?: unknown } } | null;
    const read = version(browser, session?.capabilities?.browserVersion ?? session?.browserVersion);
    if (read) return read;
  } catch {
    void 0;
  }

  try {
    const agent = await client.execute("return navigator.userAgent;", [], timeoutMs);

    return version(browser, UA_VERSION.exec(typeof agent === "string" ? agent : "")?.[1]);
  } catch {
    return null;
  }
}
