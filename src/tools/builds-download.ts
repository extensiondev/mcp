// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { envelope } from "../lib/envelope";
import { projectApiBytes } from "../lib/project-api-bytes";
import { projectApiGet, projectApiReadFailure, type ProjectApi } from "../lib/project-api";
import { trackUrl } from "../lib/track-url";
import { userCacheDir } from "../lib/user-cache-dir";
import { COMMAND, actRefusal, badRequest, isRow, openFor, text, type ActArgs } from "./builds-acts";

export const DOWNLOAD_ACTION = "download";
export const SOURCE_ARCHIVE = "source";
export const ARTIFACTS_DIR = "artifacts";
export const MAX_PACKAGE_BYTES = 512 * 1024 * 1024;

const PACKAGE_BROWSERS = ["chrome", "edge", "firefox", "safari"] as const;
const SHA256 = /^[0-9a-f]{64}$/;
const FULL_SHA = /^[a-f0-9]{7,40}$/i;

export type Verified = true | false | "no-report";

export interface DownloadArgs extends ActArgs {
  browser?: string;
  to?: string;
  projectPath?: string;
}

/* @invariant A READ NEVER DIRTIES THE OWNER'S REPOSITORY. The package a
 * download saves is a copy of what the platform holds, so by default it
 * lands in the user's cache directory, keyed by workspace, project and
 * build, and never under the project: the first version wrote it to
 * .extension.dev/artifacts/ inside the project and appended that folder to
 * the project's .gitignore, which left a tracked file modified after a
 * read-only ask (ledger 249). Only an explicit `to` writes anywhere else,
 * and no path this action takes touches .gitignore.
 */
export function defaultArtifactsDir(workspace: string, project: string, buildId: string): string {
  return path.join(userCacheDir(), ARTIFACTS_DIR, workspace, project, buildId);
}

function shortSha(buildId: string): string {
  return FULL_SHA.test(buildId) ? buildId.slice(0, 7).toLowerCase() : buildId;
}

