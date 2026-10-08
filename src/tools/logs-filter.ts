// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import {
  matchesLogQuery,
  readLogEvents as engineReadLogEvents,
  type LogQuery,
} from "extension-develop/bridge";

import { engineProjectRoot } from "../lib/session-paths";

export { type LogQuery };

export function readLogEvents(
  projectPath: string,
  browser: string,
  query: LogQuery,
): ReturnType<typeof engineReadLogEvents> {
  return engineReadLogEvents(engineProjectRoot(projectPath), browser, query).filter(
    (event) => typeof (event as { type?: unknown }).type !== "string",
  ) as ReturnType<typeof engineReadLogEvents>;
}

export function readLogDropped(projectPath: string, browser: string): number {
  return engineReadLogEvents(engineProjectRoot(projectPath), browser, {}).reduce((sum, event) => {
    const record = event as { type?: unknown; dropped?: unknown };

    return record.type === "gap" && typeof record.dropped === "number" ? sum + record.dropped : sum;
  }, 0);
}

export interface LogsArgs {
  projectPath: string;
  browser?: string;
  level?: string;
  context?: string[] | string;
  signalsOnly?: boolean;
  since?: number;
  url?: string;
  tab?: number;
  follow?: boolean;
  followMs?: number;
  limit?: number;
}

export function makeFilter(args: LogsArgs): (event: unknown) => boolean {
  const level = String(args.level || "all").toLowerCase();
  const loggingOff = level === "off";
  const query = {
    context: args.context,
    level: loggingOff ? "all" : level,
    signalsOnly: Boolean(args.signalsOnly) || loggingOff,
    since: args.since,
    url: args.url,
    tab: args.tab,
  };

  return (event: unknown): boolean => matchesLogQuery(event as never, query);
}

export function isBrowserChannelEvent(event: unknown): boolean {
  const data = (event as { data?: { channel?: unknown } })?.data;

  return data?.channel === "browser";
}

export function browserEventBelongsTo(event: unknown, guestIds: string[]): boolean {
  if (!isBrowserChannelEvent(event)) return true;

  const url = String((event as { url?: unknown })?.url ?? "");

  return guestIds.some((id) => url.startsWith(`chrome-extension://${id}/`));
}
