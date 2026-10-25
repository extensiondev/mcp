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
import { jsonTextType, jsonType, sameJsonValue } from "../lib/json-value";
import {
  ambiguousSessionRefusal,
  resolveSessionBrowser,
} from "../lib/session-browser";

export const schema = {
  name: "extension_storage",
  description:
    "Read or write chrome.storage in a running extension. Every call runs in the extension's background (the engine honors no context), so it proves nothing about what a content script or page can read. A set is read back and the answer says whether the stored value and its type match. Rides the dev session's control channel, on unless extension_dev was called with allowControl:false. One key per call.",
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
        description:
          "Value to set (any JSON value); action=set needs value or valueJson. Some clients send null as the text \"null\" and an empty string as the two characters \"\"; both are refused here as ambiguous, so pass valueJson for them.",
      },
      valueJson: {
        type: "string",
        description:
          "The value to set as JSON text, parsed by this server so its type survives any client: \"null\" stores null, \"\\\"\\\"\" an empty string, \"0\", \"false\", \"[1,2]\" and \"{\\\"a\\\":1}\" their own types. Pass value or valueJson, not both.",
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
    valueJson?: string;
  },
): Promise<string> {
  const ambiguous = ambiguousSessionRefusal(schema.name, args.projectPath, args.browser);
  if (ambiguous) return ambiguous;

  const { browser } = resolveSessionBrowser(args.projectPath, args.browser);
  const cli = ["storage", args.action, args.projectPath];
  if (args.area) cli.push("--area", args.area);
  if (args.key) cli.push("--key", args.key);

  let intended: unknown;
  let looksLikeJsonText: string | null = null;

  if (args.action === "set") {
    const refusal = (message: string) =>
      envelope({
        ok: false,
        command: schema.name,
        status: "bad-request",
        error: { code: "E_BAD_REQUEST", name: "BadRequest", message },
      });

    if (args.value !== undefined && args.valueJson !== undefined) {
      return refusal("storage set takes value or valueJson, not both.");
    }

    if (args.valueJson !== undefined) {
      try {
        intended = JSON.parse(args.valueJson);
      } catch (err) {
        return refusal(`valueJson is not JSON text (${(err as Error).message}). Quote a string inside it: valueJson: "\\"dark\\"" stores the string dark.`);
      }
    } else if (args.value === undefined) {
      return refusal("storage set requires a value (or valueJson)");
    } else {
      intended = args.value;
      const textType = typeof intended === "string" ? jsonTextType(intended) : null;

      if (textType === "null" || textType === "string") {
        const meant = textType === "null" ? "null" : JSON.stringify(JSON.parse(intended as string));

        return refusal(
          `value arrived as the text ${JSON.stringify(intended)}, which is how some clients send ${textType === "null" ? "JSON null" : `the string ${meant}`}; storing it would write those ${(intended as string).length} characters as a string. Pass valueJson: ${JSON.stringify(intended)} to store ${textType === "null" ? "null" : meant}, or valueJson: ${JSON.stringify(JSON.stringify(intended))} to store the text exactly as sent.`,
        );
      }

      if (textType !== null) looksLikeJsonText = textType;
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

    cli.push("--value", JSON.stringify(intended));
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
      `context: "${args.context}" is not honored: the engine runs every storage call in the background, so this says nothing about what the ${args.context} can read.`,
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
    const present = stored !== undefined;
    const matches = readBack?.ok === true && present && sameJsonValue(stored, intended);
    patchValue(parsed, {
      readBack: {
        key: args.key,
        ...(readBack?.ok === true
          ? { value: present ? stored : null, present, ...(present ? { type: jsonType(stored) } : {}) }
          : { unreadable: String(readBack?.error?.message ?? readBackRaw.slice(0, 200)) }),
        sentType: jsonType(intended),
        matches,
      },
    });

    if (looksLikeJsonText) {
      addWarning(
        parsed,
        `value arrived as a string that reads as JSON (${looksLikeJsonText}), so it was stored as that string. If you meant the ${looksLikeJsonText}, call again with valueJson: ${JSON.stringify(intended)}.`,
      );
    }

    if (!matches) {
      parsed.ok = false;
      parsed.status = "set-unconfirmed";
      parsed.error = {
        code: "E_CONTROL_ENVELOPE",
        name: "SetUnconfirmed",
        message:
          readBack?.ok === true
            ? `The engine accepted the set, but reading "${args.key}" back from storage.${args.area ?? "local"} answered ${present ? `${JSON.stringify(stored)} (${jsonType(stored)})` : "no such key"}, not the value sent (${JSON.stringify(intended)}, ${jsonType(intended)}).`
            : `The engine accepted the set, but "${args.key}" could not be read back from storage.${args.area ?? "local"}: ${String(readBack?.error?.message ?? readBackRaw.slice(0, 200))}.`,
      };

      parsed.hint = "A storage.onChanged listener or a later write in the extension may have changed it; read it again with action: 'get', or check the listener.";
    } else {
      parsed.status = "set";
    }
  }

  return actFrameJson(parsed);
}
