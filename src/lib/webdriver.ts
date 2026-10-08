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

const SAFARI_LOG_FALLBACK =
  "Without one, the dev session's log file is still read: extension_logs and the log-based assertions see what the extension writes once it is enabled.";

export function webdriverSessionMissingHint(reason: string | null): string {
  if (reason) {
    return `The dev session opened no safaridriver session: ${reason}. Fix that, then restart extension_dev --browser=safari so it opens one. ${SAFARI_LOG_FALLBACK}`;
  }

  return `ready.json records no safaridriver session (webdriverPort and webdriverSessionId) and no reason for its absence. Extension.js 4.1.32 and later open one under extension_dev --browser=safari and say why when they cannot, so an older engine in the project, or a session that is not a dev session, is the likely cause. ${SAFARI_LOG_FALLBACK}`;
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

  const strip = (u: string) => u.replace(/[#?].*$/, "").replace(/\/+$/, "");

  return strip(current) === strip(wanted);
}
