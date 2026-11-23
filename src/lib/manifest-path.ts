// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

/* @invariant A MANIFEST PATH READS ONE FILE: A manifest.json THAT REALLY SITS
 * IN ITS PROJECT, AND AN ANSWER NEVER CARRIES TEXT FROM A FILE THAT FAILED TO
 * PARSE. `manifestPath` is an argument, so whoever words the call chooses it,
 * and until ledger 1058 any readable file was opened and the parser's own
 * message, which quotes the text it stopped at, was answered back. Three
 * rules hold now. The path must name a file called manifest.json, checked
 * before the disk is touched, so no other name is opened or even looked for.
 * The file, with every link in its path followed, must sit inside the
 * project root and still be called manifest.json: the root is `projectPath`
 * when the call gives one, and otherwise the folder that holds the manifest,
 * or its parent when that folder is `src`, which is the folder the validator
 * already treats as the project. A manifest.json that is a link to a file
 * elsewhere is therefore refused. And a read or parse failure is answered as
 * a kind and a position (the error code, or a line and a column), never as
 * the parser's message. `jsonReadFailure` gives the same words to every
 * other tool that reads a JSON file under a folder the call names (a dist
 * manifest, a ready contract), so none of them quotes the file either.
 */
export const MANIFEST_FILE_NAME = "manifest.json";

export type ManifestFileRead =
  | { ok: true; path: string; root: string; manifest: unknown }
  | { ok: false; kind: "refused" | "unreadable" | "not-json"; path: string; message: string; hint: string };

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const WHITESPACE = " \t\n\r";
const ESCAPES = '"\\/bfnrt';

export function jsonErrorOffset(text: string): number | null {
  let at = 0;

  const skip = (): void => {
    while (at < text.length && WHITESPACE.includes(text[at])) at += 1;
  };

  const word = (expected: string): boolean => {
    if (!text.startsWith(expected, at)) return false;

    at += expected.length;

    return true;
  };

  const string = (): boolean => {
    if (text[at] !== '"') return false;

    at += 1;

    while (at < text.length) {
      const char = text[at];

      if (char === '"') {
        at += 1;

        return true;
      }

      if (char < " ") return false;

      if (char !== "\\") {
        at += 1;
        continue;
      }

      const escaped = text[at + 1];

      if (escaped === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(at + 2, at + 6))) {
        at += 6;
        continue;
      }

      if (escaped === undefined || !ESCAPES.includes(escaped)) return false;

      at += 2;
    }

    return false;
  };

  const members = (close: string, member: () => boolean): boolean => {
    at += 1;
    skip();

    if (text[at] === close) {
      at += 1;

      return true;
    }

    for (;;) {
      skip();

      if (!member()) return false;

      skip();

      if (text[at] === close) {
        at += 1;

        return true;
      }

      if (text[at] !== ",") return false;

      at += 1;
    }
  };

  const value = (): boolean => {
    skip();

    const char = text[at];

    if (char === "{") {
      return members("}", () => {
        if (!string()) return false;

        skip();

        if (text[at] !== ":") return false;

        at += 1;

        return value();
      });
    }

    if (char === "[") return members("]", value);
    if (char === '"') return string();
    if (char === "t") return word("true");
    if (char === "f") return word("false");
    if (char === "n") return word("null");

    NUMBER.lastIndex = at;

    if (!NUMBER.test(text)) return false;

    at = NUMBER.lastIndex;

    return true;
  };

  try {
    if (!value()) return at;

    skip();

    return at < text.length ? at : null;
  } catch {
    return null;
  }
}

function whereItFails(text: string): string {
  const offset = jsonErrorOffset(text);
  if (offset === null) return "";

  const before = text.slice(0, offset);
  const line = before.split("\n").length;
  const column = offset - before.lastIndexOf("\n");

  return offset >= text.length ? `: it ends before its value is complete, at line ${line}, column ${column}` : ` at line ${line}, column ${column}`;
}

function failureCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;

  return typeof code === "string" && /^[A-Z0-9_]{2,32}$/.test(code) ? code : "read failed";
}

export function jsonReadFailure(err: unknown, file: string): string {
  if (!(err instanceof SyntaxError)) {
    const code = failureCode(err);

    return code === "read failed" && err instanceof Error && err.constructor === Error ? err.message : code;
  }

  try {
    return `not valid JSON${whereItFails(fs.readFileSync(file, "utf8"))}`;
  } catch {
    return "not valid JSON";
  }
}

function namedManifest(file: string): boolean {
  return path.basename(file).toLowerCase() === MANIFEST_FILE_NAME;
}

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);

  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function readManifestFile(manifestPath: string, projectPath?: string): ManifestFileRead {
  const file = path.resolve(manifestPath);
  const folder = path.dirname(file);
  const root = projectPath ? path.resolve(projectPath) : path.basename(folder) === "src" ? path.dirname(folder) : folder;
  const refused = (message: string, hint: string): ManifestFileRead => ({ ok: false, kind: "refused", path: file, message, hint });
  const unreadable = (err: unknown): ManifestFileRead => ({
    ok: false,
    kind: "unreadable",
    path: file,
    message: `${file} could not be read (${failureCode(err)})`,
    hint: `Pass the path of a ${MANIFEST_FILE_NAME} that exists and call again.`,
  });

  if (!namedManifest(file)) {
    return refused(
      `manifestPath has to name a file called ${MANIFEST_FILE_NAME}, and ${file} is not one, so nothing was read.`,
      `Pass the path of the project's ${MANIFEST_FILE_NAME} and call again.`,
    );
  }

  let realFile: string;
  let realRoot: string;

  try {
    realFile = fs.realpathSync(file);
    realRoot = fs.realpathSync(root);
  } catch (err) {
    return unreadable(err);
  }

  if (!inside(realRoot, realFile) || !namedManifest(realFile)) {
    return refused(
      `${file} is not a ${MANIFEST_FILE_NAME} inside the project folder ${root} once its links are followed, so nothing was read.`,
      projectPath
        ? "Pass a manifestPath that sits inside projectPath as a file of its own and call again."
        : `Put the ${MANIFEST_FILE_NAME} itself in the project folder, in place of a link to a file elsewhere, then call again with its path.`,
    );
  }

  let text: string;

  try {
    if (!fs.statSync(realFile).isFile()) return unreadable({ code: "EISDIR" });

    text = fs.readFileSync(realFile, "utf8");
  } catch (err) {
    return unreadable(err);
  }

  try {
    return { ok: true, path: file, root, manifest: JSON.parse(text) };
  } catch {
    return {
      ok: false,
      kind: "not-json",
      path: file,
      message: `${file} is not valid JSON${whereItFails(text)}`,
      hint: `Fix the JSON syntax of ${MANIFEST_FILE_NAME} at the place error.message names, then call again.`,
    };
  }
}
