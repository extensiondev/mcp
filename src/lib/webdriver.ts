// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import { readyContractPath } from "./session-paths";
import type { ReadyContract } from "./types";

export const WEBDRIVER_SESSION_MISSING_HINT =
  "A Safari session is readable only through the automation window extension_dev opens (Extension.js with Safari live reload, Safari 27 or Safari Technology Preview 247, and Safari > Settings > Developer > \"Allow remote automation and external agents\" on). Safari grants one automation session at a time, so this server never opens its own; start extension_dev --browser=safari, wait for ready, and retry.";

export interface WebDriverSessionInfo {
  port: number;
  sessionId: string;
}

export function readWebDriverSession(
  projectPath: string,
  browser: string,
): WebDriverSessionInfo | null {
  try {
    const contract = JSON.parse(
      fs.readFileSync(readyContractPath(projectPath, browser), "utf8"),
    ) as ReadyContract;
    if (
      typeof contract.webdriverPort === "number" &&
      Number.isFinite(contract.webdriverPort) &&
      typeof contract.webdriverSessionId === "string" &&
      contract.webdriverSessionId.length > 0
    ) {
      return {
        port: contract.webdriverPort,
        sessionId: contract.webdriverSessionId,
      };
    }
  } catch {
    return null;
  }
  return null;
}

// Safari's dev session stamps the appex identifier (<bundle id>.Extension)
// into ready.json, and an Extension.js content script writes that same id
// into the owner attribute of every root it mounts.
export function readyExtensionId(
  projectPath: string,
  browser: string,
): string | null {
  try {
    const contract = JSON.parse(
      fs.readFileSync(readyContractPath(projectPath, browser), "utf8"),
    ) as ReadyContract & { extensionId?: string };
    const id = String(contract.extensionId || "").trim();
    return id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

type DriverReply = { value?: unknown };

export class WebDriverClient {
  private readonly base: string;

  constructor(
    readonly info: WebDriverSessionInfo,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.base = `http://127.0.0.1:${info.port}/session/${info.sessionId}`;
  }

  private async call(
    method: "GET" | "POST",
    route: string,
    body?: unknown,
    timeoutMs = 15_000,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchFn(`${this.base}${route}`, {
        method,
        headers: { "content-type": "application/json" },
        body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed: DriverReply = {};
      try {
        parsed = text ? (JSON.parse(text) as DriverReply) : {};
      } catch {
        parsed = { value: { message: text } };
      }
      if (!response.ok) {
        const value = (parsed.value || {}) as {
          message?: string;
          error?: string;
        };
        throw new Error(
          String(
            value.message || value.error || `${response.status} on ${route}`,
          ),
        );
      }
      return parsed.value;
    } finally {
      clearTimeout(timer);
    }
  }

  async alive(): Promise<boolean> {
    try {
      await this.call("GET", "/url");
      return true;
    } catch {
      return false;
    }
  }

  async currentUrl(): Promise<string | null> {
    const value = await this.call("GET", "/url");
    return typeof value === "string" ? value : null;
  }

  async navigate(url: string, timeoutMs = 60_000): Promise<void> {
    await this.call("POST", "/url", { url }, timeoutMs);
  }

  async refresh(timeoutMs = 60_000): Promise<void> {
    await this.call("POST", "/refresh", {}, timeoutMs);
  }

  // Runs a function body in the page's main world. WebDriver's execute has
  // no reach into an extension's isolated world or any extension page, so
  // what it returns is what the page and the DOM show.
  async execute(
    script: string,
    args: unknown[] = [],
    timeoutMs = 30_000,
  ): Promise<unknown> {
    return this.call("POST", "/execute/sync", { script, args }, timeoutMs);
  }
}

export interface ExtensionRootReading {
  roots: number;
  owners: string[];
  url: string;
  title: string;
}

/* @invariant The reading is the DOM the page shows, taken from the main
 * world, which is the one place a Safari automation session can look. An
 * Extension.js content script stamps every root it mounts with the owner
 * attribute, so a root whose owner names this extension's id is evidence the
 * script ran; a page with no root says nothing about the script, and the
 * caller must say so instead of turning silence into a verdict.
 */
export const EXTENSION_ROOT_READING_SCRIPT = `
  const nodes = Array.from(document.querySelectorAll('#extension-root,[data-extension-root]'));
  return {
    roots: nodes.length,
    owners: nodes.map((n) => String(n.getAttribute('data-extjs-reinject-owner') || '')),
    url: String(location.href),
    title: String(document.title || '')
  };
`;

export async function readExtensionRoots(
  client: WebDriverClient,
): Promise<ExtensionRootReading> {
  const value = (await client.execute(EXTENSION_ROOT_READING_SCRIPT)) as
    | Partial<ExtensionRootReading>
    | null;
  return {
    roots: typeof value?.roots === "number" ? value.roots : 0,
    owners: Array.isArray(value?.owners)
      ? value.owners.map((o) => String(o))
      : [],
    url: String(value?.url || ""),
    title: String(value?.title || ""),
  };
}

export function sameDocument(current: string | null, wanted: string): boolean {
  if (!current) return false;
  const strip = (u: string) => u.replace(/[#?].*$/, "").replace(/\/+$/, "");
  return strip(current) === strip(wanted);
}
