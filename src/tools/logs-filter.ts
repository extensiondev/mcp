// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import {
  matchesLogQuery,
  readLogEvents,
  type LogQuery,
} from "extension-develop/bridge";

export { readLogEvents, type LogQuery };

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
