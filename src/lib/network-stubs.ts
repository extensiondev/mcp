// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import path from "node:path";

import { CDPClient } from "./cdp";

export interface StubLink {
  sendCommand(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeoutMs?: number,
  ): Promise<unknown>;
  onEvent(handler: (msg: Record<string, unknown>) => void): () => void;
  onClose(handler: () => void): void;
  disconnect(): void;
}

export interface StubRule {
  id: string;
  method: string;
  url: string;
  status: number;
  body: string;
  contentType: string;
  headers: Record<string, string>;
  hits: number;
}

export interface StubRequest {
  url: string;
  method: string;
  target: { type: string; url: string };
  ruleId: string | null;
  at: number;
}

export interface StubRuleInput {
  id?: unknown;
  method?: unknown;
  url?: unknown;
  status?: unknown;
  body?: unknown;
  json?: unknown;
  contentType?: unknown;
  headers?: unknown;
}

const SESSION_COMMAND_TIMEOUT_MS = 2_000;
const MAX_REQUESTS = 500;
const ANY_METHOD = "ANY";
const CORS_HEADER = "access-control-allow-origin";

export const stubLinks = {
  open: async (port: number): Promise<StubLink> => {
    const ws = await CDPClient.discoverBrowserWsUrl(port);
    const client = new CDPClient();
    await client.connect(ws);

    return client;
  },
};

