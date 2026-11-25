// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { createServer } from "../index";
import { envelope } from "../lib/envelope";
import { runsOnPlatform } from "../lib/tool-policy";
import { attachTrack, trackFields, trackUrl } from "../lib/track-url";
import { WORLD_API, usePlatformWorld, type World } from "./fixtures/platform-world";
import { WORLD_CASES } from "./fixtures/platform-world-cases";

type Row = Record<string, unknown>;

const CONSOLE = "http://console.extension.localhost";

const CONSOLE_ROUTES = [
  "/:username",
  "/:username/:reponame",
  "/:username/:reponame/builds",
  "/:username/:reponame/builds/:buildId",
  "/:username/:reponame/builds/:buildId/:browser",
  "/:username/:reponame/releases",
  "/:username/:reponame/releases/:releaseId",
  "/:username/:reponame/submissions",
  "/:username/:reponame/submissions/:store",
  "/:username/:reponame/submissions/:store/history",
  "/:username/:reponame/submissions/:store/:submissionId",
  "/:username/:reponame/project-settings/:section",
];
const PROJECT_SETTINGS_SECTIONS = ["general", "team", "environment", "build", "deployment", "github", "channels", "stores", "visibility", "access-tokens", "share-links", "connected-apps", "danger"];
const APPROVAL_ROUTES = [/^\/device$/, /^\/device\/approve\/[^/]+$/];

function onConsoleRoute(href: string): boolean {
  const url = new URL(href);
  if (url.origin !== CONSOLE) return false;
  if (url.pathname === "/" || url.pathname === "") return true;

  const segments = url.pathname.split("/").filter(Boolean);

  return CONSOLE_ROUTES.some((route) => {
    const parts = route.split("/").filter(Boolean);
    if (parts.length !== segments.length) return false;

    return parts.every((part, i) => {
      if (part === ":section") return PROJECT_SETTINGS_SECTIONS.includes(segments[i]);
      if (part.startsWith(":")) return Boolean(segments[i]) && !["new", "settings", "stores"].includes(segments[i]) || (i === 0 && part === ":username");

      return part === segments[i];
    });
  });
}

function onApprovalRoute(href: string): boolean {
  const url = new URL(href);

  return url.origin === WORLD_API && APPROVAL_ROUTES.some((route) => route.test(url.pathname));
}

async function listedPlatformTools(): Promise<string[]> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer({ features: ["local", "platform"], noShip: false }).connect(serverTransport);
  const client = new Client({ name: "track-probe", version: "0.0.0" });
  await client.connect(clientTransport);
  const { tools } = await client.listTools();

  return tools.map((tool) => tool.name).filter((name) => runsOnPlatform(name));
}

const RUNS_HERE = ["extension_preview_web", "extension_workspace_create", "extension_project_create", "extension_auth"];

