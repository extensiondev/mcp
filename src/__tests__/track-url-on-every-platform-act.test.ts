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
import { TOOL_POLICY } from "../lib/tool-policy";
import { attachTrack, trackUrl } from "../lib/track-url";
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

  return tools.map((tool) => tool.name).filter((name) => TOOL_POLICY[name]?.group === "platform");
}

describe("every platform act answers the console page that tracks it", () => {
  const world = usePlatformWorld("extdev-track-");

  it("has a case for every platform tool the server lists, so a new tool cannot skip trackUrl", async () => {
    const listed = await listedPlatformTools();

    expect(listed.length).toBeGreaterThanOrEqual(11);
    for (const name of listed) expect(WORLD_CASES[name]?.length ?? 0, name).toBeGreaterThan(0);
  });

  for (const [tool, cases] of Object.entries(WORLD_CASES)) {
    for (const entry of cases) {
      it(`${tool} ${entry.name} carries trackUrl on a known route and names it in the hint`, async () => {
        if (process.platform === "win32") return;
        if (entry.login !== false) world.login();

        entry.setup?.(world);

        const args = typeof entry.args === "function" ? entry.args() : entry.args;
        const out = await world.call(tool, args);
        const context = JSON.stringify({ out, missed: world.missed }).slice(0, 3000);

        if (entry.approval) {
          expect(["approval-required", "approval-pending", "authorization-pending"], context).toContain(out.status);
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
});