export function patternMatches(pattern: string, url: string): boolean {
  if (!/[*?]/.test(pattern)) return pattern === url;

  const source = pattern
    .split(/([*?])/)
    .map((part) => (part === "*" ? ".*" : part === "?" ? "." : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("");

  return new RegExp(`^${source}$`).test(url);
}

export function ruleMatches(rule: StubRule, method: string, url: string): boolean {
  return (rule.method === ANY_METHOD || rule.method === method.toUpperCase()) && patternMatches(rule.url, url);
}

export function parseStubRule(
  input: StubRuleInput,
  taken: string[],
): { rule: StubRule } | { problem: string } {
  const url = typeof input.url === "string" ? input.url.trim() : "";
  if (!url) return { problem: 'url is required: the exact URL to answer, or a glob with * and ? such as "https://api.example.com/*".' };

  const method = input.method === undefined ? ANY_METHOD : String(input.method).trim().toUpperCase();
  if (!/^[A-Z]+$/.test(method)) return { problem: `method must be an HTTP method such as GET or POST, or ANY; got ${JSON.stringify(input.method)}.` };

  const status = input.status === undefined ? 200 : Number(input.status);
  if (!Number.isInteger(status) || status < 100 || status > 599) return { problem: `status must be an integer HTTP status from 100 to 599; got ${JSON.stringify(input.status)}.` };

  if (input.body !== undefined && input.json !== undefined) return { problem: "Pass body (text) or json (a JSON value), not both." };

  if (input.body !== undefined && typeof input.body !== "string") return { problem: "body is the response text; for a JSON value pass json instead." };

  const body = input.json !== undefined ? JSON.stringify(input.json) : (input.body as string | undefined) ?? "";
  const contentType =
    typeof input.contentType === "string" && input.contentType.trim()
      ? input.contentType.trim()
      : input.json !== undefined
        ? "application/json"
        : "text/plain";

  const headers: Record<string, string> = {};

  if (input.headers !== undefined) {
    if (!input.headers || typeof input.headers !== "object" || Array.isArray(input.headers)) return { problem: "headers is an object of header name to string value." };

    for (const [name, value] of Object.entries(input.headers as Record<string, unknown>)) {
      if (typeof value !== "string") return { problem: `headers.${name} must be a string.` };

      headers[name] = value;
    }
  }

  let id = typeof input.id === "string" ? input.id.trim() : "";

  if (id && taken.includes(id)) return { problem: `A rule with id ${JSON.stringify(id)} is already live; clear the rules or pick another id.` };

  if (!id) {
    for (let n = taken.length + 1; !id || taken.includes(id); n += 1) id = `stub-${n}`;
  }

  return { rule: { id, method, url, status, body, contentType, headers, hits: 0 } };
}

export function describeRule(rule: StubRule): string {
  return `${rule.id}: ${rule.method === ANY_METHOD ? "any method on" : rule.method} ${rule.url} answers ${rule.status} ${rule.contentType}${rule.body ? ` (${rule.body.length} characters)` : " with an empty body"}`;
}

function responseHeaders(rule: StubRule): Array<{ name: string; value: string }> {
  const sent = Object.entries(rule.headers).map(([name, value]) => ({ name, value }));
  const names = new Set(sent.map((header) => header.name.toLowerCase()));

  if (!names.has("content-type")) sent.unshift({ name: "Content-Type", value: rule.contentType });
  if (!names.has(CORS_HEADER)) sent.push({ name: "Access-Control-Allow-Origin", value: "*" });

  return sent;
}

export class StubSession {
  readonly rules: StubRule[] = [];
  readonly requests: StubRequest[] = [];
  readonly enableErrors: string[] = [];
  readonly startedAt = Date.now();
  private readonly targets = new Map<string, { type: string; url: string }>();
  private readonly seen = new Set<string>();
  private unsubscribe: (() => void) | null = null;
  private closed = false;

  constructor(
    readonly projectPath: string,
    readonly browser: string,
    private readonly link: StubLink,
    private readonly onGone: () => void,
  ) {}

  get live(): boolean {
    return !this.closed;
  }

  async start(): Promise<void> {
    this.unsubscribe = this.link.onEvent((msg) => {
      void this.handle(msg);
    });

    this.link.onClose(() => this.gone());
    await this.link.sendCommand("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
  }

  private gone(): void {
    if (this.closed) return;

    this.closed = true;
    this.unsubscribe?.();
    this.onGone();
  }

  private session(sessionId: string, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return this.link.sendCommand(method, params, sessionId, SESSION_COMMAND_TIMEOUT_MS);
  }

  private fetchPatterns(): Array<{ urlPattern: string; requestStage: "Request" }> {
    const patterns = [...new Set(this.rules.map((rule) => rule.url))];

    return patterns.map((urlPattern) => ({ urlPattern, requestStage: "Request" as const }));
  }

  private async armFetch(sessionId: string, where: string): Promise<void> {
    try {
      if (this.rules.length) {
        await this.session(sessionId, "Fetch.enable", { patterns: this.fetchPatterns() });
      } else {
        await this.session(sessionId, "Fetch.disable");
      }
    } catch (error) {
      this.enableErrors.push(`${where}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async arm(sessionId: string, waiting: boolean): Promise<void> {
    const target = this.targets.get(sessionId);
    const where = `${target?.type ?? "target"} ${target?.url || sessionId}`;

    try {
      await this.session(sessionId, "Network.enable");
    } catch (error) {
      this.enableErrors.push(`${where}: ${error instanceof Error ? error.message : String(error)}`);
    }

    await this.armFetch(sessionId, where);

    try {
      await this.session(sessionId, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    } catch {
    }

    if (waiting) {
      try {
        await this.session(sessionId, "Runtime.runIfWaitingForDebugger");
      } catch {
      }
    }
  }

  private record(sessionId: string, key: string, method: string, url: string, ruleId: string | null): void {
    if (this.seen.has(key) || this.requests.length >= MAX_REQUESTS) return;

    this.seen.add(key);
    const target = this.targets.get(sessionId) ?? { type: "unknown", url: "" };
    this.requests.push({ url, method, target: { ...target }, ruleId, at: Date.now() - this.startedAt });
  }

  private async handle(msg: Record<string, unknown>): Promise<void> {
    const params = (msg.params ?? {}) as Record<string, unknown>;
    const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : "";

    if (msg.method === "Target.attachedToTarget") {
      const info = (params.targetInfo ?? {}) as Record<string, unknown>;
      const attached = String(params.sessionId ?? "");
      if (!attached || this.targets.has(attached)) return;

      this.targets.set(attached, { type: String(info.type ?? ""), url: String(info.url ?? "") });
      await this.arm(attached, params.waitingForDebugger === true);

      return;
    }

    if (msg.method === "Target.detachedFromTarget") {
      this.targets.delete(String(params.sessionId ?? ""));

      return;
    }

    if (msg.method === "Target.targetInfoChanged") {
      const info = (params.targetInfo ?? {}) as Record<string, unknown>;

      for (const target of this.targets.values()) {
        if (target.url === "" && typeof info.url === "string") target.url = info.url;
      }

      return;
    }

    if (!sessionId) return;

    if (msg.method === "Network.requestWillBeSent") {
      const request = (params.request ?? {}) as Record<string, unknown>;
      const url = String(request.url ?? "");
      const method = String(request.method ?? "GET");
      const rule = this.rules.find((candidate) => ruleMatches(candidate, method, url));
      this.record(sessionId, `n:${String(params.requestId ?? url)}`, method, url, rule?.id ?? null);

      return;
    }

    if (msg.method === "Fetch.requestPaused") {
      const request = (params.request ?? {}) as Record<string, unknown>;
      const url = String(request.url ?? "");
      const method = String(request.method ?? "GET");
      const requestId = String(params.requestId ?? "");
      const rule = this.rules.find((candidate) => ruleMatches(candidate, method, url));
      const key = typeof params.networkId === "string" ? `n:${params.networkId}` : `f:${requestId}`;
      this.record(sessionId, key, method, url, rule?.id ?? null);

      try {
        if (rule) {
          rule.hits += 1;
          await this.session(sessionId, "Fetch.fulfillRequest", {
            requestId,
            responseCode: rule.status,
            responseHeaders: responseHeaders(rule),
            body: Buffer.from(rule.body, "utf8").toString("base64"),
          });
        } else {
          await this.session(sessionId, "Fetch.continueRequest", { requestId });
        }
      } catch (error) {
        this.enableErrors.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  async add(rule: StubRule): Promise<void> {
    this.rules.push(rule);
    await this.rearm();
  }

  async clear(): Promise<number> {
    const cleared = this.rules.length;
    this.rules.splice(0);
    this.requests.splice(0);
    this.seen.clear();
    await this.rearm();

    return cleared;
  }

  private async rearm(): Promise<void> {
    for (const [sessionId, target] of this.targets) {
      await this.armFetch(sessionId, `${target.type} ${target.url || sessionId}`);
    }
  }

  dispose(): void {
    this.closed = true;
    this.unsubscribe?.();

    try {
      this.link.disconnect();
    } catch {
    }
  }
}

const live = new Map<string, StubSession>();

function keyOf(projectPath: string, browser: string): string {
  return `${path.resolve(projectPath)}::${browser}`;
}

export function liveNetworkStubs(projectPath?: string, browser?: string): StubSession[] {
  const found: StubSession[] = [];

  for (const session of live.values()) {
    if (!session.live) continue;
    if (projectPath && path.resolve(session.projectPath) !== path.resolve(projectPath)) continue;
    if (browser && session.browser !== browser) continue;

    found.push(session);
  }

  return found;
}

export async function openNetworkStubs(projectPath: string, browser: string, port: number): Promise<StubSession> {
  const key = keyOf(projectPath, browser);
  const current = live.get(key);
  if (current?.live) return current;

  const link = await stubLinks.open(port);
  const session = new StubSession(projectPath, browser, link, () => {
    if (live.get(key) === session) live.delete(key);
  });

  try {
    await session.start();
  } catch (error) {
    session.dispose();

    throw error;
  }

  live.set(key, session);

  return session;
}

export function dropNetworkStubs(projectPath: string, browser: string): number {
  const key = keyOf(projectPath, browser);
  const session = live.get(key);
  if (!session) return 0;

  const rules = session.rules.length;
  session.dispose();
  live.delete(key);

  return rules;
}

export const STUBBED_READERS: ReadonlySet<string> = new Set([
  "extension_inspect",
  "extension_dom_snapshot",
  "extension_screenshot",
  "extension_eval",
  "extension_assert",
  "extension_logs",
  "extension_storage",
  "extension_open",
  "extension_reload",
  "extension_list_extensions",
]);

export function stubbedReadWarning(name: string, args: Record<string, unknown>): string | undefined {
  if (!STUBBED_READERS.has(name)) return undefined;

  const projectPath = typeof args.projectPath === "string" && args.projectPath ? args.projectPath : undefined;
  const browser = typeof args.browser === "string" && args.browser ? args.browser : undefined;
  const sessions = liveNetworkStubs(projectPath, browser).filter((session) => session.rules.length > 0);
  if (sessions.length === 0) return undefined;

  const rules = sessions.reduce((sum, session) => sum + session.rules.length, 0);
  const hits = sessions.reduce((sum, session) => sum + session.rules.reduce((inner, rule) => inner + rule.hits, 0), 0);
  const browsers = [...new Set(sessions.map((session) => session.browser))].join(", ");

  return `${rules} network stub rule(s) from extension_network are live on the ${browsers} session (${hits} request(s) answered by them so far), so what this read shows may come from a stub, not the real server. extension_network {action: "requests"} says which requests hit one; {action: "clear"} takes them down.`;
}
