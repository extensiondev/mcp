// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import { failureCode, jsonReadFailure as jsonReadFailureWith, whereItFails } from "./json-read-failure";

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
 * The read itself goes through one descriptor: the file is opened, asked
 * what it is and how large, and read from that same descriptor, so the
 * check and the read see one file. Anything that is not a regular file, or
 * is over MANIFEST_BYTES_MAX, is refused before a byte is read. The name is
 * matched without regard to case, because the disks of macOS and Windows
 * answer MANIFEST.JSON with the manifest itself. `realPathInside` is the
 * same containment for a folder argument (a `distPath`), and
 * `withoutParserQuote` takes the quoted file text out of a parser message
 * that an engine wrote and a tool relays.
 */
export const MANIFEST_FILE_NAME = "manifest.json";
export const MANIFEST_BYTES_MAX = 1024 * 1024;

const PARSER_QUOTE = /Unexpected token '[\s\S]{1,2}', (?:\.\.\.)?"[\s\S]{0,64}?"(?:\.\.\.)? is not valid JSON|Unexpected token [\s\S]{1,2} in JSON at position \d+/g;

export type ManifestFileRead =
  | { ok: true; path: string; root: string; manifest: unknown }
  | { ok: false; kind: "refused" | "unreadable" | "not-json"; path: string; message: string; hint: string };

export function findProjectManifest(projectPath: string): string | null {
  for (const rel of [MANIFEST_FILE_NAME, path.join("src", MANIFEST_FILE_NAME)]) {
    const candidate = path.resolve(projectPath, rel);
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
}

export function jsonReadFailure(err: unknown, file: string): string {
  return jsonReadFailureWith(err, file, (target) => fs.readFileSync(target, "utf8"));
}

export function withoutParserQuote(text: string, file?: string): string {
  return text.replace(PARSER_QUOTE, () => (file ? jsonReadFailure(new SyntaxError("not valid JSON"), file) : "not valid JSON"));
}

function namedManifest(file: string): boolean {
  return path.basename(file).toLowerCase() === MANIFEST_FILE_NAME;
}

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);

  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function realPathInside(root: string, target: string): string | null {
  try {
    const realRoot = fs.realpathSync(path.resolve(root));
    const realTarget = fs.realpathSync(path.resolve(target));

    return realTarget === realRoot || inside(realRoot, realTarget) ? realTarget : null;
  } catch {
    return null;
  }
}

function readRegularFile(file: string): { text: string } | { code: string } | { bytes: number } {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));

  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) return { code: stat.isDirectory() ? "EISDIR" : "ENOTSUP" };
    if (stat.size > MANIFEST_BYTES_MAX) return { bytes: stat.size };

    const buffer = Buffer.alloc(stat.size);
    let filled = 0;

    while (filled < buffer.length) {
      const read = fs.readSync(descriptor, buffer, filled, buffer.length - filled, filled);
      if (read === 0) break;

      filled += read;
    }

    return { text: buffer.toString("utf8", 0, filled) };
  } finally {
    fs.closeSync(descriptor);
  }
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
    const read = readRegularFile(realFile);
    if ("code" in read) return unreadable(read);

    if ("bytes" in read) {
      return {
        ok: false,
        kind: "unreadable",
        path: file,
        message: `${file} is ${read.bytes} bytes, over the ${MANIFEST_BYTES_MAX} bytes a ${MANIFEST_FILE_NAME} is read up to, so it was not read.`,
        hint: `Pass the path of the project's own ${MANIFEST_FILE_NAME} and call again.`,
      };
    }

    text = read.text;
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
