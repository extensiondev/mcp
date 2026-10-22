// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";

import { matchPatternCovers } from "./match-patterns";
import { readyContractPath } from "./session-paths";

import type { ReadyContract } from "./types";

const SAFARI_LOG_FALLBACK =
  "Without one, the dev session's log file is still read: extension_logs and the log-based assertions see what the extension writes once it is enabled.";

export function webdriverSessionMissingHint(reason: string | null): string {
  if (reason) {
    return `The dev session opened no safaridriver session: ${reason}. Fix that, then restart extension_dev --browser=safari so it opens one. ${SAFARI_LOG_FALLBACK}`;
  }

  return `ready.json records no safaridriver session (webdriverPort and webdriverSessionId) and no reason for its absence. The engine's Safari launcher stamps the session, or why it opened none, only once it reaches its WebDriver step: after the app opens and the extension is enabled, and the session request alone waits up to 30 s. A contract with neither means that step has not concluded yet, or the launcher never reached it (an enable step that is still waiting, a session that is not a dev session, or an engine older than Extension.js 4.1.32). extension_logs shows the launcher's last line; call again in 30 s, and a run that stays without either needs extension_dev again with replace: true. ${SAFARI_LOG_FALLBACK}`;
}

export function readWebDriverUnavailableReason(
  projectPath: string,
  browser: string,
): string | null {
  try {
    const contract = JSON.parse(
      fs.readFileSync(readyContractPath(projectPath, browser), "utf8"),
    ) as ReadyContract;
    const reason = String(contract.webdriverUnavailableReason ?? "").trim();

    return reason.length > 0 ? reason : null;
  } catch {
    return null;
  }
}

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

export class WebDriverError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = "WebDriverError";
  }
}

export type WebDriverLiveness = "alive" | "session-ended" | "unreachable";

export function webdriverSessionEnded(error: unknown): boolean {
  return error instanceof WebDriverError && error.code === "invalid session id";
}

export function webdriverSessionEndedMessage(
  info: WebDriverSessionInfo,
  browser: string,
): string {
  return `safaridriver on port ${info.port} answered that the dev session's WebDriver session ${info.sessionId} is no longer valid ("invalid session id"). Safari ends an automation session when someone interacts with its automation window (a click or a keystroke there, such as reaching Settings from it), or when that window or Safari closes. The dev server and the extension can still be running, and extension_logs still reads what the extension logs, but every read that goes through that session (extension_eval context "page", extension_open url, extension_dom_snapshot, the content-script assertions) cannot reach the ${browser} window until the session is opened again.`;
}

export function webdriverSessionEndedHint(browser: string): string {
  return `The session ended; the dev server did not, and the engine opens one WebDriver session per dev run. Call extension_dev again with browser: "${browser}", replace: true and enableExtension: true (plus allowEval: true for extension_eval): replace stops this run first, and enableExtension lets Extension.js turn the extension on through Safari Settings itself (one-time macOS Accessibility grant for the terminal app that runs this server), so the new automation window needs no Settings trip and stays driveable. To change Safari settings while a session runs, use a regular Safari window, not the automation window; a page opened in a regular window is outside the session and cannot be read from here.`;
}

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

        throw new WebDriverError(
          String(
            value.message || value.error || `${response.status} on ${route}`,
          ),
          typeof value.error === "string" ? value.error : null,
          response.status,
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

  async liveness(timeoutMs = 3_000): Promise<WebDriverLiveness> {
    try {
      await this.call("GET", "/url", undefined, timeoutMs);

      return "alive";
    } catch (error) {
      if (webdriverSessionEnded(error)) return "session-ended";

      return error instanceof WebDriverError ? "alive" : "unreachable";
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

  async screenshot(timeoutMs = 30_000): Promise<Buffer | null> {
    const value = await this.call("GET", "/screenshot", undefined, timeoutMs);

    return typeof value === "string" && value ? Buffer.from(value, "base64") : null;
  }

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

  const strip = (u: string) =>
    (wanted.includes("#") ? u : u.replace(/[#?].*$/, "")).replace(/\/+$/, "");

  return strip(current) === strip(wanted);
}

const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:\/\//i;
const OPAQUE_URL = /^(about|data|blob|javascript):/i;
const LOOPBACK_OR_ADDRESS = /^(localhost|.+\.localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:.]+\])$/i;

export function pageMatchesUrl(current: string | null, wanted: string): boolean {
  if (!current) return false;

  const needle = wanted.trim();
  if (!needle) return false;

  return (
    sameDocument(current, needle) ||
    matchPatternCovers(needle, current) ||
    current.toLowerCase().includes(needle.toLowerCase())
  );
}

export function navigableUrl(wanted: string): string | null {
  const trimmed = wanted.trim();

  if (!trimmed || trimmed.includes("*") || /\s/.test(trimmed) || trimmed === "<all_urls>") return null;

  if (ABSOLUTE_URL.test(trimmed) || OPAQUE_URL.test(trimmed)) {
    try {
      return new URL(trimmed).href ? trimmed : null;
    } catch {
      return null;
    }
  }

  const authority = trimmed.split(/[/?#]/)[0];
  const port = /:(\d+)$/.exec(authority);
  const hostname = port ? authority.slice(0, -port[0].length) : authority;

  if (!hostname || (!port && !hostname.includes(".") && hostname !== "localhost")) return null;

  const scheme = port || LOOPBACK_OR_ADDRESS.test(hostname) ? "http" : "https";

  try {
    return new URL(`${scheme}://${trimmed}`).href;
  } catch {
    return null;
  }
}
