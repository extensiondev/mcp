// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { ConsoleProjectPage } from "@extension.dev/urls/paths";

import { consoleProjectUrl } from "./console-urls";
import { envelope } from "./envelope";
import { projectApiGet, type ProjectApi } from "./project-api";
import { type ProjectRef } from "./registry";
import { isRow, text } from "./ship-act";
import { nextStep, type NextStep } from "./store-connection";

type Row = Record<string, unknown>;

export const BROWSER_BUILDS_OFF_STATE = "browser-builds-off" as const;
export const BUILD_ARTIFACT_MISSING_STATE = "build-artifact-missing" as const;

export type BrowserBuildState = typeof BROWSER_BUILDS_OFF_STATE | typeof BUILD_ARTIFACT_MISSING_STATE;

const BROWSER_NAMES: Record<string, string> = { chrome: "Chrome", edge: "Edge", firefox: "Firefox", safari: "Safari" };

export function isBrowserBuildState(state: string): state is BrowserBuildState {
  return state === BROWSER_BUILDS_OFF_STATE || state === BUILD_ARTIFACT_MISSING_STATE;
}

export interface BrowserBuildRead {
  browser: string;
  enabled: boolean | null;
  artifact: boolean | null;
  buildSha: string;
}

export interface BrowserBuildVerdict {
  state: BrowserBuildState;
  browser: string;
  buildSha: string;
  enabled: boolean;
  artifact: boolean | null;
  reason: string;
  fix: string;
  configureCall: string;
  rebuildCall: string;
  settingsUrl: string;
}

interface Context {
  ref: ProjectRef | null;
  api?: string;
}

function enabledOf(json: Row, browser: string): boolean | null {
  const flags = isRow(json.enabledBrowsers) ? json.enabledBrowsers : null;
  const settings = isRow(json.buildSettings) ? json.buildSettings : null;

  if (flags && typeof flags[browser] === "boolean") return flags[browser];

  const row = settings && isRow(settings[browser]) ? settings[browser] : null;

  return row && typeof row.enabled === "boolean" ? row.enabled : null;
}

function builtBrowsersOf(json: Row): string[] | null {
  const build = isRow(json.build) ? json.build : json;
  if (!Array.isArray(build.browsers)) return null;

  const names = build.browsers.map((row) => (isRow(row) ? text(row.browser) || text(row.name) : text(row)).toLowerCase()).filter(Boolean);

  return names.length ? names : null;
}

export async function readBrowserBuilds(api: ProjectApi, browsers: string[], buildSha: string): Promise<Record<string, BrowserBuildRead>> {
  const sha = text(buildSha).toLowerCase();
  const [settings, detail] = await Promise.all([
    projectApiGet<Row>(api, "settings/build").catch(() => null),
    sha ? projectApiGet<Row>(api, `builds/${encodeURIComponent(sha)}`).catch(() => null) : Promise.resolve(null),
  ]);
  const built = detail && detail.ok && isRow(detail.json) ? builtBrowsersOf(detail.json) : null;
  const read: Record<string, BrowserBuildRead> = {};

  for (const browser of browsers) {
    read[browser] = {
      browser,
      enabled: settings && settings.ok && isRow(settings.json) ? enabledOf(settings.json, browser) : null,
      artifact: built ? built.includes(browser) : null,
      buildSha: sha,
    };
  }

  return read;
}

