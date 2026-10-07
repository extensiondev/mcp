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

/* @invariant THE LOG IS READ WHERE THE ENGINE WROTE IT. The engine's own
   reader takes the path as given, while the engine writes the file under
   its project root (the package.json that owns the manifest). Every reader
   here that re-exported it unrooted answered "no log events" for a project
   whose manifest sits in a subfolder, and doctor, wait and assert then said
   there were no runtime errors. */
/* @invariant A SENTINEL IS NOT A LOG LINE. The engine's reader hands back
   its `type: "gap"` drop markers beside the events, so assert counted a
   header-plus-sentinel file as "1 event" and a passing timeline. Typed records are kept out of the events and the gaps are
   read on their own. */
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

/* @invariant `level: "off"` is the ONE clause this package does not hand to the
   engine unchanged, and the difference is deliberate, not a bug on either side.

   The engine's matchesLogQuery treats 'off' as a synonym for 'all': its `if
   (minLevel !== 'all' && minLevel !== 'off')` skips the severity comparison
   entirely, so `extension logs --level off` returns every line. extension_logs
   has always meant the opposite by 'off', and its schema documents 'off' as a
   distinct choice next to 'all': logging is disabled, so plain console lines are
   suppressed and only structured dx.signal diagnostics survive. An agent that
   asks for 'off' and receives every console line back would be getting the exact
   inverse of what it asked for.

   The two are reconciled here rather than by editing either side, because 'off'
   and 'all' map cleanly onto clauses the engine already owns: MCP 'off' IS
   {level: 'all', signalsOnly: true}, since 'off' also skips the severity
   threshold. Every other clause (level ranking with log-as-info, the context
   set, the `*` glob over url then hostname with substring fallback, the
   exclusive `since` cursor, the tab match, and the rule that a `type: "header"`
   record is never a log) is now the engine's, so `extension logs` and
   extension_logs cannot answer the same query two different ways. */
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

/* @invariant THE DEV SERVER WRITES context: "background" LINES OF ITS OWN:
   every Log.entryAdded the launcher relays from any extension url or any
   service_worker target, and its extension_load_refused line, carry
   data.channel "browser" (dev-server ingestLog). Only a line without that
   channel was written by the extension's own producer. */
export function isBrowserChannelEvent(event: unknown): boolean {
  const data = (event as { data?: { channel?: unknown } })?.data;

  return data?.channel === "browser";
}

export function browserEventBelongsTo(event: unknown, guestIds: string[]): boolean {
  if (!isBrowserChannelEvent(event)) return true;

  const url = String((event as { url?: unknown })?.url ?? "");

  return guestIds.some((id) => url.startsWith(`chrome-extension://${id}/`));
}
