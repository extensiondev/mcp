// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { describe, expect, it } from "vitest";

import { writeCredentials } from "../lib/credentials";
import { attachTrack } from "../lib/track-url";
import { handler as auth } from "../tools/auth";
import { API, useProjectRoutes, type Call } from "./fixtures/project-routes";

const WORKSPACE = "cezaraugusto";
const NOW = Math.floor(Date.now() / 1000);
const LEON = "leon.token.sig";
const LEON_ID = "prj_78a70512-a1e4-4dda-a8fd-be308279bee5";
const LEON_EXPIRES = NOW + 5 * 24 * 3600;
const REBECCAT = "rebeccat.token.sig";
const REBECCAT_ID = "prj_a017a32f-4159-42aa-8ee8-d79d35db47c3";
const REBECCAT_EXPIRES = NOW + 6 * 24 * 3600;
const PII = "pii.token.sig";
const MEMBER = "member.token.sig";
const MEMBER_EXPIRES = NOW + 7 * 24 * 3600;
const TOKENS = [LEON, REBECCAT, PII, MEMBER];

function entry(projectSlug: string, token: string, expiresAt: number, api: string, projectId?: string) {
  return {
    version: 1 as const,
    token,
    workspaceSlug: WORKSPACE,
    projectSlug,
    expiresAt,
    api,
    provider: "extensiondev" as const,
    ...(projectId ? { projectId } : {}),
  };
}

function threeLoginsNewestRebeccat() {
  writeCredentials(entry("pii-shield", PII, NOW + 3600, "https://www.extension.dev"));
  writeCredentials(entry("leon", LEON, LEON_EXPIRES, API, LEON_ID));
  writeCredentials(entry("rebeccat", REBECCAT, REBECCAT_EXPIRES, API, REBECCAT_ID));
}

function whoamiByToken(call: Call) {
  const who =
    call.auth === `Bearer ${LEON}`
      ? { slug: "leon", id: LEON_ID }
      : call.auth === `Bearer ${REBECCAT}`
        ? { slug: "rebeccat", id: REBECCAT_ID }
        : call.auth === `Bearer ${MEMBER}` && call.project.startsWith(`${WORKSPACE}/`)
          ? { slug: call.project.slice(WORKSPACE.length + 1), id: `prj_${call.project.slice(WORKSPACE.length + 1)}` }
          : null;

  return who
    ? { body: { login: `${WORKSPACE}/${who.slug}`, live: true, projectId: who.id, workspaceSlug: WORKSPACE, projectSlug: who.slug } }
    : { status: 401, body: { message: "unknown token" } };
}

async function status(args: Record<string, unknown>) {
  const raw = await auth({ action: "status", api: API, ...args });

  return JSON.parse(attachTrack("extension_auth", { action: "status", api: API, ...args }, raw));
}

function carriesNoToken(answer: unknown) {
  const text = JSON.stringify(answer);

  for (const token of TOKENS) expect(text).not.toContain(token);
}

