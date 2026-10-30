// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { setTimeout as sleep } from "node:timers/promises";

export interface NetworkWatchConnection {
  sendCommand(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeoutMs?: number,
  ): Promise<unknown>;
  onEvent(handler: (msg: Record<string, unknown>) => void): () => void;
}

export interface WatchedTarget {
  sessionId: string;
  targetId: string;
  type: string;
  url: string;
  detached: boolean;
}

export interface SeenRequest {
  url: string;
  method: string;
  kind: "request" | "websocket";
  resourceType?: string;
  target: { type: string; url: string };
  initiators: string[];
  at: number;
}

export interface NetworkWatchReading {
  durationMs: number;
  attached: WatchedTarget[];
  requests: SeenRequest[];
  enableErrors: string[];
}

const SESSION_COMMAND_TIMEOUT_MS = 2_000;
const MAX_REQUESTS = 2_000;
const MAX_INITIATORS = 5;

function initiatorUrls(initiator: unknown): string[] {
  if (!initiator || typeof initiator !== "object") return [];

  const found: string[] = [];

  const push = (value: unknown) => {
    if (typeof value === "string" && value && !found.includes(value) && found.length < MAX_INITIATORS) {
      found.push(value);
    }
  };

  const read = initiator as { url?: unknown; stack?: unknown };

  push(read.url);

  let stack = read.stack as { callFrames?: unknown; parent?: unknown } | undefined;
  let depth = 0;

  while (stack && typeof stack === "object" && depth < 8) {
    const frames = Array.isArray(stack.callFrames) ? stack.callFrames : [];

    for (const frame of frames) {
      push((frame as { url?: unknown } | null)?.url);
    }

    stack = stack.parent as typeof stack;
    depth += 1;
  }

  return found;
}

