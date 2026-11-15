// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";

import { describe, expect, it } from "vitest";

import { resolveCredential } from "../lib/credential-source";
import { clearCredentials, credentialKey, credentialsPath, listCredentials, writeCredentials } from "../lib/credentials";
import { handler as builds } from "../tools/builds";
import { handler as publish } from "../tools/publish";
import { handler as promote } from "../tools/release-promote";
import { readIdentity } from "../tools/whoami";
import { forwardable } from "../lib/hosted-forwarder";
import * as buildsActTool from "../tools/builds-act";
import * as publishTool from "../tools/publish";
import * as promoteTool from "../tools/release-promote";
import * as submitTool from "../tools/submit";
import { forwardOf, useForwardLane } from "./fixtures/forward-lane";
import { API, useProjectRoutes, type Call } from "./fixtures/project-routes";

import type { ToolModule } from "../lib/tool-dispatch";

const WORKSPACE = "cezaraugusto";
const LEON = "leon.sig";
const LEON_ID = "prj_78a70512-a1e4-4dda-a8fd-be308279bee5";
const REBECCAT = "rebeccat.sig";
const REBECCAT_ID = "prj_a017a32f-4159-42aa-8ee8-d79d35db47c3";
const FUTURE = Math.floor(Date.now() / 1000) + 3600;
const BUILD = "717bad0";
const SETTINGS = {
  chrome: { enabled: true, installCommand: "npm install", buildCommand: "npm run build", outputDirectory: "dist/chrome" },
  edge: { enabled: false, installCommand: "", buildCommand: "", outputDirectory: "" },
  firefox: { enabled: false, installCommand: "", buildCommand: "", outputDirectory: "" },
};

function entry(projectSlug: string, token: string, api = API, projectId?: string) {
  return {
    version: 1 as const,
    token,
    workspaceSlug: WORKSPACE,
    projectSlug,
    expiresAt: FUTURE,
    api,
    provider: "extensiondev" as const,
    ...(projectId ? { projectId } : {}),
  };
}

function threeLoginsActiveLeon() {
  writeCredentials(entry("pii-shield", "pii.sig", "https://www.extension.dev"));
  writeCredentials(entry("rebeccat", "rebeccat.old.sig", API, REBECCAT_ID));
  writeCredentials(entry("leon", LEON, API, LEON_ID));
}

function anotherProcessLogsIn(projectSlug: string, token: string, projectId: string) {
  const file = credentialsPath();
  const store = JSON.parse(fs.readFileSync(file, "utf8"));
  const key = credentialKey(WORKSPACE, projectSlug, API);
  store.entries[key] = entry(projectSlug, token, API, projectId);
  store.active = key;
  fs.writeFileSync(file, JSON.stringify(store));
}

function whoamiByToken(call: Call) {
  const who =
    call.auth === `Bearer ${LEON}`
      ? { slug: "leon", id: LEON_ID }
      : call.auth === `Bearer ${REBECCAT}` || call.auth === "Bearer rebeccat.old.sig"
        ? { slug: "rebeccat", id: REBECCAT_ID }
        : null;

  return who
    ? { body: { login: `${WORKSPACE}/${who.slug}`, live: true, projectId: who.id, workspaceSlug: WORKSPACE, projectSlug: who.slug } }
    : { status: 401, body: { message: "unknown token" } };
}

function onlyLeonWasSent(calls: Call[]) {
  const authed = calls.filter((call) => call.auth);

  expect(authed.length).toBeGreaterThan(0);
  expect(authed.map((call) => call.auth)).toEqual(authed.map(() => `Bearer ${LEON}`));
  expect(calls.map((call) => call.path).filter((p) => p.includes(REBECCAT_ID))).toEqual([]);
}

describe("a server keeps the login it first resolved while another process signs in to a sibling project", () => {
  const platform = useProjectRoutes("extdev-session-login-");

  function walkStartsOnLeon() {
    threeLoginsActiveLeon();
    platform.routes["GET /api/cli/whoami"] = whoamiByToken;
    expect(resolveCredential({ api: API }).ref).toEqual({ workspace: WORKSPACE, project: "leon" });
    anotherProcessLogsIn("rebeccat", REBECCAT, REBECCAT_ID);
    platform.calls.length = 0;
  }

  it("resolves leon for an unnamed call, marks it active, and says the newest login is not followed", async () => {
    if (process.platform === "win32") return;

    walkStartsOnLeon();

    const resolved = resolveCredential({ api: API });
    expect(resolved.token).toBe(LEON);
    expect(resolved.ref).toEqual({ workspace: WORKSPACE, project: "leon" });
    expect(resolved.note).toContain("keeps using cezaraugusto/leon");
    expect(resolved.note).toContain("project: 'cezaraugusto/rebeccat'");
    expect(listCredentials().filter((login) => login.active && login.server === API).map((login) => login.projectSlug)).toEqual(["leon"]);

    const status = JSON.parse(await readIdentity(undefined, API));
    expect(status.value.projectSlug).toBe("leon");
    expect(status.warnings.join(" ")).toContain("rebeccat was signed in later by another process");
  });

  describe("a platform call with no project is forwarded as the login this server first resolved", () => {
    const lane = useForwardLane();
    const forwarded = (module: unknown) => forwardable(module as ToolModule).handler as (args: Record<string, unknown>) => Promise<string>;

    it.each([
      ["extension_release_promote", promoteTool, { buildId: BUILD, channel: "preview", browsers: ["chrome"] }],
      ["extension_publish", publishTool, {}],
      ["extension_submit", submitTool, { browsers: ["chrome"], buildSha: BUILD }],
      ["extension_submit", submitTool, { action: "publish", browsers: ["chrome"] }],
      ["extension_builds_act", buildsActTool, { action: "configure", buildSettings: { firefox: { enabled: true } } }],
    ] as const)("%s with no project is exchanged with leon's login and asks the lane for leon, never rebeccat", async (tool, module, args) => {
      if (process.platform === "win32") return;

      walkStartsOnLeon();

      const out = JSON.parse(await forwarded(module)({ ...args, api: API }));

      expect(out.ok).toBe(true);
      expect(lane.exchanged()).toEqual([`Bearer ${LEON}`]);
      expect(lane.lane().map((hit) => [hit.tool, hit.authorization, hit.project])).toEqual([[tool, forwardOf(LEON), `${WORKSPACE}/leon`]]);
      expect(JSON.stringify(lane.seen)).not.toContain("rebeccat");
      expect(JSON.stringify(lane.seen)).not.toContain(REBECCAT_ID);
    });
  });

  it("a named project still wins, and a login or logout made through this server moves the default", async () => {
    if (process.platform === "win32") return;

    walkStartsOnLeon();

    expect(resolveCredential({ project: `${WORKSPACE}/rebeccat`, api: API }).token).toBe(REBECCAT);
    expect(resolveCredential({ api: API }).token).toBe(LEON);

    writeCredentials(entry("rebeccat", "rebeccat.here.sig", API, REBECCAT_ID));
    expect(resolveCredential({ api: API }).token).toBe("rebeccat.here.sig");
    expect(resolveCredential({ api: API }).note).toBeNull();

    expect(clearCredentials({ project: `${WORKSPACE}/rebeccat`, api: API }).cleared).toBe(true);
    expect(resolveCredential({ api: API }).token).toBe(LEON);
  });
});
