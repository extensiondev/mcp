// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";

import { envelope } from "./envelope";
import { logsPath } from "./session-paths";

const SAFARI_BASE = /safari-web-extension:\/\/([0-9A-Za-z-]{8,64})\//g;

function lastSafariBase(text: string): string | null {
  let found: string | null = null;

  for (const match of text.matchAll(SAFARI_BASE)) found = match[1] ?? found;

  return found ? `safari-web-extension://${found}/` : null;
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

export function readSafariBaseUrlFromLogs(projectPath: string, browser: string): string | null {
  const current = logsPath(projectPath, browser);

  return lastSafariBase(readText(current)) ?? lastSafariBase(readText(current.replace(/\.ndjson$/, ".1.ndjson")));
}

export function safariNoBaseUrlRefusal(command: string, doc: string, why: string): string {
  return envelope({
    ok: false,
    command,
    status: "no-extension-id",
    error: {
      code: "E_NO_EXTENSION_ID",
      name: "NoExtensionId",
      message: `${why} Safari serves the extension's pages from a safari-web-extension://<uuid>/ base it assigns per install, and this server reads that base from the session: the background's runtime.getURL answer (an MV3 content_security_policy refuses that eval on Safari), or a line in this run's log that names an extension page. Neither named it yet.`,
    },
    hint: `Have the extension write one log line or error from its background or one of its pages (a click on its toolbar button wakes the background), then call again: each such line carries its safari-web-extension:// address, which extension_logs shows. Or pass the full safari-web-extension://<uuid>/${doc} url when you have it (a runtime error in Safari's Web Inspector names it).`,
  });
}
