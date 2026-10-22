import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveCredential } from "../lib/credential-source";
import { listCredentials, readCredentials, writeCredentials } from "../lib/credentials";
import { envelope } from "../lib/envelope";
import { openProjectApi, projectApiReadFailure } from "../lib/project-api";
import { loginToProject } from "../tools/login";

const API = "http://localhost:3100";
const PROJECT_ID = "prj_a017a32f";
const ENV_KEYS = ["XDG_CONFIG_HOME", "EXTENSION_DEV_API_URL", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_PROJECT"];
const saved: Record<string, string | undefined> = {};
const SENTENCE =
  "The project cezaraugusto/pii-shield is now cezaraugusto/rebeccat; its login moved with it, pass project: 'cezaraugusto/rebeccat' from now on.";
let tmp: string;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

function whoamiAnswers(projectSlug: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      const pathname = new URL(String(url)).pathname;

      if (pathname === "/api/cli/whoami") {
        return jsonResponse({
          login: `cezaraugusto/${projectSlug}`,
          live: true,
          projectId: PROJECT_ID,
          workspaceSlug: "cezaraugusto",
          projectSlug,
        });
      }

      return jsonResponse({ message: "not found" }, 404);
    }),
  );
}

let minted = 0;
let token = "";

function storedLogin(projectSlug = "pii-shield") {
  minted += 1;
  token = `claims.sig${minted}`;
  writeCredentials({
    version: 1,
    token,
    workspaceSlug: "cezaraugusto",
    projectSlug,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    api: API,
    provider: "extensiondev",
  });
}

function drain(): string[] {
  return JSON.parse(envelope({ ok: true, command: "probe", status: "ok" })).warnings;
}

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-renamed-"));
  process.env.XDG_CONFIG_HOME = tmp;
  delete process.env.EXTENSION_DEV_API_URL;
  delete process.env.EXTENSION_DEV_TOKEN;
  delete process.env.EXTENSION_DEV_PROJECT;
  drain();
});

