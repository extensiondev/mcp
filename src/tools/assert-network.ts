// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import {
  classifyRequests,
  extensionTargets,
  normalizeAllowHost,
  targetCensus,
  watchNetwork,
  type SeenRequest,
} from "../lib/network-watch";
import { failCheck, inconclusiveCheck, passCheck, type CheckResult } from "../lib/verdict";

import type { Stage } from "./assert";

export const NO_OUTSIDE_REQUESTS = "no-outside-requests";

export const DEFAULT_WATCH_MS = 5_000;
export const MIN_WATCH_MS = 250;
export const MAX_WATCH_MS = 60_000;

const EVIDENCE_REQUESTS = 50;
const DETAIL_REQUESTS = 5;

export interface NoOutsideRequestsClause {
  assert: typeof NO_OUTSIDE_REQUESTS;
  subject: string | null;
  allow: string[];
  durationMs: number;
}

export function parseNoOutsideRequestsClause(
  at: string,
  clause: Record<string, unknown>,
  issues: string[],
): NoOutsideRequestsClause | null {
  const rawAllow =
    clause.allow === undefined ? [] : Array.isArray(clause.allow) ? clause.allow : [clause.allow];
  const allow: string[] = [];

  for (const entry of rawAllow) {
    const host = typeof entry === "string" ? normalizeAllowHost(entry) : "";

    if (!host) {
      issues.push(
        `${at}.allow holds ${JSON.stringify(entry)}; each entry is a host name such as "api.example.com" (a leading "*." or a scheme is dropped)`,
      );

      return null;
    }

    if (!allow.includes(host)) allow.push(host);
  }

  const durationMs = clause.durationMs === undefined ? DEFAULT_WATCH_MS : Number(clause.durationMs);

  if (!Number.isFinite(durationMs) || durationMs < MIN_WATCH_MS || durationMs > MAX_WATCH_MS) {
    issues.push(
      `${at}.durationMs must be a number of milliseconds between ${MIN_WATCH_MS} and ${MAX_WATCH_MS} (default ${DEFAULT_WATCH_MS})`,
    );

    return null;
  }

  return {
    assert: NO_OUTSIDE_REQUESTS,
    subject: allow.length ? allow.join(",") : null,
    allow,
    durationMs,
  };
}

function describeRequest(request: SeenRequest): string {
  const initiator = request.initiators.find((url) => url.startsWith("chrome-extension://"));

  return `${request.method} ${request.url} from ${request.target.type} ${request.target.url || "(no url)"}${
    initiator && initiator !== request.target.url ? ` (initiated by ${initiator})` : ""
  }`;
}

function requestRow(request: SeenRequest): Record<string, unknown> {
  return {
    url: request.url,
    method: request.method,
    kind: request.kind,
    ...(request.resourceType ? { resourceType: request.resourceType } : {}),
    target: request.target,
    ...(request.initiators.length ? { initiators: request.initiators } : {}),
    atMs: request.at,
  };
}

export async function assertNoOutsideRequests(
  clause: NoOutsideRequestsClause,
  stage: Stage,
): Promise<CheckResult> {
  const id = NO_OUTSIDE_REQUESTS;
  const subject = clause.subject;

  if (!stage.chromium) {
    return stage.notChromium(
      id,
      subject,
      `Run the session on a Chromium browser, where this check attaches to every target of the extension over the debug port; on ${stage.browser} read the traffic in the browser's own network panel.`,
    );
  }

  const targets = await stage.targets();
  if (targets === null) return stage.noSession(id, subject);

  const extensionId = await stage.extensionId();

  if (!extensionId) {
    return inconclusiveCheck(
      id,
      subject,
      "The extension's id could not be resolved from the running session, so no request could be attributed to it.",
      "Start the session with extension_dev, confirm it with extension_wait, then assert again.",
    );
  }

  const connection = await stage.connection();

  if (!connection) {
    return inconclusiveCheck(
      id,
      subject,
      "The browser's debug port is listed but this server could not open a DevTools connection to it, so no target was watched.",
      "Start the session with extension_dev, confirm it with extension_wait, then assert again.",
    );
  }

  let reading: Awaited<ReturnType<typeof watchNetwork>>;

  try {
    reading = await watchNetwork(connection, { durationMs: clause.durationMs });
  } catch (error) {
    return inconclusiveCheck(
      id,
      subject,
      `The browser refused the watch before it started (${error instanceof Error ? error.message : String(error)}), so no request was observed.`,
      "Assert again; if it repeats, extension_doctor says what the debug port is doing.",
    );
  }

  const watched = extensionTargets(reading.attached, [extensionId]);
  const census = targetCensus(watched);
  const classified = classifyRequests(reading.requests, { extensionIds: [extensionId], allow: clause.allow });
  const window = `${reading.durationMs} ms`;
  const evidence = {
    durationMs: reading.durationMs,
    watched: watched.map((target) => ({ type: target.type, url: target.url })),
    requests: classified.extensionRequests.slice(0, EVIDENCE_REQUESTS).map(requestRow),
    outside: classified.outside.slice(0, EVIDENCE_REQUESTS).map(requestRow),
    allowed: classified.allowed.length,
    onMachine: classified.onMachine.length,
    foreign: classified.foreign,
    ...(reading.enableErrors.length ? { enableErrors: reading.enableErrors } : {}),
  };

  if (classified.outside.length > 0) {
    const shown = classified.outside.slice(0, DETAIL_REQUESTS).map(describeRequest);
    const more = classified.outside.length - shown.length;

    return failCheck(
      id,
      subject,
      `${classified.outside.length} request(s) left the machine from the extension's own contexts in ${window}: ${shown.join("; ")}${
        more > 0 ? `; and ${more} more` : ""
      }.${clause.allow.length ? ` Allowed hosts were ${clause.allow.join(", ")}.` : ""}`,
      evidence,
    );
  }

  if (watched.length === 0) {
    return inconclusiveCheck(
      id,
      subject,
      `No context of the extension (chrome-extension://${extensionId}/) was alive during the ${window} watch${
        reading.attached.length ? ` (the browser attached ${targetCensus(reading.attached)}, none of them the extension's)` : ""
      }, so there was nothing to observe and "no request" would only mean "nothing ran".`,
      "Wake the extension first (extension_open on a surface, or open a page its content script matches) and assert again, with a longer durationMs if its work starts later.",
      evidence,
    );
  }

  if (reading.enableErrors.length > 0) {
    return inconclusiveCheck(
      id,
      subject,
      `No request left the machine from the ${watched.length} watched context(s) of the extension in ${window}, but ${reading.enableErrors.length} attached target(s) refused network events (${reading.enableErrors
        .slice(0, 3)
        .join("; ")}), so a request from one of those would not have been seen.`,
      "Assert again; a target that refuses Network.enable twice is named in the evidence, and extension_eval in that context can read what it fetches.",
      evidence,
    );
  }

  const seen = classified.extensionRequests.length;

  return passCheck(
    id,
    subject,
    `No request left the machine from ${watched.length} context(s) of the extension (${census}) in ${window}: ${
      seen === 0
        ? "none of them sent anything"
        : `${seen} request(s) seen, ${classified.onMachine.length} to the extension itself, loopback or data URLs${
            classified.allowed.length
              ? ` and ${classified.allowed.length} to the allowed host(s) ${clause.allow.join(", ")}`
              : ""
          }`
    }.${
      classified.foreign ? ` ${classified.foreign} request(s) by other pages and extensions were not counted.` : ""
    } Requests before the watch began were not observed.`,
    evidence,
  );
}
