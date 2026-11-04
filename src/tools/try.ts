// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import { isProjectRef } from "../lib/credentials";
import { compareVersions, resolvedEngineFacts } from "../lib/engine-version";
import { envelope } from "../lib/envelope";
import { packageAddress } from "../lib/package-address";
import { pidState } from "../lib/process-identity";
import { PRODUCTION_DEBUG_PORT_FLOOR } from "../lib/production-launch";
import { userlandProjectUrl, type ProjectRef } from "../lib/registry";
import { downloadTryPackage, pickTryBuild, readTryBuilds, type TryRefusal } from "../lib/try-package";
import { readTryPermissions, type TryPermissionFacts } from "../lib/try-permissions";
import {
  TRY_PROFILE_DIR,
  displayName,
  listTryRuns,
  openTryRun,
  removeTryRun,
  tryScreenshotsDir,
  unpackTryPackage,
  type TryRun,
} from "../lib/try-runs";
import { handler as openHandler } from "./open";
import { handler as screenshotHandler } from "./screenshot";
import { handler as startHandler } from "./start";
import { handler as stopHandler } from "./stop";

const COMMAND = "extension_try";
export const TRY_BROWSERS = ["chrome", "edge", "firefox"];
const NO_SAMPLE_PAGE = "about:blank";

export const schema = {
  name: COMMAND,
  description:
    "Run a published extension.dev build for the person in a fresh browser on this machine, so they see it work without downloading a package, turning on developer mode or running an installer. It downloads the build's package (newest by default), checks it against the platform's integrity record when there is one, unpacks it into a temporary folder and launches it with a new profile; on Extension.js 4.1.34 or later it then opens the popup or replays the toolbar action and saves a screenshot, and on an older engine it only launches and says the extension was not used. The answer names the version, the package size, what was confirmed and what was not, the screenshot, and what the extension can reach in plain words: warn the person about that. Nothing stays installed: call it again with action:'close' when done. For a project on disk use extension_dev or extension_start.",
  inputSchema: {
    type: "object" as const,
    properties: {
      project: {
        type: "string",
        description: 'The published project as "<workspace>/<project>", the two names in its extension.dev address <workspace>.extension.dev/<project>.',
      },
      version: {
        type: "string",
        description: "The version to run (0.3.0), or a build sha or its first characters (6b393ca). Omitted, the newest successful build that has a package for the browser.",
      },
      browser: {
        type: "string",
        default: "chrome",
        description: "chrome, edge or firefox. safari is refused: its package is an app that needs signing and a manual enable in Safari's settings.",
      },
      url: {
        type: "string",
        description: "The http or https page to open with the extension. Omitted, the browser opens about:blank: no sample page ships with this server.",
      },
      headless: {
        type: "boolean",
        default: true,
        description: "true runs the browser with no window, which never takes the person's keyboard. false opens a window they can see and use.",
      },
      action: {
        type: "string",
        enum: ["run", "close"],
        default: "run",
        description: "run downloads and launches. close ends every try of this project (one browser with `browser`) and deletes its folder and profile; screenshots stay.",
      },
    },
    required: ["project"],
  },
};

interface Args {
  project: string;
  version?: string;
  browser?: string;
  url?: string;
  headless?: boolean;
  action?: string;
}

type Frame = { ok?: boolean; status?: string; value?: Record<string, any>; error?: { code?: string; message?: string }; hint?: string };

function refuse(status: string, code: string, message: string, hint: string, value: Record<string, unknown> = {}): string {
  return envelope({ ok: false, command: COMMAND, status, error: { code, message }, value, hint });
}

function parsed(raw: string): Frame {
  try {
    return JSON.parse(raw) as Frame;
  } catch {
    return { ok: false, status: "unreadable" };
  }
}

function closeCall(project: string): string {
  return `extension_try {project: "${project}", action: "close"}`;
}

function refusalEnvelope(refusal: TryRefusal, project: string, what: string, value: Record<string, unknown>): string {
  if (refusal.kind === "not-public") {
    return refuse(
      "not-public",
      "E_AUTH_REQUIRED",
      `${project} is not open to everyone on extension.dev (its ${what} answered ${refusal.httpStatus}), so there is nothing to run without signing in. Nothing was downloaded.`,
      "Tell the person this project is private or its builds are not public yet. A member of its workspace reaches it once this server holds a login for it; a public project needs nothing.",
      value,
    );
  }

  if (refusal.kind === "held") {
    return refuse("platform-held", "E_PLATFORM", refusal.heldMessage || "extension.dev is not open to the public yet.", "Say so plainly; nothing was downloaded.", value);
  }

  if (refusal.kind === "not-found") {
    return refuse("not-found", "E_BUILD_NOT_FOUND", `extension.dev has no ${what} for ${project}. Nothing was downloaded.`, "Check the two names in the project's address, <workspace>.extension.dev/<project>.", value);
  }

  return refuse("unavailable", "E_NETWORK", `The ${what} of ${project} could not be read${refusal.httpStatus ? ` (${refusal.httpStatus})` : ""}. Nothing was downloaded.`, "Try again in a moment.", value);
}

