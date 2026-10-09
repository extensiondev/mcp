// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import {
  CALL_TIMEOUT,
  SESSION_BROWSER,
  SESSION_PROJECT_PATH,
} from "../lib/common-schema";
import { actFrameJson, addWarning, patchValue, runActVerb, type ActArgs } from "../lib/act";
import { envelope } from "../lib/envelope";
import { resolveSessionBrowser } from "../lib/session-browser";

export const schema = {
  name: "extension_storage",
  description:
    "Read or write chrome.storage in a running extension. Every call runs in the extension's background (the engine honours no context), so it proves nothing about what a content script or page can read. A set is read back and the answer says whether the stored value matches. Rides the dev session's control channel, on unless extension_dev was called with allowControl:false. Set one key per call: there is no bulk-object set.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: SESSION_PROJECT_PATH,
      action: {
        type: "string",
        enum: ["get", "set"],
        description: "get reads a key (or the whole area); set writes a key",
      },
      area: {
        type: "string",
        enum: ["local", "sync", "session", "managed"],
        default: "local",
      },
      key: { type: "string", description: "Key to get or set" },
      value: {
        description: "Value to set (any JSON value); required for action=set",
      },
      browser: SESSION_BROWSER,
      timeout: CALL_TIMEOUT,
    },
    required: ["projectPath", "action"],
  },
};

function sourceManifestDeclaresStorage(projectPath: string): { file: string; declares: boolean } | null {
  for (const relative of ["src/manifest.json", "manifest.json"]) {
    let manifest: Record<string, unknown>;

    try {
      manifest = JSON.parse(fs.readFileSync(path.join(projectPath, relative), "utf8"));
    } catch {
      continue;
    }

    const declared = Object.entries(manifest)
      .filter(([key]) => key === "permissions" || key.endsWith(":permissions"))
      .flatMap(([, value]) => (Array.isArray(value) ? value : []));

    return { file: relative, declares: declared.includes("storage") };
  }

  return null;
}

export async function handler(
  args: ActArgs & {
    action: "get" | "set";
    area?: string;
    key?: string;
    value?: unknown;
  },
): Promise<string> {
  const { browser } = resolveSessionBrowser(args.projectPath, args.browser);
  const cli = ["storage", args.action, args.projectPath];
  if (args.area) cli.push("--area", args.area);
  if (args.key) cli.push("--key", args.key);

  if (args.action === "set") {
    if (args.value === undefined) {
      return envelope({
        ok: false,
        command: schema.name,
        status: "bad-request",
        error: {
          code: "E_BAD_REQUEST",
          name: "BadRequest",
          message: "storage set requires a value",
        },
      });
    }

    if (args.key === undefined) {
      return envelope({
        ok: false,
        command: schema.name,
        status: "bad-request",
        error: {
          code: "E_BAD_REQUEST",
          name: "BadRequest",
          message:
            'storage set requires `key` (string) and `value` args, one key per call. There is no bulk-object set: to seed {a: 1, b: 2}, call once with key: "a" and once with key: "b".',
        },
      });
    }

    cli.push("--value", JSON.stringify(args.value));
  }

  cli.push("--browser", browser);
  if (args.timeout != null) cli.push("--timeout", String(args.timeout));

  const raw = await runActVerb(cli, args.projectPath, args.timeout, schema.name);
  let parsed: any;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }

  if (!parsed || typeof parsed !== "object") return raw;

  if (args.context && args.context !== "background") {
    addWarning(
      parsed,
      `context: "${args.context}" is not honoured: the engine runs every storage call in the background, so this says nothing about what the ${args.context} can read.`,
    );
  }

  const source = parsed.ok === true ? sourceManifestDeclaresStorage(args.projectPath) : null;

  if (source && !source.declares) {
    patchValue(parsed, { manifestDeclaresStorage: false });
    addWarning(
      parsed,
      `${source.file} does not declare the "storage" permission. This call went through the dev session's control channel and answered anyway, but the extension's own code gets no chrome.storage without it: add "storage" to permissions before relying on it in a build.`,
    );
  }

  if (args.action === "set" && parsed.ok === true && args.key !== undefined) {
    const readBackRaw = await runActVerb(
      ["storage", "get", args.projectPath, ...(args.area ? ["--area", args.area] : []), "--key", args.key, "--browser", browser, ...(args.timeout != null ? ["--timeout", String(args.timeout)] : [])],
      args.projectPath,
      args.timeout,
      schema.name,
    );
    let readBack: any;

    try {
      readBack = JSON.parse(readBackRaw);
    } catch {
      readBack = null;
    }

    const stored =
      readBack?.ok === true && readBack.value && typeof readBack.value === "object" && args.key in readBack.value
        ? (readBack.value as Record<string, unknown>)[args.key]
        : undefined;
    const matches = readBack?.ok === true && JSON.stringify(stored) === JSON.stringify(args.value);
    patchValue(parsed, {
      readBack: {
        key: args.key,
        ...(readBack?.ok === true ? { value: stored === undefined ? null : stored, present: stored !== undefined } : { unreadable: String(readBack?.error?.message ?? readBackRaw.slice(0, 200)) }),
        matches,
      },
    });

    if (!matches) {
      parsed.ok = false;
      parsed.status = "set-unconfirmed";
      parsed.error = {
        code: "E_CONTROL_ENVELOPE",
        name: "SetUnconfirmed",
        message:
          readBack?.ok === true
            ? `The engine accepted the set, but reading "${args.key}" back from storage.${args.area ?? "local"} answered ${stored === undefined ? "no such key" : JSON.stringify(stored)}, not the value sent.`
            : `The engine accepted the set, but "${args.key}" could not be read back from storage.${args.area ?? "local"}: ${String(readBack?.error?.message ?? readBackRaw.slice(0, 200))}.`,
      };

      parsed.hint = "A storage.onChanged listener or a later write in the extension may have changed it; read it again with action: 'get', or check the listener.";
    } else {
      parsed.status = "set";
    }
  }

  return actFrameJson(parsed);
}