describe("extension_auth status honors project like every token-scoped tool", () => {
  const platform = useProjectRoutes("extdev-auth-status-project-");

  it("names leon and reports leon's login, verified with leon's own bearer, while rebeccat is the newest", async () => {
    if (process.platform === "win32") return;

    threeLoginsNewestRebeccat();
    platform.routes["GET /api/cli/whoami"] = whoamiByToken;

    const out = await status({ project: `${WORKSPACE}/leon` });

    expect(out.ok).toBe(true);
    expect(out.status).toBe("logged-in");
    expect(out.value.workspaceSlug).toBe(WORKSPACE);
    expect(out.value.projectSlug).toBe("leon");
    expect(out.value.projectId).toBe(LEON_ID);
    expect(out.value.apiRecordedAtLogin).toBe(API);
    expect(out.value.expiresAt).toBe(new Date(LEON_EXPIRES * 1000).toISOString());
    expect(out.value.server).toEqual({ verdict: "confirmed", api: API, login: `${WORKSPACE}/leon`, live: true });
    expect(out.value.logins).toBeUndefined();
    expect(out.hint).toContain(`project: "${WORKSPACE}/leon"`);
    expect(out.warnings.join(" ")).not.toContain("signed in later");
    expect(platform.sent("GET", "/api/cli/whoami").map((call) => call.auth)).toEqual([`Bearer ${LEON}`]);
    expect(out.value.trackUrl).toContain(`/${WORKSPACE}/leon`);
    carriesNoToken(out);
  });

  it("with no project reports the newest login and lists every stored one with the default flagged", async () => {
    if (process.platform === "win32") return;

    threeLoginsNewestRebeccat();
    platform.routes["GET /api/cli/whoami"] = whoamiByToken;

    const out = await status({});

    expect(out.status).toBe("logged-in");
    expect(out.value.projectSlug).toBe("rebeccat");
    expect(out.value.projectId).toBe(REBECCAT_ID);
    expect(out.value.expiresAt).toBe(new Date(REBECCAT_EXPIRES * 1000).toISOString());
    expect(out.value.server.login).toBe(`${WORKSPACE}/rebeccat`);
    expect(platform.sent("GET", "/api/cli/whoami").map((call) => call.auth)).toEqual([`Bearer ${REBECCAT}`]);
    expect(out.value.logins.map((login: { project: string; server: string; active: boolean }) => [login.project, login.server, login.active])).toEqual([
      [`${WORKSPACE}/pii-shield`, "https://www.extension.dev", false],
      [`${WORKSPACE}/leon`, API, false],
      [`${WORKSPACE}/rebeccat`, API, true],
    ]);

    expect(out.value.logins.every((login: { expiresAt: string }) => typeof login.expiresAt === "string")).toBe(true);
    expect(out.hint).toContain("3 logins are stored on this machine");
    expect(out.value.trackUrl).toContain(`/${WORKSPACE}/rebeccat`);
    carriesNoToken(out);
  });

  it("a member login is one row with its project list, verified for its first project, and a project it lists is read through it", async () => {
    if (process.platform === "win32") return;

    writeCredentials(entry("leon", LEON, LEON_EXPIRES, API, LEON_ID));
    writeCredentials({
      version: 1 as const,
      token: MEMBER,
      workspaceSlug: WORKSPACE,
      projectSlug: "*",
      kind: "member",
      projectSlugs: ["visionario", "pii-shield"],
      expiresAt: MEMBER_EXPIRES,
      api: API,
      provider: "extensiondev" as const,
    });

    platform.routes["GET /api/cli/whoami"] = whoamiByToken;

    const out = await status({});

    expect(out.status).toBe("logged-in");
    expect(out.value.kind).toBe("member");
    expect(out.value.projectSlug).toBeNull();
    expect(out.value.projects).toEqual([`${WORKSPACE}/visionario`, `${WORKSPACE}/pii-shield`]);
    expect(out.value.server).toEqual({ verdict: "confirmed", api: API, login: `${WORKSPACE}/visionario`, live: true });
    expect(out.value.logins).toEqual([
      { project: `${WORKSPACE}/leon`, server: API, active: false, expiresAt: new Date(LEON_EXPIRES * 1000).toISOString(), expired: false },
      {
        project: `${WORKSPACE}/*`,
        kind: "member",
        projects: [`${WORKSPACE}/visionario`, `${WORKSPACE}/pii-shield`],
        server: API,
        active: true,
        expiresAt: new Date(MEMBER_EXPIRES * 1000).toISOString(),
        expired: false,
      },
    ]);

    expect(out.hint).toContain("as a member");
    expect(out.warnings.join(" ")).not.toContain("stale");

    const named = await status({ project: `${WORKSPACE}/pii-shield` });

    expect(named.status).toBe("logged-in");
    expect(named.value.projectSlug).toBe("pii-shield");
    expect(named.value.kind).toBe("member");
    expect(named.value.server.login).toBe(`${WORKSPACE}/pii-shield`);
    expect(platform.sent("GET", "/api/cli/whoami").map((call) => [call.auth, call.project])).toEqual([
      [`Bearer ${MEMBER}`, `${WORKSPACE}/visionario`],
      [`Bearer ${MEMBER}`, `${WORKSPACE}/pii-shield`],
    ]);

    carriesNoToken(out);
    carriesNoToken(named);
  });

  it("a project with no stored login answers not-signed-in with the login call and never reaches the platform", async () => {
    if (process.platform === "win32") return;

    threeLoginsNewestRebeccat();
    platform.routes["GET /api/cli/whoami"] = whoamiByToken;

    const out = await status({ project: `${WORKSPACE}/nowhere` });

    expect(out.ok).toBe(true);
    expect(out.status).toBe("not-signed-in");
    expect(out.value.project).toBe(`${WORKSPACE}/nowhere`);
    expect(out.value.server).toBe(API);
    expect(out.value.projectSlug).toBeUndefined();
    expect(out.value.logins.map((login: { project: string }) => login.project)).toEqual([`${WORKSPACE}/pii-shield`, `${WORKSPACE}/leon`, `${WORKSPACE}/rebeccat`]);
    expect(out.hint).toContain(`extension_auth (action: login, project: "${WORKSPACE}/nowhere")`);
    expect(out.hint).toContain(`${WORKSPACE}/leon, ${WORKSPACE}/rebeccat`);
    expect(platform.calls).toEqual([]);
    expect(typeof out.value.trackUrl).toBe("string");
    carriesNoToken(out);
  });

  it("a named login the server refuses is reported refused for that login, not for the default", async () => {
    if (process.platform === "win32") return;

    threeLoginsNewestRebeccat();
    platform.routes["GET /api/cli/whoami"] = (call) => (call.auth === `Bearer ${LEON}` ? { status: 401, body: { message: "Unrecognized release token" } } : whoamiByToken(call));

    const out = await status({ project: "leon" });

    expect(out.status).toBe("refused-by-server");
    expect(out.value.projectSlug).toBe("leon");
    expect(out.value.server.verdict).toBe("refused");
    expect(platform.sent("GET", "/api/cli/whoami").map((call) => call.auth)).toEqual([`Bearer ${LEON}`]);
    carriesNoToken(out);
  });
});