export function browserBuildVerdict(read: BrowserBuildRead | undefined, ctx: Context): BrowserBuildVerdict | null {
  if (!read || read.enabled === null) return null;
  if (read.enabled && read.artifact !== false) return null;

  const { browser, buildSha } = read;
  const name = BROWSER_NAMES[browser] ?? browser;
  const settingsUrl = consoleProjectUrl(ctx.ref, ConsoleProjectPage.projectSettingsSection("build"), ctx.api);
  const configureCall = `extension_builds {action: "configure", buildSettings: {${browser}: {enabled: true}}}`;
  const rebuildCall = `extension_builds {action: "rebuild"${buildSha ? `, buildSha: "${buildSha}"` : ""}}`;
  const buildOnce = `build once (a push, or ${rebuildCall}) and submit the build that carries the ${browser} artifact`;
  const base = { browser, buildSha, enabled: read.enabled, artifact: read.artifact, configureCall, rebuildCall, settingsUrl };

  if (!read.enabled) {
    return {
      ...base,
      state: BROWSER_BUILDS_OFF_STATE,
      reason:
        read.artifact === false
          ? `Build ${buildSha} has no ${browser} artifact because ${name} builds are off for this project.`
          : `${name} builds are off for this project, so no build carries a ${browser} artifact.`,
      fix: `Switch ${name} builds on with ${configureCall} (a workspace owner approves the settings change once) or under Browser builds at ${settingsUrl}; then ${buildOnce}.`,
    };
  }

  return {
    ...base,
    state: BUILD_ARTIFACT_MISSING_STATE,
    reason: `Build ${buildSha} has no ${browser} artifact, and ${name} builds are on for this project.`,
    fix: `${buildOnce[0]!.toUpperCase()}${buildOnce.slice(1)}.`,
  };
}

export async function browserBuildVerdicts(api: ProjectApi, browsers: string[], buildSha: string, ctx: Context): Promise<Record<string, BrowserBuildVerdict>> {
  const read = await readBrowserBuilds(api, browsers, buildSha);
  const verdicts: Record<string, BrowserBuildVerdict> = {};

  for (const browser of browsers) {
    const verdict = browserBuildVerdict(read[browser], ctx);
    if (verdict) verdicts[browser] = verdict;
  }

  return verdicts;
}

export function browserBuildStep(verdict: Pick<BrowserBuildVerdict, "reason" | "fix" | "settingsUrl">): NextStep {
  return nextStep("configure", `${verdict.reason} ${verdict.fix}`, verdict.settingsUrl);
}

export function browserBuildSettingsUrl(ctx: Context): string {
  return consoleProjectUrl(ctx.ref, ConsoleProjectPage.projectSettingsSection("build"), ctx.api);
}

export function browserBuildsView(verdict: BrowserBuildVerdict): Row {
  return {
    state: verdict.state,
    enabled: verdict.enabled,
    ...(verdict.buildSha ? { buildSha: verdict.buildSha } : {}),
    ...(verdict.artifact !== null ? { artifact: verdict.artifact } : {}),
    configureCall: verdict.configureCall,
    rebuildCall: verdict.rebuildCall,
    settingsUrl: verdict.settingsUrl,
  };
}

export function withBrowserBuildVerdict(view: Row, verdict: BrowserBuildVerdict): Row {
  const summary = isRow(view.summary) ? view.summary : {};
  const count = (value: unknown) => (typeof value === "number" ? value + 1 : 1);
  const check = {
    id: `${verdict.browser}.builds`,
    label: `${BROWSER_NAMES[verdict.browser] ?? verdict.browser} builds`,
    severity: "blocking",
    message: verdict.reason,
    fix: verdict.fix,
  };

  return {
    ...view,
    canSubmit: false,
    summary: { ...summary, fail: count(summary.fail), blockingFailures: count(summary.blockingFailures), canSubmit: false },
    failing: [check, ...(Array.isArray(view.failing) ? view.failing : [])],
    browserBuilds: browserBuildsView(verdict),
  };
}

export function browserBuildRefusal(verdict: BrowserBuildVerdict, browsers: string[], buildSha: string): string {
  const step = browserBuildStep(verdict);

  return envelope({
    ok: false,
    command: "extension_submit",
    status: verdict.state,
    error: {
      code: "E_PLATFORM",
      name: verdict.state === BROWSER_BUILDS_OFF_STATE ? "BrowserBuildsOff" : "BuildArtifactMissing",
      message: `${verdict.reason} Nothing was submitted and no approval was asked for.`,
    },
    value: {
      browsers,
      buildSha,
      verdict: verdict.state,
      browserBuilds: browserBuildsView(verdict),
      trackUrl: verdict.settingsUrl,
      sayToPerson: step.say,
      nextStep: step,
    },
    hint: step.say,
  });
}