export async function watchNetwork(
  connection: NetworkWatchConnection,
  options: { durationMs: number },
): Promise<NetworkWatchReading> {
  const started = Date.now();
  const attached: WatchedTarget[] = [];
  const bySession = new Map<string, WatchedTarget>();
  const byTarget = new Map<string, WatchedTarget>();
  const requests: SeenRequest[] = [];
  const enableErrors: string[] = [];
  const duplicateSessions: string[] = [];
  const pending: Array<Promise<void>> = [];

  const session = (sessionId: string, params: Record<string, unknown>) =>
    connection.sendCommand(
      params.method as string,
      params.params as Record<string, unknown>,
      sessionId,
      SESSION_COMMAND_TIMEOUT_MS,
    );

  const arm = async (target: WatchedTarget, waitingForDebugger: boolean): Promise<void> => {
    const where = `${target.type} ${target.url || target.targetId}`;

    try {
      await session(target.sessionId, { method: "Network.enable", params: {} });
    } catch (error) {
      enableErrors.push(`${where}: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      await session(target.sessionId, {
        method: "Target.setAutoAttach",
        params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
      });
    } catch {
    }

    if (waitingForDebugger) {
      try {
        await session(target.sessionId, { method: "Runtime.runIfWaitingForDebugger", params: {} });
      } catch {
      }
    }
  };

  const record = (sessionId: string, entry: Omit<SeenRequest, "target" | "at">) => {
    const target = bySession.get(sessionId);
    if (!target || requests.length >= MAX_REQUESTS) return;

    requests.push({
      ...entry,
      target: { type: target.type, url: target.url },
      at: Date.now() - started,
    });
  };

  const unsubscribe = connection.onEvent((msg) => {
    const params = (msg.params ?? {}) as Record<string, unknown>;
    const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : "";

    if (msg.method === "Target.attachedToTarget") {
      const info = (params.targetInfo ?? {}) as Record<string, unknown>;
      const attachedSession = String(params.sessionId ?? "");
      if (!attachedSession || bySession.has(attachedSession)) return;

      const target: WatchedTarget = {
        sessionId: attachedSession,
        targetId: String(info.targetId ?? ""),
        type: String(info.type ?? ""),
        url: String(info.url ?? ""),
        detached: false,
      };

      if (target.targetId && byTarget.has(target.targetId)) {
        duplicateSessions.push(attachedSession);

        return;
      }

      attached.push(target);
      bySession.set(attachedSession, target);
      if (target.targetId) byTarget.set(target.targetId, target);

      pending.push(arm(target, params.waitingForDebugger === true));

      return;
    }

    if (msg.method === "Target.detachedFromTarget") {
      const target = bySession.get(String(params.sessionId ?? ""));
      if (target) target.detached = true;

      return;
    }

    if (msg.method === "Target.targetInfoChanged") {
      const info = (params.targetInfo ?? {}) as Record<string, unknown>;
      const target = byTarget.get(String(info.targetId ?? ""));
      if (target && typeof info.url === "string" && info.url) target.url = info.url;

      return;
    }

    if (!sessionId) return;

    if (msg.method === "Network.requestWillBeSent") {
      const request = (params.request ?? {}) as Record<string, unknown>;

      record(sessionId, {
        url: String(request.url ?? ""),
        method: String(request.method ?? "GET"),
        kind: "request",
        ...(typeof params.type === "string" ? { resourceType: params.type } : {}),
        initiators: initiatorUrls(params.initiator),
      });

      return;
    }

    if (msg.method === "Network.webSocketCreated") {
      record(sessionId, {
        url: String(params.url ?? ""),
        method: "WS",
        kind: "websocket",
        initiators: initiatorUrls(params.initiator),
      });
    }
  });

  try {
    await connection.sendCommand("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });

    await sleep(Math.max(0, options.durationMs));
    await Promise.allSettled(pending);
  } finally {
    unsubscribe();

    try {
      await connection.sendCommand(
        "Target.setAutoAttach",
        { autoAttach: false, waitForDebuggerOnStart: false, flatten: true },
        undefined,
        SESSION_COMMAND_TIMEOUT_MS,
      );
    } catch {
    }

    const held = [
      ...attached.filter((target) => !target.detached).map((target) => target.sessionId),
      ...duplicateSessions,
    ];

    for (const sessionId of held) {
      try {
        await connection.sendCommand(
          "Target.detachFromTarget",
          { sessionId },
          undefined,
          SESSION_COMMAND_TIMEOUT_MS,
        );
      } catch {
      }
    }
  }

  return { durationMs: Date.now() - started, attached, requests, enableErrors };
}

const ON_MACHINE_SCHEMES = new Set([
  "chrome-extension:",
  "moz-extension:",
  "safari-web-extension:",
  "data:",
  "blob:",
  "about:",
  "chrome:",
  "chrome-untrusted:",
  "devtools:",
  "file:",
  "filesystem:",
  "javascript:",
]);

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);

export function urlHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function isOnMachine(url: string): boolean {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (ON_MACHINE_SCHEMES.has(parsed.protocol)) return true;

  const host = parsed.hostname.toLowerCase();

  return LOOPBACK_HOSTS.has(host) || host.endsWith(".localhost") || /^127\.\d+\.\d+\.\d+$/.test(host);
}

export function normalizeAllowHost(entry: string): string {
  let host = entry.trim().toLowerCase();
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  host = host.replace(/^\*\./, "");
  host = host.replace(/[/:].*$/, "");

  return host;
}

export function hostAllowed(url: string, allow: string[]): boolean {
  const host = urlHost(url);
  if (!host) return false;

  return allow.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

export function ownedByExtension(request: SeenRequest, extensionIds: string[]): boolean {
  const prefixes = extensionIds.map((id) => `chrome-extension://${id}/`);
  const owned = (url: string) => prefixes.some((prefix) => url.startsWith(prefix));

  return owned(request.target.url) || request.initiators.some(owned);
}

export interface RequestClassification {
  extensionRequests: SeenRequest[];
  onMachine: SeenRequest[];
  allowed: SeenRequest[];
  outside: SeenRequest[];
  foreign: number;
}

export function classifyRequests(
  requests: SeenRequest[],
  rule: { extensionIds: string[]; allow: string[] },
): RequestClassification {
  const extensionRequests: SeenRequest[] = [];
  const onMachine: SeenRequest[] = [];
  const allowed: SeenRequest[] = [];
  const outside: SeenRequest[] = [];
  let foreign = 0;

  for (const request of requests) {
    if (!ownedByExtension(request, rule.extensionIds)) {
      foreign += 1;
      continue;
    }

    extensionRequests.push(request);

    if (isOnMachine(request.url)) {
      onMachine.push(request);
    } else if (hostAllowed(request.url, rule.allow)) {
      allowed.push(request);
    } else {
      outside.push(request);
    }
  }

  return { extensionRequests, onMachine, allowed, outside, foreign };
}

export function extensionTargets(targets: WatchedTarget[], extensionIds: string[]): WatchedTarget[] {
  const prefixes = extensionIds.map((id) => `chrome-extension://${id}/`);

  return targets.filter((target) => prefixes.some((prefix) => target.url.startsWith(prefix)));
}

export function targetCensus(targets: WatchedTarget[]): string {
  const counts = new Map<string, number>();

  for (const target of targets) {
    counts.set(target.type, (counts.get(target.type) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, count]) => `${count} ${type}`)
    .join(", ");
}