describe("every platform act answers the console page that tracks it", () => {
  const world = usePlatformWorld("extdev-track-");

  for (const [tool, cases] of Object.entries(WORLD_CASES).filter(([name]) => RUNS_HERE.includes(name))) {
    for (const entry of cases) {
      it(`${tool} ${entry.name} carries trackUrl on a known route and names it in the hint`, async () => {
        if (process.platform === "win32") return;
        if (entry.login !== false) world.login();

        entry.setup?.(world);

        const args = typeof entry.args === "function" ? entry.args() : entry.args;
        const out = await world.call(tool, args);
        const context = JSON.stringify({ out, missed: world.missed }).slice(0, 3000);

        if (entry.approval && out.status === "authorization-pending") {
          expect(out.value.trackUrl, context).toBe(out.value.verificationUriComplete ?? out.value.verificationUri);
          expect(onApprovalRoute(out.value.trackUrl), context).toBe(true);
          expect(onConsoleRoute(out.value.checkUrl), context).toBe(true);
          expect(out.hint, context).toContain(out.value.checkUrl);
          expect(out.hint.includes("value.verificationUri") || out.hint.includes(out.value.verificationUriComplete ?? out.value.verificationUri), context).toBe(true);

          return;
        }

        if (entry.approval) {
          expect(["approval-required", "approval-pending"], context).toContain(out.status);
          expect(onApprovalRoute(out.value.trackUrl), context).toBe(true);
          expect(onConsoleRoute(out.value.checkUrl), context).toBe(true);
          expect(out.hint, context).toContain(out.value.checkUrl);
        } else {
          expect(out.ok, context).toBe(true);
          expect(onConsoleRoute(out.value.trackUrl), context).toBe(true);
        }

        expect(out.hint, context).toContain(out.value.trackUrl);
      });
    }
  }

  const REFUSALS: Array<{ name: string; tool: string; args: Row; setup?: (world: World) => void; page: RegExp }> = [
    {
      name: "a project the login does not cover",
      tool: "extension_builds",
      args: { action: "get", buildId: "603fc8a", project: "acme/other", api: WORLD_API },
      page: /^\/acme\/other(\/|$)/,
    },
    {
      name: "a platform 404 on the build it asked for",
      tool: "extension_builds",
      args: { action: "get", buildId: "deadbee", api: WORLD_API },
      setup: (stage) => stage.routes.push([/^GET \/api\/projects\/prj_world\/builds\/deadbee$/, () => ({ status: 404, body: { code: "BUILD_NOT_FOUND", message: "No build deadbee." } })]),
      page: /^\/acme\/widget\/builds\/deadbee$/,
    },
    {
      name: "an argument the schema refuses",
      tool: "extension_builds",
      args: { action: "list", limit: "ten", api: WORLD_API },
      page: /^\/acme\/widget\/builds$/,
    },
    {
      name: "a store preflight the project ref refuses",
      tool: "extension_submit",
      args: { action: "preflight", browsers: ["firefox"], project: "acme/other", api: WORLD_API },
      page: /^\/acme\/other(\/|$)/,
    },
  ];

  for (const entry of REFUSALS) {
    it(`a refusal over ${entry.name} still carries the project's console page in trackUrl and names it in the hint`, async () => {
      if (process.platform === "win32") return;

      world.login();
      entry.setup?.(world);

      const out = await world.call(entry.tool, entry.args);
      const context = JSON.stringify({ out, missed: world.missed }).slice(0, 3000);

      expect(out.ok, context).toBe(false);
      expect(onConsoleRoute(out.value.trackUrl), context).toBe(true);
      expect(new URL(out.value.trackUrl).pathname, context).toMatch(entry.page);
      expect(out.hint, context).toContain(out.value.trackUrl);
      expect(context).not.toMatch(/extension-user-land-dev|\/actions\/runs\//);
    });
  }

  it("keeps a trackUrl the tool wrote on its own refusal and adds none to a refusal that names no project", () => {
    const own = `${CONSOLE}/acme/widget/submissions/safari`;
    const refused = envelope({ ok: false, command: "extension_submit", status: "store-status-refused", value: { project: "acme/widget", trackUrl: own }, error: { code: "E_PLATFORM", message: "refused" } });
    const nobody = envelope({ ok: false, command: "extension_builds", status: "not-signed-in", value: null, error: { code: "E_AUTH_REQUIRED", message: "no login" } });

    expect(attachTrack("extension_submit", { action: "status", browsers: ["safari"], api: WORLD_API }, refused)).toBe(refused);
    expect(JSON.parse(attachTrack("extension_builds", { action: "list", api: WORLD_API }, nobody)).value).toBeNull();
  });

  it("adds no console page to an answer the platform's hold refused, since the console is held too", () => {
    const held = envelope({ ok: false, command: "extension_release_promote", status: "platform-held", value: { project: "acme/widget", openSurface: "https://templates.extension.dev" }, error: { code: "E_PLATFORM", message: "extension.dev is not open to the public yet." }, hint: "Start from https://templates.extension.dev." });

    expect(attachTrack("extension_release_promote", { buildId: "abc1234", channel: "stable", api: WORLD_API }, held)).toBe(held);
  });

  it("951: links no console page for a project or workspace a closed create lane never made, and keeps the console import", () => {
    const project = envelope({ ok: false, command: "extension_project_create", status: "lane-closed", value: { workspace: "acme", createUrl: `${WORLD_API}/import?name=ghost&workspace=acme` }, error: { code: "E_PLATFORM", message: "closed", retry: "no" }, hint: "Create it in the console." });
    const workspace = envelope({ ok: false, command: "extension_workspace_create", status: "lane-closed", value: { workspace: "globex" }, error: { code: "E_PLATFORM", message: "closed", retry: "no" }, hint: "Create it in the console." });

    expect(attachTrack("extension_project_create", { project: "acme/ghost", projectPath: "/tmp/ghost", api: WORLD_API }, project)).toBe(project);
    expect(attachTrack("extension_workspace_create", { workspace: "globex", api: WORLD_API }, workspace)).toBe(workspace);
  });

  it("953: a batch refusal links the workspace its entries name, not the stored login's, and says which server answered", async () => {
    if (process.platform === "win32") return;

    world.login();
    await world.call("extension_auth", { action: "status", api: WORLD_API });
    const out = await world.call("extension_project_create", { projects: [{ project: "globex/one", repo: "octo/one", branch: "main" }], api: WORLD_API });

    expect(out.status).toBe("bad-request");
    expect(out.value.trackUrl).toBe(`${CONSOLE}/globex`);
    expect(out.hint).toContain(`${CONSOLE}/globex`);
    expect(out.hint).not.toContain(`${CONSOLE}/acme`);
    expect(out.value.server).toMatchObject({ version: expect.any(String), pid: process.pid });

    const mixed = trackFields("extension_project_create", { args: { projects: [{ project: "globex/one" }, { project: "initech/two" }], api: WORLD_API }, status: "bad-request", value: {} });

    expect(mixed?.trackUrl).toBe(CONSOLE);
  });

  it("1214: a pending batch login checks the workspace or the one project it signs in to, never the stored default login's", () => {
    if (process.platform === "win32") return;

    world.login();
    const pending = { verificationUriComplete: "https://extension.dev/device?code=ABCD-1234", verificationUri: "https://extension.dev/device" };
    const batch = trackFields("extension_auth", { args: { action: "login", projects: ["globex/one", "Globex/two"], api: WORLD_API }, status: "authorization-pending", value: pending });
    const single = trackFields("extension_auth", { args: { action: "login", projects: ["globex/one"], api: WORLD_API }, status: "authorization-pending", value: pending });
    const mixed = trackFields("extension_auth", { args: { action: "login", projects: ["globex/one", "initech/two"], api: WORLD_API }, status: "authorization-pending", value: pending });

    expect(batch?.checkUrl).toBe(`${CONSOLE}/globex`);
    expect(single?.checkUrl).toBe(`${CONSOLE}/globex/one`);
    expect(mixed?.checkUrl).toBe(CONSOLE);
  });

  it("tracks a channel change on the channel's releases and a channel delete on the Channels settings, never the builds list", () => {
    const configured = envelope({ ok: true, command: "extension_builds_act", status: "channel-configured", value: { project: "acme/widget", channel: { name: "beta" } } });
    const asked = envelope({ ok: false, command: "extension_builds_act", status: "approval-required", value: { project: "acme/widget", approvalUrl: `${WORLD_API}/device/approve/apr_1` }, error: { code: "E_APPROVAL_REQUIRED", message: "ask" } });

    expect(JSON.parse(attachTrack("extension_builds_act", { action: "configure-channel", channel: "Beta", api: WORLD_API }, configured)).value.trackUrl).toBe(`${CONSOLE}/acme/widget/releases?channel=beta`);
    expect(JSON.parse(attachTrack("extension_builds_act", { action: "configure-channel", channel: "Beta", audience: "public", api: WORLD_API }, asked)).value.checkUrl).toBe(`${CONSOLE}/acme/widget/releases?channel=beta`);
    expect(JSON.parse(attachTrack("extension_builds_act", { action: "delete-channel", channel: "beta", api: WORLD_API }, asked)).value.checkUrl).toBe(`${CONSOLE}/acme/widget/project-settings/channels`);
  });

  it("names each store's submission page for what it is on a submit to two stores, and the build page only for a build", () => {
    const submitted = envelope({
      ok: true,
      command: "extension_submit",
      status: "submitted",
      value: { project: "acme/widget", submissions: [{ store: "chrome", id: "sub_c" }, { store: "firefox", id: "sub_f" }] },
      hint: "Made: 2 submission pages.",
    });
    const shared = envelope({ ok: true, command: "extension_shares", status: "share-created", value: { project: "acme/widget", buildSha: "603fc8a" }, hint: "Shared." });
    const two = JSON.parse(attachTrack("extension_submit", { browsers: ["chrome", "firefox"], buildSha: "603fc8a", dryRun: false, api: WORLD_API }, submitted));

    expect(two.hint).toBe(`Made: 2 submission pages. Track it at ${CONSOLE}/acme/widget/submissions/chrome/sub_c. The firefox submission page is ${CONSOLE}/acme/widget/submissions/firefox/sub_f.`);
    expect(two.value.trackLinks).toEqual([`${CONSOLE}/acme/widget/submissions/chrome/sub_c`, `${CONSOLE}/acme/widget/submissions/firefox/sub_f`]);
    expect(two.hint).not.toContain("build page");
    expect(JSON.parse(attachTrack("extension_shares", { action: "create", api: WORLD_API }, shared)).hint).toBe(
      `Shared. Track it at ${CONSOLE}/acme/widget/project-settings/share-links. The build page is ${CONSOLE}/acme/widget/builds/603fc8a.`,
    );
  });

  it("builds each act's page from the call's api, never the env", () => {
    process.env.EXTENSION_DEV_API_URL = WORLD_API;

    expect(trackUrl("build", { workspace: "acme", project: "widget", buildId: "603fc8a" }, "https://www.extension.dev")).toBe(
      "https://console.extension.dev/acme/widget/builds/603fc8a",
    );

    expect(trackUrl("release", { workspace: "acme", project: "widget", channel: "beta" }, WORLD_API)).toBe(`${CONSOLE}/acme/widget/releases?channel=beta`);
    expect(trackUrl("submission", { workspace: "acme", project: "widget", store: "chrome", submissionId: "sub_1" }, WORLD_API)).toBe(
      `${CONSOLE}/acme/widget/submissions/chrome/sub_1`,
    );

    expect(trackUrl("store", { workspace: "acme", project: "widget", store: "firefox" }, WORLD_API)).toBe(`${CONSOLE}/acme/widget/submissions/firefox`);
    expect(trackUrl("build-settings", { workspace: "acme", project: "widget" }, WORLD_API)).toBe(`${CONSOLE}/acme/widget/project-settings/build`);
    expect(trackUrl("share-links", { workspace: "acme", project: "widget" }, WORLD_API)).toBe(`${CONSOLE}/acme/widget/project-settings/share-links`);
  });

  it("853: tracks a preflight whose Store publishing switch is off at the store settings, like every connect status", () => {
    const page = (status: string) => trackFields("extension_submit", { args: { action: "preflight", browsers: ["firefox"], project: "acme/widget", api: WORLD_API }, status, value: {} })?.trackUrl;

    expect(page("store-publishing-off")).toBe(`${CONSOLE}/acme/widget/project-settings/stores`);
    expect(page("store-not-connected")).toBe(`${CONSOLE}/acme/widget/project-settings/stores`);
    expect(page("preflight-read")).toBe(`${CONSOLE}/acme/widget/submissions/firefox`);
  });
});