async function useOnce(run: TryRun, browser: string, facts: TryPermissionFacts, page: string): Promise<{ confirmed: string[]; notConfirmed: string[]; screenshot: Record<string, unknown> | null }> {
  const confirmed: string[] = [];
  const notConfirmed: string[] = [];
  const projectPath = run.dir;
  let context = "page";

  if (facts.surfaces.popup || facts.surfaces.action) {
    const surface = facts.surfaces.popup ? "popup" : "action";
    const opened = parsed(await openHandler({ projectPath, browser, surface }));

    if (opened.ok) {
      confirmed.push(surface === "popup" ? `Opened its popup (${facts.surfaces.popup}).` : "Replayed its toolbar action: the listener ran with no user gesture, so the activeTab grant a real click gives did not apply.");
      if (surface === "popup") context = "popup";
    } else {
      notConfirmed.push(`Opening its ${surface === "popup" ? "popup" : "toolbar action"} was refused (${opened.status}): ${opened.error?.message ?? "no reason given"}`);
    }
  } else {
    notConfirmed.push("It declares no popup and no toolbar action, so there was nothing of its own to open; the screenshot is the page.");
  }

  const shot = parsed(await screenshotHandler({ projectPath, browser, context, ...(context === "page" && page !== NO_SAMPLE_PAGE ? { url: page } : {}), path: "shots/" }));

  if (!shot.ok || typeof shot.value?.path !== "string") {
    notConfirmed.push(`The screenshot was refused (${shot.status}): ${shot.error?.message ?? "no reason given"}`);

    return { confirmed, notConfirmed, screenshot: null };
  }

  const target = path.join(tryScreenshotsDir(), `${path.basename(run.dir)}-${context}.png`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(shot.value.path, target);
  confirmed.push(`Captured the ${context === "popup" ? "popup" : `page ${shot.value.url}`} at ${shot.value.width} x ${shot.value.height} pixels.`);

  return { confirmed, notConfirmed, screenshot: { path: target, context, width: shot.value.width, height: shot.value.height } };
}

async function close(args: Args, project: string): Promise<string> {
  const browser = String(args.browser ?? "").trim().toLowerCase() || undefined;
  const runs = listTryRuns(project, browser);
  const closed: Array<{ buildId: string; version: string | null; browser: string; serverGone: unknown; browserGone: unknown; removed: boolean }> = [];

  for (const run of runs) {
    const stop = parsed(await stopHandler({ projectPath: run.dir, browser: run.browser }));
    const removed = removeTryRun(run.dir);

    closed.push({ buildId: run.buildId, version: run.version, browser: run.browser, serverGone: stop.value?.serverGone ?? null, browserGone: stop.value?.browserGone ?? null, removed });
  }

  const left = closed.filter((entry) => !entry.removed || entry.browserGone === false);

  return envelope({
    ok: left.length === 0,
    command: COMMAND,
    status: runs.length === 0 ? "nothing-to-close" : left.length ? "close-incomplete" : "closed",
    value: { project, closed, screenshots: tryScreenshotsDir() },
    ...(left.length ? { error: { code: "E_INTERNAL", message: `${left.length} of ${closed.length} tries of ${project} were not fully removed.` } } : {}),
    hint: runs.length === 0
      ? `No try of ${project} is running on this machine; nothing was removed.`
      : `Ended ${closed.length} ${closed.length === 1 ? "try" : "tries"} of ${project}: the browser, its profile and the unpacked extension are gone${left.length ? ", except where removed is false or browserGone is false" : ""}. Screenshots stay in ${tryScreenshotsDir()}.`,
  });
}

function validUrl(raw: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(raw).protocol);
  } catch {
    return false;
  }
}

