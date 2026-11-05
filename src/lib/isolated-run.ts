// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { engineBrowserName } from "./browser-family";
import { compareVersions, resolvedEngineFacts } from "./engine-version";
import { envelope } from "./envelope";
import { runExtensionCli } from "./exec";
import { buildBudgetMs } from "./safari-build-options";

export const ISOLATED_ROOT_ENV = "EXTENSION_ISOLATED_DIR";
export const ISOLATED_MARKER = "isolated.json";
export const ISOLATED_BUILD_DIR = "build";
export const ISOLATED_PROFILE_DIR = "profile";
export const ISOLATED_OUT_DIR_FLOOR = "4.1.36";

export interface IsolatedRun {
  dir: string;
  sourceProject: string;
  browser: string;
  buildDir: string;
  extensionDir: string;
  profileDir: string;
  startedAt: string;
}

export function isolatedRoot(): string {
  const configured = String(process.env[ISOLATED_ROOT_ENV] || "").trim();

  return configured ? path.resolve(configured) : path.join(os.tmpdir(), "extension-isolated");
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 60) || "project";
}

/* @invariant AN ISOLATED RUN IS ANOTHER PROJECT TO THE ENGINE. The engine
 * allows one session per browser per project folder, keyed by that folder, so
 * a second session for the person's project would replace theirs. A run folder
 * under the system temp directory with its own package.json is a project of
 * its own: the engine keys the session on it, writes ready.json and the
 * controlled copy under its dist, and never reads the person's dist, profile
 * or window. Every other tool addresses the run by that folder (ledger 401).
 */
export function openIsolatedRun(sourceProject: string, browser: string): IsolatedRun {
  const root = isolatedRoot();
  fs.mkdirSync(root, { recursive: true });

  const source = path.resolve(sourceProject);
  const dir = fs.mkdtempSync(path.join(root, `${slug(path.basename(source))}--${slug(browser)}-`));
  const startedAt = new Date().toISOString();
  const buildDir = path.join(dir, ISOLATED_BUILD_DIR);
  const run: IsolatedRun = {
    dir,
    sourceProject: source,
    browser,
    buildDir,
    extensionDir: path.join(buildDir, engineBrowserName(browser)),
    profileDir: path.join(dir, ISOLATED_PROFILE_DIR),
    startedAt,
  };

  fs.writeFileSync(path.join(dir, ISOLATED_MARKER), `${JSON.stringify({ sourceProject: source, browser, startedAt }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ name: "extension-isolated", private: true }, null, 2)}\n`);

  return run;
}

export function removeIsolatedRun(dir: string): boolean {
  const resolved = path.resolve(dir);

  if (path.dirname(resolved) !== isolatedRoot() || !fs.existsSync(path.join(resolved, ISOLATED_MARKER))) return false;

  try {
    fs.rmSync(resolved, { recursive: true, force: true });
  } catch {
    return false;
  }

  return !fs.existsSync(resolved);
}

export function readIsolatedMarker(projectPath: string): { sourceProject: string; browser: string; startedAt: string } | null {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(projectPath, ISOLATED_MARKER), "utf8"));

    return marker && typeof marker === "object" && typeof marker.sourceProject === "string"
      ? { sourceProject: marker.sourceProject, browser: String(marker.browser ?? ""), startedAt: String(marker.startedAt ?? "") }
      : null;
  } catch {
    return null;
  }
}

export async function isolatedEngineRefusal(command: string, sourceProject: string): Promise<string | null> {
  let version: string | null;

  try {
    version = (await resolvedEngineFacts(sourceProject)).version;
  } catch {
    return null;
  }

  if (version === null || (compareVersions(version, ISOLATED_OUT_DIR_FLOOR) ?? 0) >= 0) return null;

  return envelope({
    ok: false,
    command,
    status: "engine-unsupported",
    error: {
      code: "E_ENGINE_TOO_OLD",
      message: `The project's Extension.js engine reports ${version}, and an isolated run builds beside the project with extension build --out-dir, which the engine takes only from ${ISOLATED_OUT_DIR_FLOOR} on. Nothing was built or launched.`,
    },
    hint: "Upgrade the project's engine (npm i -D extension@latest) and call extension_start with isolated: true again.",
  });
}

export type IsolatedBuild =
  | { ok: true; output: string }
  | { ok: false; refusal: string };

const lastLines = (text: string, n: number): string => text.split("\n").filter(Boolean).slice(-n).join("\n");

export async function buildIsolatedRun(command: string, run: IsolatedRun): Promise<IsolatedBuild> {
  const attempt = await runExtensionCli(["build", run.sourceProject, "--browser", run.browser, "--out-dir", run.buildDir], {
    cwd: run.sourceProject,
    timeoutMs: buildBudgetMs(run.browser),
  });
  const output = [attempt.stdout ?? "", attempt.stderr ?? ""].filter(Boolean).join("\n").trim();

  if (attempt.code !== 0) {
    removeIsolatedRun(run.dir);

    if (/unknown option '--out-dir'/i.test(output)) {
      return {
        ok: false,
        refusal: envelope({
          ok: false,
          command,
          status: "engine-unsupported",
          error: {
            code: "E_ENGINE_TOO_OLD",
            message: `The project's Extension.js engine refused --out-dir, which extension build takes only from ${ISOLATED_OUT_DIR_FLOOR} on, so no isolated run could be built. Nothing was launched.`,
          },
          hint: "Upgrade the project's engine (npm i -D extension@latest) and call extension_start with isolated: true again.",
        }),
      };
    }

    return {
      ok: false,
      refusal: envelope({
        ok: false,
        command,
        status: "build-failed",
        error: {
          code: "E_BUILD_FAILED",
          message: `The production build for the isolated ${run.browser} run failed (exit ${attempt.code ?? "unknown"}), so nothing was launched and the person's own session was not touched.`,
        },
        value: { browser: run.browser, sourceProject: run.sourceProject, output: lastLines(output, 20).slice(-4000) },
        hint: "Read value.output for the bundler's report; extension_build on the project answers the same failure with its compile errors.",
      }),
    };
  }

  if (!fs.existsSync(path.join(run.extensionDir, "manifest.json"))) {
    removeIsolatedRun(run.dir);

    return {
      ok: false,
      refusal: envelope({
        ok: false,
        command,
        status: "build-not-found",
        error: {
          code: "E_BUILD_NOT_FOUND",
          message: `The build exited 0 but wrote no manifest.json at ${run.extensionDir}, so there is nothing to launch in isolation.`,
        },
        value: { browser: run.browser, sourceProject: run.sourceProject, output: lastLines(output, 20).slice(-4000) },
        hint: "Check the project's output configuration: an isolated run reads <outDir>/<browser> as the engine writes it.",
      }),
    };
  }

  return { ok: true, output };
}

export function isolatedSentence(run: IsolatedRun): string {
  return `This is an isolated session: pass projectPath "${run.dir}" to every other tool (extension_open, extension_eval, extension_screenshot, extension_dom_snapshot, extension_wait, extension_stop) to address it. It runs a fresh production build of ${run.sourceProject} on its own profile; that project's own session, window, profile and dist/${run.browser} were not touched. extension_stop with projectPath "${run.dir}" ends it, and the folder stays under ${isolatedRoot()} until you delete it.`;
}
