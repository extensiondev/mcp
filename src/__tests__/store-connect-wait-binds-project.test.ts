// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NO_AUTO_OPEN_ENV } from "../lib/approval-open";
import { forgetConnectSessions } from "../lib/connect-session-projects";
import { credentialKey, credentialsPath } from "../lib/credentials";
import { installPlatformKernelHooks } from "../lib/platform-kernel-hooks";
import { createToolDispatcher, type ToolModule } from "../lib/tool-dispatch";
import * as submitTool from "../tools/submit-local";
import { API, useProjectRoutes } from "./fixtures/project-routes";

installPlatformKernelHooks();

const PROJECTS: Record<string, string> = { widget: "prj_widget", gadget: "prj_gadget" };
const SESSION = (slug: string) => `/api/projects/${PROJECTS[slug]}/stores/firefox/connect-session`;
const FUTURE = Math.floor(Date.now() / 1000) + 3600;

function signInBoth(): void {
  const file = credentialsPath();
  const entries = Object.fromEntries(
    Object.keys(PROJECTS).map((slug) => [credentialKey("acme", slug, API), { version: 1, token: `${slug}.sig`, workspaceSlug: "acme", projectSlug: slug, expiresAt: FUTURE, api: API, provider: "extensiondev" }]),
  );

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 2, active: credentialKey("acme", "gadget", API), entries }));
}

function session(status: "pending" | "connected") {
  return {
    body: {
      ok: true,
      session: { id: "cs_381", store: "firefox", status, userCode: "WXYZ-1234", actor: "acme", expiresAt: "2026-11-02T14:20:00.000Z", intervalSeconds: 0, ...(status === "connected" ? { connectedAs: "user:9:9", connectedAt: "2026-11-02T14:06:00.000Z" } : {}) },
    },
  };
}

async function call(args: Record<string, unknown>) {
  const dispatch = createToolDispatcher({ tools: [submitTool] as unknown as ToolModule[], options: { features: ["local", "platform"], noShip: false } });
  const frame = await dispatch({ name: "extension_submit", arguments: { api: API, ...args } });

  return JSON.parse(frame.content[0]?.text ?? "{}");
}

describe("ledger 381: the wait a connect answer hands out answers for the project that opened the session on a machine with several logins", () => {
  const platform = useProjectRoutes("extdev-connect-381-");
  let prevNoOpen: string | undefined;
  let prevGate: string | undefined;

  beforeEach(() => {
    prevNoOpen = process.env[NO_AUTO_OPEN_ENV];
    prevGate = process.env.EXTENSION_DEV_APPROVAL_GATE;
    process.env[NO_AUTO_OPEN_ENV] = "1";
    process.env.EXTENSION_DEV_APPROVAL_GATE = "0";
    forgetConnectSessions();
    signInBoth();

    platform.routes["GET /api/cli/whoami"] = (sent) => {
      const slug = sent.auth.replace(/^Bearer\s+/i, "").replace(/\.sig$/, "");

      return { body: { login: `acme/${slug}`, live: true, projectId: PROJECTS[slug], workspaceSlug: "acme", projectSlug: slug } };
    };

    platform.routes[`POST ${SESSION("widget")}`] = () => session("pending");
    platform.routes[`GET ${SESSION("widget")}`] = () => session("connected");
  });

  afterEach(() => {
    forgetConnectSessions();
    if (prevNoOpen === undefined) delete process.env[NO_AUTO_OPEN_ENV];
    else process.env[NO_AUTO_OPEN_ENV] = prevNoOpen;
    if (prevGate === undefined) delete process.env.EXTENSION_DEV_APPROVAL_GATE;
    else process.env.EXTENSION_DEV_APPROVAL_GATE = prevGate;
  });

  it("resolves the wait's project from the session, with neither project nor projectPath named", async () => {
    const first = await call({ action: "connect", store: "firefox", project: "acme/widget" });

    expect(first.status).toBe("connect-pending");

    const waited = await call({ action: "connect", store: "firefox", connectSession: "cs_381", waitSeconds: 5 });

    expect(waited.status).toBe("store-connected");
    expect(waited.value.answeredFor).toBe("acme/widget");
    expect(platform.sent("GET", SESSION("widget"))).toHaveLength(1);
    expect(platform.sent("GET", SESSION("widget"))[0]!.auth).toContain("widget.sig");
  });

  it("names the project in the wait call the first answer hands out, so the call works after this server restarts", async () => {
    const first = await call({ action: "connect", store: "firefox", project: "acme/widget" });
    const handed = /extension_submit \{action: "connect", store: "firefox", project: "acme\/widget", connectSession: "cs_381", waitSeconds: 120\}/;

    expect(first.hint).toMatch(handed);

    forgetConnectSessions();

    const bare = await call({ action: "connect", store: "firefox", connectSession: "cs_381", waitSeconds: 5 });
    const named = await call({ action: "connect", store: "firefox", project: "acme/widget", connectSession: "cs_381", waitSeconds: 5 });

    expect(bare.error.code).toBe("E_PROJECT_AMBIGUOUS");
    expect(named.status).toBe("store-connected");
  });
});