afterEach(() => {
  vi.unstubAllGlobals();
  drain();

  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("a stored login whose project was renamed on the platform", () => {
  it("moves the login to the slug whoami answers, records the project id, and says so once", async () => {
    storedLogin();
    whoamiAnswers("rebeccat");

    const opened = await openProjectApi({ command: "extension_builds", project: "cezaraugusto/pii-shield", api: API });

    expect(opened.ok).toBe(true);
    expect(opened.ok && opened.api.projectId).toBe(PROJECT_ID);

    const logins = listCredentials();
    expect(logins.map((entry) => `${entry.workspaceSlug}/${entry.projectSlug}`)).toEqual(["cezaraugusto/rebeccat"]);
    expect(logins[0]?.projectId).toBe(PROJECT_ID);
    expect(logins[0]?.token).toBe(token);
    expect(logins[0]?.active).toBe(true);

    const answer = JSON.parse(envelope({ ok: true, command: "extension_builds", status: "listed" }));
    expect(answer.warnings).toEqual([SENTENCE]);
    expect(drain()).toEqual([]);
  });

  it("answers the old name once more through the alias, then drops it", async () => {
    storedLogin();
    whoamiAnswers("rebeccat");
    await openProjectApi({ command: "extension_builds", project: "cezaraugusto/pii-shield", api: API });
    drain();

    const aliased = readCredentials({ project: "cezaraugusto/pii-shield", api: API });
    expect(aliased).toMatchObject({ projectSlug: "rebeccat", movedFrom: "cezaraugusto/pii-shield" });

    const resolved = resolveCredential({ project: "cezaraugusto/pii-shield", api: API });
    expect(resolved.ref).toEqual({ workspace: "cezaraugusto", project: "rebeccat" });
    expect(resolved.note).toBe(SENTENCE);
    expect(drain()).toEqual([SENTENCE]);

    expect(readCredentials({ project: "cezaraugusto/pii-shield", api: API })).toBeNull();
    expect(readCredentials({ project: "cezaraugusto/rebeccat", api: API })?.token).toBe(token);
  });

  it("records the project id on a login whose slug did not change", async () => {
    storedLogin();
    whoamiAnswers("pii-shield");

    await openProjectApi({ command: "extension_builds", project: "cezaraugusto/pii-shield", api: API });

    expect(listCredentials()).toHaveLength(1);
    expect(readCredentials({ project: "cezaraugusto/pii-shield", api: API })?.projectId).toBe(PROJECT_ID);
    expect(drain()).toEqual([]);
  });
});

describe("a platform refusal that names where the project went", () => {
  it("moves the login on PROJECT_MOVED and names the new address", () => {
    storedLogin();

    const out = JSON.parse(
      projectApiReadFailure(
        "extension_workspace",
        {
          ok: false,
          status: 404,
          code: "PROJECT_MOVED",
          message: "answered 404: The project cezaraugusto/pii-shield is now cezaraugusto/rebeccat.",
          held: false,
          body: {
            code: "PROJECT_MOVED",
            projectId: PROJECT_ID,
            workspaceSlug: "cezaraugusto",
            projectSlug: "rebeccat",
            previousProjectSlug: "pii-shield",
          },
        },
        { api: API, name: "Workspace", context: { workspace: "cezaraugusto", project: "cezaraugusto/pii-shield" } },
      ),
    );

    expect(out.status).toBe("moved");
    expect(out.error).toMatchObject({ code: "E_PLATFORM", name: "WorkspaceProjectMoved", platformCode: "PROJECT_MOVED" });
    expect(out.hint).toBe(SENTENCE);
    expect(listCredentials().map((entry) => entry.projectSlug)).toEqual(["rebeccat"]);
    expect(readCredentials({ project: "cezaraugusto/rebeccat", api: API })?.projectId).toBe(PROJECT_ID);
  });

  it("tells an agent how to find the new slug when an older platform only says PROJECT_NOT_FOUND", () => {
    const out = JSON.parse(
      projectApiReadFailure(
        "extension_workspace",
        {
          ok: false,
          status: 404,
          code: "PROJECT_NOT_FOUND",
          message: "https://www.extension.dev/api/projects answered 404: The project for this token was not found.",
          held: false,
          body: { code: "PROJECT_NOT_FOUND" },
        },
        { name: "Workspace", context: { workspace: "cezaraugusto", project: "cezaraugusto/pii-shield" } },
      ),
    );

    expect(out.error.platformCode).toBe("PROJECT_NOT_FOUND");
    expect(out.hint).toContain('extension_workspace (action: "projects", workspace: "cezaraugusto")');
    expect(out.hint).toContain('extension_auth (action: "login", project: "cezaraugusto/<new-slug>")');
  });

  it("names the new address when the device login is refused with PROJECT_MOVED", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const href = String(url);

        if (href.endsWith("/api/cli/login/config")) {
          return jsonResponse({
            deviceCodeUrl: "/api/cli/device/code",
            deviceTokenUrl: "/api/cli/device/token",
            verificationUri: `${API}/device`,
          });
        }

        if (href.endsWith("/api/cli/device/token")) {
          return jsonResponse(
            {
              error: "access_denied",
              code: "PROJECT_MOVED",
              message: "The project cezaraugusto/pii-shield is now cezaraugusto/rebeccat. Start the login again with 'cezaraugusto/rebeccat'; every login already minted for it keeps working.",
              authorizationValid: false,
              projectId: PROJECT_ID,
              workspaceSlug: "cezaraugusto",
              projectSlug: "rebeccat",
              previousProjectSlug: "pii-shield",
              refusedAt: "approval",
            },
            404,
          );
        }

        return jsonResponse({ message: "not found" }, 404);
      }),
    );

    const out = JSON.parse(
      await loginToProject({ project: "cezaraugusto/pii-shield", deviceCode: "dev-code", api: API }),
    );

    expect(out.status).toBe("project-moved");
    expect(out.error.name).toBe("LoginProjectMoved");
    expect(out.value).toMatchObject({ platformCode: "PROJECT_MOVED", projectId: PROJECT_ID, movedTo: "cezaraugusto/rebeccat" });
    expect(out.hint).toContain('extension_auth (action: "login", project: "cezaraugusto/rebeccat")');
  });
});
