// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import path from "node:path";

import { noteCallWait } from "./call-waits";
import { resolveSessionBrowser } from "./session-browser";

interface SessionLane {
  tail: Promise<void>;
  last: string;
  depth: number;
}

const lanes = new Map<string, SessionLane>();

export function sessionLaneKey(args: Record<string, unknown>): string | null {
  const projectPath = typeof args.projectPath === "string" ? args.projectPath.trim() : "";
  if (!projectPath) return null;

  const explicit = typeof args.browser === "string" && args.browser.trim() ? args.browser.trim() : undefined;
  const { browser } = resolveSessionBrowser(projectPath, explicit);

  return `${path.resolve(projectPath)}\u0000${browser}`;
}

export function waitedForCallAhead(ms: number, ahead: string): string {
  const took = ms < 1_000 ? `${ms} ms` : `${(ms / 1_000).toFixed(1)} s`;

  return `This call waited ${took} for the ${ahead} call ahead of it on the same session to finish before it ran; calls on one session run in the order they arrive.`;
}

export async function inSessionOrder<T>(key: string | null, name: string, call: () => Promise<T>): Promise<T> {
  if (!key) return call();

  let lane = lanes.get(key);

  if (!lane) {
    lane = { tail: Promise.resolve(), last: "", depth: 0 };
    lanes.set(key, lane);
  }

  const ahead = lane.depth > 0 ? lane.last : null;
  const turn = lane.tail;
  let release: () => void = () => undefined;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });

  lane.tail = turn.then(() => mine);
  lane.last = name;
  lane.depth += 1;

  const queued = Date.now();

  try {
    await turn;

    if (ahead) noteCallWait(waitedForCallAhead(Date.now() - queued, ahead));

    return await call();
  } finally {
    release();
    lane.depth -= 1;
    if (lane.depth === 0 && lanes.get(key) === lane) lanes.delete(key);
  }
}