function sha256Of(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function describe(browser: string): string {
  return browser === SOURCE_ARCHIVE ? "source archive" : `${browser} package`;
}

async function expectedFromReport(api: ProjectApi, buildId: string, browser: string): Promise<string> {
  if (browser === SOURCE_ARCHIVE) return "";

  const read = await projectApiGet<unknown>(api, `builds/${encodeURIComponent(buildId)}/integrity/${encodeURIComponent(browser)}`);
  if (!read.ok || !isRow(read.json)) return "";

  const sha = text(read.json.sha256).toLowerCase();

  return SHA256.test(sha) ? sha : "";
}

function expectedFromRelay(headers: Headers): string {
  if (text(headers.get("x-integrity-report")).toLowerCase() === "absent") return "";

  const sha = text(headers.get("x-integrity-sha256")).toLowerCase();

  return SHA256.test(sha) ? sha : "";
}

/* @invariant THE VERDICT COMPARES THE BYTES ON DISK WITH THE DIGEST THE
 * PLATFORM RECORDED, OR SAYS THERE IS NONE. The integrity report the build
 * lane wrote names the package's sha256; the relay repeats the recorded
 * digest in a header for the source archive, whose record lives in the
 * build rollup. The file is hashed after it is written, so a short write
 * cannot pass, and when neither record names a digest the answer is
 * "no-report" rather than a true that nothing supports. A mismatch still
 * leaves the file where it was written so the person can inspect it, but
 * the answer is a refusal that says not to upload it.
 */
export function judge(expected: string, actual: string): Verified {
  if (!expected) return "no-report";

  return expected === actual;
}

function explicitTarget(args: DownloadArgs, projectPath: string): string {
  const to = text(args.to);

  if (!to) return "";

  return path.isAbsolute(to) ? path.resolve(to) : path.resolve(projectPath || process.cwd(), to);
}

export async function download(args: DownloadArgs): Promise<string> {
  const buildId = text(args.buildId);
  const browser = text(args.browser).toLowerCase();
  const projectPath = text(args.projectPath);
  const value = { action: DOWNLOAD_ACTION, ...(buildId ? { buildId } : {}), ...(browser ? { browser } : {}) };

  if (!buildId) {
    return badRequest(DOWNLOAD_ACTION, "BuildsInputError", `action:"${DOWNLOAD_ACTION}" needs a buildId. Run action:"list" for the recent builds and pass one of their buildId values.`, value);
  }

  if (!browser || (!(PACKAGE_BROWSERS as readonly string[]).includes(browser) && browser !== SOURCE_ARCHIVE)) {
    return badRequest(
      DOWNLOAD_ACTION,
      "BuildsInputError",
      `action:"${DOWNLOAD_ACTION}" needs browser: one of ${PACKAGE_BROWSERS.join(", ")} for that browser's package, or "${SOURCE_ARCHIVE}" for the source archive a public project's build uploaded.`,
      value,
    );
  }

  const sha = shortSha(buildId);
  const chosen = explicitTarget(args, projectPath);
  const opened = await openFor(args, DOWNLOAD_ACTION, value);
  if ("refused" in opened) return opened.refused;

  const api = opened.api;
  const dir = chosen || defaultArtifactsDir(api.ref.workspace, api.ref.project, sha);
  const buildPage = trackUrl("build", { workspace: api.ref.workspace, project: api.ref.project, buildId: sha }, args.api);
  const fileName = `${browser}.zip`;
  const [fetched, reportSha] = await Promise.all([
    projectApiBytes(api, `builds/${encodeURIComponent(buildId)}/artifacts/${fileName}`, { maxBytes: MAX_PACKAGE_BYTES }),
    expectedFromReport(api, buildId, browser),
  ]);

  if (!fetched.ok) {
    if (fetched.status === 404) {
      return envelope({
        ok: false,
        command: COMMAND,
        status: "not-found",
        value: { ...value, trackUrl: buildPage },
        error: {
          code: "E_BUILD_NOT_FOUND",
          name: "BuildsRefused",
          ...(fetched.code ? { platformCode: fetched.code } : {}),
          message: `Build ${sha} has no ${describe(browser)} on the platform: ${fetched.message}`,
        },
        hint: `Read extension_builds (action: "get", buildId: "${sha}") for the browsers this build produced. The build page is ${buildPage}.`,
      });
    }

    if (fetched.status === 401 || fetched.status === 403) {
      return projectApiReadFailure(COMMAND, fetched, {
        api: args.api,
        name: "Builds",
        value: { ...value, trackUrl: buildPage },
        context: { workspace: api.ref.workspace, project: `${api.ref.workspace}/${api.ref.project}` },
      });
    }

    return actRefusal(fetched, DOWNLOAD_ACTION, api, args, { ...value, trackUrl: buildPage });
  }

  const filePath = path.join(dir, fileName);

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, fetched.bytes);
  } catch (err: any) {
    return envelope({
      ok: false,
      command: COMMAND,
      status: "unavailable",
      value: { ...value, path: filePath, trackUrl: buildPage },
      error: { code: "E_PLATFORM", name: "BuildsWriteError", message: `The ${describe(browser)} of build ${sha} was fetched but could not be written to ${filePath}: ${err?.message || err}` },
    });
  }

  const written = fs.readFileSync(filePath);
  const actual = sha256Of(written);
  const expected = reportSha || expectedFromRelay(fetched.headers);
  const verified = judge(expected, actual);
  const untouched = chosen
    ? "The project's files and .gitignore were not touched."
    : "That is your cache directory, outside the project, whose files and .gitignore were not touched.";
  const common = {
    ...value,
    buildId: sha,
    path: filePath,
    bytes: written.byteLength,
    sha256: actual,
    verified,
    ...(expected ? { expectedSha256: expected, report: reportSha ? "integrity-report" : "build-record" } : { report: "none" }),
    trackUrl: buildPage,
  };

  if (verified === false) {
    const say = `The saved ${describe(browser)} for build ${sha} at ${filePath} is not the file the integrity report describes: its sha256 is ${actual}, the report says ${expected}. Do not upload it; rerun the checks with extension_builds (action: "recheck", buildId: "${sha}") or rebuild with action: "rebuild" first.`;

    return envelope({
      ok: false,
      command: COMMAND,
      status: "integrity-mismatch",
      value: { ...common, sayToPerson: say },
      error: { code: "E_PLATFORM", name: "BuildsArtifactMismatch", message: say },
      hint: `${say} The build page is ${buildPage}.`,
    });
  }

  const say =
    verified === true
      ? `Saved the platform's ${describe(browser)} for build ${sha} at ${filePath}, byte-identical to what the integrity report describes (sha256 ${actual}). ${untouched}`
      : `Saved the platform's ${describe(browser)} for build ${sha} at ${filePath} (sha256 ${actual}); no integrity report names a digest for it, so the bytes are the platform's but unverified. ${untouched}`;

  return envelope({
    ok: true,
    command: COMMAND,
    status: "downloaded",
    value: { ...common, sayToPerson: say },
    hint: `${say} The build page is ${buildPage}.`,
    warnings: [verified === "no-report" ? `Run extension_builds (action: "recheck", buildId: "${sha}") to have the platform record a digest for this build.` : null],
  });
}
