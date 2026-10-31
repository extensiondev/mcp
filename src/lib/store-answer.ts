// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { envelope, isEnvelope, type Envelope } from "./envelope";
import { nextStep } from "./store-connection";
import { isRow, text } from "./ship-act";

type Row = Record<string, unknown>;

export const RESUBMIT_SENTENCE =
  "The store already holds that version; extension.dev packages the next build with a higher build number, so build again and I resubmit.";

export const STORE_VERSION_CODE = "STORE_VERSION_NOT_ALLOWED";

const STORE_VERSION_MESSAGE =
  /version[^.]{0,120}?(must be (greater|higher)|already (exists|been used|uploaded|submitted)|was (uploaded|used) before|is not (greater|higher))|PKG_INVALID_VERSION|bundle version must be higher|CFBundleVersion[^.]{0,80}higher/i;

const RESUME_KINDS = new Set(["connect", "link-item"]);

const STORE_VERSION_TOOLS = new Set(["extension_submit", "extension_publish"]);

export interface StoreVersion {
  packaged: string;
  displayed: string;
  source: "platform" | "repo";
}

export function readStoreVersion(raw: unknown): StoreVersion | null {
  if (!isRow(raw)) return null;

  const packaged = text(raw.packaged);
  const displayed = text(raw.displayed);
  const source = text(raw.source);

  if (!packaged || !displayed || (source !== "platform" && source !== "repo")) return null;

  return { packaged, displayed, source };
}

export function isStoreVersionRefusal(frame: Pick<Envelope, "error" | "value">): boolean {
  const error: Row = isRow(frame.error) ? frame.error : {};
  const value: Row = isRow(frame.value) ? frame.value : {};
  const codes = [error.platformCode, error.code, value.code, value.platformCode].map(text);

  if (codes.includes(STORE_VERSION_CODE)) return true;

  return [error.message, value.message, value.reason, value.platformMessage].some((field) => STORE_VERSION_MESSAGE.test(text(field)));
}

function requestedBrowsers(args: Row): string[] {
  const asked = Array.isArray(args.browsers) ? args.browsers.map(text).filter(Boolean) : [];

  return asked.length > 0 ? asked : ["chrome"];
}

export function shapeStoreAnswer(command: string, args: Row, result: string): string {
  if (!STORE_VERSION_TOOLS.has(command)) return result;

  let parsed: unknown;

  try {
    parsed = JSON.parse(result);
  } catch {
    return result;
  }

  if (!isEnvelope(parsed)) return result;

  const value: Row = isRow(parsed.value) ? { ...parsed.value } : {};
  let hint = parsed.hint;
  let changed = false;

  if ("storeVersion" in value) {
    const storeVersion = readStoreVersion(value.storeVersion);

    if (storeVersion) value.storeVersion = storeVersion;
    else delete value.storeVersion;

    changed = true;
  }

  const step = isRow(value.nextStep) ? value.nextStep : null;

  if (command === "extension_submit" && step && RESUME_KINDS.has(text(step.kind))) {
    value.nextStep = {
      ...step,
      thenCall: { tool: "extension_submit", args: { action: "preflight", browsers: requestedBrowsers(args) } },
    };

    changed = true;
  }

  if (parsed.ok === false && isStoreVersionRefusal(parsed)) {
    value.nextStep = nextStep("resubmit", RESUBMIT_SENTENCE);
    value.sayToPerson = RESUBMIT_SENTENCE;
    hint = RESUBMIT_SENTENCE;
    changed = true;
  }

  if (!changed) return result;

  return envelope({
    ok: parsed.ok,
    command: parsed.command,
    status: parsed.status,
    value,
    error: parsed.error,
    warnings: parsed.warnings,
    ...(parsed.truncated !== undefined ? { truncated: parsed.truncated } : {}),
    ...(hint ? { hint } : {}),
  });
}

export function rowsWithSentVersion(rows: unknown, recorded: Record<string, { packaged?: unknown }>): unknown {
  if (!Array.isArray(rows)) return rows;

  return rows.map((row) => {
    if (!isRow(row)) return row;

    const own = isRow(row.storeVersion) ? row.storeVersion : recorded[text(row.store)];
    const packaged = own ? text(own.packaged) : "";

    return {
      ...row,
      ...(own && !isRow(row.storeVersion) ? { storeVersion: own } : {}),
      ...(packaged ? { version: packaged } : {}),
    };
  });
}