export async function handler(args: Args): Promise<string> {
  const project = String(args.project ?? "").trim().toLowerCase();
  const browser = String(args.browser ?? "chrome").trim().toLowerCase();
  const url = String(args.url ?? "").trim();

  if (!isProjectRef(project)) {
    return refuse("bad-request", "E_BAD_REQUEST", `project takes "<workspace>/<project>", got "${project}".`, "Read the two names from the project's address, <workspace>.extension.dev/<project>.");
  }

  if (args.action === "close") return close(args, project);

  if (browser === "safari") {
    return refuse("unsupported-browser", "E_UNSUPPORTED_BROWSER", "safari cannot be tried this way: its package is a macOS app that needs signing and a manual enable in Safari > Settings > Extensions.", `Try it in chrome, edge or firefox, or open its page and install it from there.`);
  }

  if (!TRY_BROWSERS.includes(browser)) {
    return refuse("unsupported-browser", "E_UNSUPPORTED_BROWSER", `${browser} is not a browser extension_try launches; it runs ${TRY_BROWSERS.join(", ")}.`, "Pass one of those, or leave browser out for chrome.");
  }

  if (url && !validUrl(url)) {
    return refuse("bad-request", "E_BAD_REQUEST", `url must be an http or https address, got "${url}".`, "Pass a web page, or leave url out for about:blank.");
  }

  const [workspaceSlug = "", projectSlug = ""] = project.split("/");
  const ref: ProjectRef = { workspace: workspaceSlug, project: projectSlug };
  const index = await readTryBuilds(ref);

  if (!index.ok) return refusalEnvelope(index.refusal, project, "build list", { project, browser });

  const pick = pickTryBuild(index.items, browser, args.version);

  if (!pick.ok) {
    const listed = pick.candidates.map((item) => `${item.version ?? "no version"} (${item.sha})`).join(", ");
    const said = {
      "no-builds": `${project} has no successful build to run.`,
      "no-match": `${project} has no build matching "${args.version}".`,
      ambiguous: `"${args.version}" matches more than one build of ${project}.`,
      "no-browser": `The build of ${project} matching "${args.version ?? "newest"}" has no ${browser} package.`,
    }[pick.reason];

    return refuse(pick.reason === "no-browser" ? "no-package" : "not-found", "E_BUILD_NOT_FOUND", `${said}${listed ? ` Recent: ${listed}.` : ""} Nothing was downloaded.`, "Pass version as one of those, or leave it out for the newest.", { project, browser });
  }

  const build = pick.build;
  const buildId = build.sha.slice(0, 7);
  const value: Record<string, unknown> = {
    project,
    version: build.version ?? null,
    buildId,
    browser,
    buildPage: userlandProjectUrl(ref, `builds/${buildId}`),
    packageAddress: packageAddress(ref, buildId, `${browser}.zip`),
  };
  const download = await downloadTryPackage(ref, buildId, browser);

  if (!download.ok) {
    if (download.tooLarge) return refuse("too-large", "E_BAD_REQUEST", `The ${browser} package of build ${buildId} is larger than this tool downloads. Nothing was kept.`, "Install it from its page instead.", value);

    return refusalEnvelope(download.refusal, project, `${browser} package of build ${buildId}`, value);
  }

  const packageFacts = { packageBytes: download.bytes.length, sha256: download.integrity.sha256, integrity: download.integrity.verdict };

  if (download.integrity.verdict === "mismatch") {
    return refuse("integrity-mismatch", "E_ARTIFACTS_UNVERIFIED", `The downloaded ${browser} package of build ${buildId} is not the file the platform recorded (sha256 ${download.integrity.sha256}, recorded ${download.integrity.expectedSha256}). It was not unpacked or launched, and nothing was kept.`, "Do not run it. Tell the person the download did not match and to try again later.", { ...value, ...packageFacts });
  }

  const run = openTryRun({ project, browser, buildId, version: build.version ?? null });
  const unpacked = unpackTryPackage(run, download.bytes);

  if (!unpacked.ok) {
    removeTryRun(run.dir);

    return refuse("package-refused", "E_BAD_MANIFEST", `The ${browser} package of build ${buildId} was refused: ${unpacked.message}. Nothing was launched or kept.`, "Tell the person this build cannot be tried; nothing stays on the machine.", { ...value, ...packageFacts });
  }

  const facts = readTryPermissions(unpacked.manifest);
  const name = displayName(unpacked.extensionDir, unpacked.manifest) ?? facts.name;
  const engine = await resolvedEngineFacts(run.dir);
  const floorMet = engine.version !== null && (compareVersions(engine.version, PRODUCTION_DEBUG_PORT_FLOOR) ?? -1) >= 0;
  const page = url || NO_SAMPLE_PAGE;
  const headless = args.headless !== false;
  const started = parsed(
    await startHandler({
      projectPath: run.dir,
      browser,
      outputPath: unpacked.extensionDir,
      profile: path.join(run.dir, TRY_PROFILE_DIR),
      startingUrl: page,
      headless,
      allowControl: floorMet,
    }),
  );

  const enginePid = typeof started.value?.pid === "number" ? started.value.pid : null;

  if (started.ok && enginePid !== null && pidState(enginePid) !== "alive") {
    started.ok = false;
    started.error = { code: "E_SESSION_EXITED", message: `the engine process (pid ${enginePid}) exited while ${browser} was launching, after the start answered.` };
    started.hint = "Run extension_try again; if it fails the same way, the build cannot be launched by this engine.";
  }

  if (!started.ok) {
    await stopHandler({ projectPath: run.dir, browser });
    removeTryRun(run.dir);

    return refuse("launch-failed", started.error?.code ?? "E_BROWSER_EXITED", `${browser} did not come up with build ${buildId}: ${started.error?.message ?? "the launch gave no reason"} Nothing stays on the machine.`, started.hint ?? "Read error.message for the cause.", { ...value, ...packageFacts, engine: engine.version, launchStatus: started.status ?? null });
  }

  const launched = started.value ?? {};
  const confirmed = [
    `Downloaded the ${browser} package of ${name}${build.version ? ` ${build.version}` : ""} (build ${buildId}, ${download.bytes.length} bytes).`,
    download.integrity.verdict === "verified"
      ? `It is byte for byte the file the platform recorded (sha256 ${download.integrity.sha256}).`
      : null,
    `Unpacked ${unpacked.files} files into a temporary folder and launched ${browser} ${headless ? "headless" : "in a window"} on a new profile with Extension.js ${engine.version ?? "(version unread)"}.`,
    launched.extensionLoaded === true ? `${browser} loaded it: ${launched.loadEvidence ?? ""}`.trim() : null,
  ].filter((line): line is string => typeof line === "string");
  const notConfirmed = [
    download.integrity.verdict === "no-report" ? `The platform recorded no digest for this package, so its sha256 ${download.integrity.sha256} was not checked against one.` : null,
    launched.extensionLoaded === true ? null : `That ${browser} loaded the extension: ${launched.loadEvidence ?? "the launch answer did not say"}`,
    url ? null : "No sample page ships with this server, so the browser opened about:blank, where content scripts that match websites do not run; pass url to try it on a page.",
  ].filter((line): line is string => typeof line === "string");
  let screenshot: Record<string, unknown> | null = null;

  if (floorMet) {
    const used = await useOnce(run, browser, facts, page);
    confirmed.push(...used.confirmed);
    notConfirmed.push(...used.notConfirmed);
    screenshot = used.screenshot;
  } else {
    notConfirmed.push(`The extension was not used: Extension.js ${engine.version ?? "(version unread)"} opens no control channel and no debug port on a production run, so nothing was opened and no screenshot was taken. Extension.js ${PRODUCTION_DEBUG_PORT_FLOOR} or later does both.`);
  }

  const warn = facts.plainWords.join(" ");

  return envelope({
    ok: true,
    command: COMMAND,
    status: screenshot ? "tried" : "launched",
    value: {
      ...value,
      name,
      ...packageFacts,
      engine: { version: engine.version, used: floorMet },
      headless,
      page,
      confirmed,
      notConfirmed,
      screenshot,
      permissions: { everySite: facts.everySite, sites: facts.sites, contentScriptSites: facts.contentScriptSites, permissions: facts.permissions, optionalPermissions: facts.optionalPermissions, plainWords: facts.plainWords },
      session: { pid: launched.pid ?? null, browserPid: launched.browserPid ?? null, extensionId: launched.extensionId ?? null },
      tryPath: run.dir,
      close: { tool: COMMAND, arguments: { project, action: "close" } },
    },
    hint: `${screenshot ? `The screenshot is ${screenshot.path}; look at it before you describe the extension.` : "No screenshot was taken."} Say only what value.confirmed lists, and name what value.notConfirmed lists as not checked. Before the person relies on ${name}, tell them: ${warn} Nothing is installed in their own browser. When they are done, call ${closeCall(project)}, which ends the browser and deletes the folder and the profile.`,
    warnings: [headless ? null : "The browser window is on the person's screen and took the keyboard when it opened."],
  });
}
