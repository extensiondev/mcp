import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handler, schema } from "../tools/project-create";
import { readCredentials } from "../lib/credentials";
import { pendingCreate } from "../lib/pending-creates";
import { readZipEntry, readZipEntryNames } from "../lib/zip-entries";

const API = "https://api.test";
const FUTURE = Math.floor(Date.now() / 1000) + 900;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(
    typeof body === "string" ? body : JSON.stringify(body),
    { status },
  );
}

type Route = { status: number; body: unknown };

function createFetch(routes: {
  code?: Route;
  token: Route[];
  source?: Route;
  create?: Route;
}) {
  let tokenCalls = 0;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = vi.fn(async (url: any, init?: RequestInit) => {
    const href = String(url);
    calls.push({ url: href, init });

    if (href.endsWith("/api/cli/login/config")) {
      return jsonResponse({
        deviceCodeUrl: "/api/cli/device/code",
        deviceTokenUrl: "/api/cli/device/token",
        verificationUri: "https://extension.dev/device",
      });
    }

    if (href.endsWith("/api/cli/device/code")) {
      const route = routes.code ?? {
        status: 200,
        body: {
          device_code: "dev-code",
          user_code: "ABCD-1234",
          verification_uri: "https://extension.dev/device",
          verification_uri_complete:
            "https://extension.dev/device?code=ABCD-1234",
          interval: 30,
          expires_in: 900,
        },
      };

      return jsonResponse(route.body, route.status);
    }

    if (href.endsWith("/api/cli/device/token")) {
      const next =
        routes.token[Math.min(tokenCalls, routes.token.length - 1)] ?? {
          status: 400,
          body: { error: "authorization_pending" },
        };
      tokenCalls += 1;

      return jsonResponse(next.body, next.status);
    }

    if (href.endsWith("/api/cli/projects/source") && routes.source) {
      return jsonResponse(routes.source.body, routes.source.status);
    }

    if (href.endsWith("/api/cli/projects/create")) {
      const route = routes.create ?? { status: 500, body: { message: "no" } };

      return jsonResponse(route.body, route.status);
    }

    throw new Error(`Unexpected fetch: ${href}`);
  });

  return { fn, calls };
}

const UPLOADED = {
  status: 200,
  body: { uploadId: "upl_1", bytes: 1234, files: 4, manifest: { name: "Ghost", version: "1.0.0" }, expiresAt: "2026-11-11T12:00:00.000Z" },
};

const CREATED = {
  status: 200,
  body: { success: true, projectId: "prj_new", projectSlug: "ghost-app", workspaceSlug: "acme", idempotencyKey: "idem-1", initialBuild: { dispatched: true } },
};

const grantBody = {
  token: "provision-token",
  expiresAt: FUTURE,
  ttlSeconds: 900,
  workspaceSlug: "acme",
  projectSlug: "ghost-app",
  tokenKind: "provisioning",
};

const baseArgs = {
  project: "acme/ghost-app",
  repo: "acme/ghost-app-src",
};

let tmp: string;
let prevXdg: string | undefined;
let prevApi: string | undefined;

function extensionFolder(name: string, extra: Record<string, string | Buffer> = {}): string {
  const dir = path.join(tmp, name);

  const write = (rel: string, data: string | Buffer) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), data);
  };

  write("manifest.json", JSON.stringify({ name: "Ghost", version: "1.0.0", manifest_version: 3 }));
  write("package.json", JSON.stringify({ name: "ghost-app" }));
  write("src/content.js", "console.log(1)");
  write("node_modules/dep/index.js", "x");
  write("dist/chrome/manifest.json", "{}");
  write(".git/HEAD", "ref: refs/heads/main");
  write(".extension-dev/state.json", "{}");
  write("ghost.zip", "zip");
  write(".gitignore", "secret.txt\nlogs/\n*.bak\n");
  write("secret.txt", "s");
  write("logs/a.log", "l");
  write("src/old.bak", "b");
  write(".env", "TOKEN=1");
  write(".env.example", "TOKEN=");
  write("config/.env.local", "TOKEN=2");
  write("certs/key.pem", "-----BEGIN");

  for (const [rel, data] of Object.entries(extra)) write(rel, data);

  return dir;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-projcreate-"));
  prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmp;
  prevApi = process.env.EXTENSION_DEV_API_URL;
  process.env.EXTENSION_DEV_API_URL = API;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  if (prevApi === undefined) delete process.env.EXTENSION_DEV_API_URL;
  else process.env.EXTENSION_DEV_API_URL = prevApi;

  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("extension_project_create", () => {
  it("declares itself for the moment before extension_auth", () => {
    expect(schema.name).toBe("extension_project_create");
    expect(schema.description).toContain("BEFORE extension_auth");
    expect(schema.inputSchema.required).toEqual([]);
  });

  it("still refuses a single call that names no project before any network call", async () => {
    const { fn } = createFetch({ token: [] });
    vi.stubGlobal("fetch", fn);

    for (const args of [{}, { repo: "acme/src" }]) {
      const out = JSON.parse(await handler(args as never));
      expect(out.ok).toBe(false);
      expect(out.error.code).toBe("E_BAD_REQUEST");
    }

    expect(fn).not.toHaveBeenCalled();
  });

  it("489: asks for a source only once the platform has opened the lane, naming projectPath first and repo second", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(tmp);
    const { fn, calls } = createFetch({ token: [] });
    vi.stubGlobal("fetch", fn);

    const out = JSON.parse(await handler({ project: "acme/ghost-app" }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("bad-request");
    expect(out.error.code).toBe("E_BAD_REQUEST");
    expect(out.error.message).toContain("projectPath");
    expect(out.error.message).toContain("repo '<owner>/<repo>'");
    expect(out.error.message).toContain(tmp);
    expect(out.error.message).not.toContain("GitHub only");
    expect(out.hint).toContain("projectPath");
    expect(out.hint).toContain("nothing has to be pushed");
    expect(out.hint).toContain(`${API}/import`);
    expect(out.value.needs).toBe("source");
    expect(calls.some((c) => c.url.endsWith("/api/cli/device/code"))).toBe(true);
    expect(calls.some((c) => c.url.endsWith("/api/cli/device/token"))).toBe(false);
  });

  it("489: refuses a projectPath with no manifest.json before any network call, naming the path", async () => {
    const { fn } = createFetch({ token: [] });
    vi.stubGlobal("fetch", fn);
    const bare = path.join(tmp, "bare");
    fs.mkdirSync(bare);

    const out = JSON.parse(await handler({ project: "acme/ghost-app", projectPath: bare }));

    expect(out.ok).toBe(false);
    expect(out.error.code).toBe("E_BAD_REQUEST");
    expect(out.error.message).toContain(bare);
    expect(out.error.message).toContain("manifest.json");
    expect(fn).not.toHaveBeenCalled();
  });

  it("489: refuses repo and projectPath together before any network call", async () => {
    const { fn } = createFetch({ token: [] });
    vi.stubGlobal("fetch", fn);

    const out = JSON.parse(await handler({ ...baseArgs, projectPath: extensionFolder("ext") }));

    expect(out.error.code).toBe("E_BAD_REQUEST");
    expect(out.error.message).toContain("not both");
    expect(fn).not.toHaveBeenCalled();
  });

  it("489: refuses before any network call when the zip would pass 4 MB, naming the biggest three entries", async () => {
    const { fn } = createFetch({ token: [] });
    vi.stubGlobal("fetch", fn);
    const dir = extensionFolder("heavy", {
      "media/a.bin": crypto.randomBytes(1_700_000),
      "media/b.bin": crypto.randomBytes(1_600_000),
      "media/c.bin": crypto.randomBytes(1_500_000),
      "media/d.bin": crypto.randomBytes(100_000),
    });

    const out = JSON.parse(await handler({ project: "acme/ghost-app", projectPath: dir }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("source-too-large");
    expect(out.error.code).toBe("E_BAD_REQUEST");
    expect(out.error.message).toContain(dir);
    expect(out.error.message).toContain("4 MB");
    expect(out.error.message).toContain("media/a.bin (1.6 MB), media/b.bin (1.5 MB), media/c.bin (1.4 MB)");
    expect(out.value.biggest.map((entry: { path: string }) => entry.path)).toEqual(["media/a.bin", "media/b.bin", "media/c.bin"]);
    expect(out.value.maxBytes).toBe(4 * 1024 * 1024);
    expect(out.hint).toContain(".gitignore");
    expect(fn).not.toHaveBeenCalled();
  });

  it("489: uploads the folder as a zip with the provisioning grant, leaving out node_modules, dist, .git, archives, .gitignore entries and secrets, then creates from the uploadId", async () => {
    const dir = extensionFolder("ext");
    const { fn, calls } = createFetch({ token: [{ status: 200, body: grantBody }], source: UPLOADED, create: CREATED });
    vi.stubGlobal("fetch", fn);

    const out = JSON.parse(await handler({ project: "acme/ghost-app", projectPath: dir, deviceCode: "dev-code" }));

    const sourceAt = calls.findIndex((c) => c.url.endsWith("/api/cli/projects/source"));
    const createAt = calls.findIndex((c) => c.url.endsWith("/api/cli/projects/create"));
    expect(sourceAt).toBeGreaterThanOrEqual(0);
    expect(sourceAt).toBeLessThan(createAt);

    const upload = calls[sourceAt]!.init!;
    const headers = upload.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer provision-token");
    expect(headers["content-type"]).toBe("application/zip");
    const zip = Buffer.from(upload.body as Uint8Array);
    const zipFile = path.join(tmp, "sent.zip");
    fs.writeFileSync(zipFile, zip);
    const listing = readZipEntryNames(zipFile);
    expect(listing.readable).toBe(true);
    expect(listing.names.sort()).toEqual([".env.example", ".gitignore", "manifest.json", "package.json", "src/content.js"]);
    const manifest = readZipEntry(zip, "manifest.json", { maxEntries: 100, maxBytes: 1_000_000 });
    expect(manifest.ok && JSON.parse(manifest.data.toString("utf8")).name).toBe("Ghost");

    const body = JSON.parse(String(calls[createAt]!.init?.body));
    expect(body.source).toEqual({ uploadId: "upl_1" });
    expect(body.github).toBeUndefined();
    expect(body.createdFrom).toEqual({ kind: "upload", ref: "upl_1" });
    expect(body.workspaceSlug).toBe("acme");
    expect(body.info.name).toBe("ghost-app");

    expect(out.ok).toBe(true);
    expect(out.status).toBe("created");
    expect(out.value.projectId).toBe("prj_new");
    expect(out.value.source).toBe("upload");
    expect(out.value.uploaded).toEqual({ bytes: 1234, files: 4 });
    expect(out.value.leftOut).toEqual({ secrets: [".env", "certs/key.pem", "config/.env.local"] });
    expect(out.value.projectPath).toBe(dir);
    expect(out.value.sourceRepo).toBeUndefined();
    expect(out.value.firstBuild).toEqual({ dispatched: true, spent: 1 });
    expect(out.value.nextSteps.join(" ")).toContain("extension_builds (action: list, project: 'acme/ghost-app')");
    expect(out.hint).toContain("nothing was pushed");
    expect(out.hint).toContain("extension_builds (action: list");
    expect(out.warnings ?? []).toEqual([]);
  });

  it("489: keeps the GitHub path's answer shape and names its source", async () => {
    const { fn } = createFetch({ token: [{ status: 200, body: grantBody }], create: CREATED });
    vi.stubGlobal("fetch", fn);

    const out = JSON.parse(await handler({ ...baseArgs, deviceCode: "dev-code" }));

    expect(out.value.source).toBe("github");
    expect(out.value.sourceRepo).toBe("acme/ghost-app-src");
    expect(out.value.uploaded).toBeUndefined();
    expect(fn.mock.calls.some(([url]) => String(url).endsWith("/api/cli/projects/source"))).toBe(false);
  });

  it("489: uploads the server's cwd when neither repo nor projectPath is given and the cwd holds a manifest, and says so", async () => {
    const dir = extensionFolder("ext");
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    const { fn, calls } = createFetch({ token: [{ status: 200, body: grantBody }], source: UPLOADED, create: CREATED });
    vi.stubGlobal("fetch", fn);

    const out = JSON.parse(await handler({ project: "acme/ghost-app", deviceCode: "dev-code" }));

    expect(out.status).toBe("created");
    expect(out.value.source).toBe("upload");
    expect(out.value.projectPath).toBe(dir);
    expect(calls.some((c) => c.url.endsWith("/api/cli/projects/source"))).toBe(true);
    expect(out.warnings).toContainEqual(expect.stringContaining(`server's cwd ${dir}`));
  });

  it.each([
    [413, { code: "SOURCE_TOO_LARGE", message: "The upload is 5 MB; 4 MB is the most." }, "SOURCE_TOO_LARGE"],
    [400, { message: "The archive holds node_modules/dep/index.js, which must stay out." }, "node_modules/dep/index.js"],
  ])("489: relays a %s refusal of the upload, sends no create and keeps the grant for the retry", async (status, body, words) => {
    const dir = extensionFolder("ext");
    const { fn, calls } = createFetch({ token: [{ status: 200, body: grantBody }], source: { status, body } });
    vi.stubGlobal("fetch", fn);

    const out = JSON.parse(await handler({ project: "acme/ghost-app", projectPath: dir, deviceCode: "dev-code" }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("source-refused");
    expect(out.error.code).toBe("E_BAD_REQUEST");
    expect(out.error.message).toContain(words);
    expect(out.error.message).toContain("Nothing was created");
    expect(out.value.deviceCode).toBe("dev-code");
    expect(out.hint).toContain("same deviceCode");
    expect(calls.some((c) => c.url.endsWith("/api/cli/projects/create"))).toBe(false);
  });

  it("489: calls a 409 SOURCE_UPLOAD_CONSUMED create unconfirmed, never created and never failed", async () => {
    const dir = extensionFolder("ext");
    const { fn } = createFetch({
      token: [{ status: 200, body: grantBody }],
      source: UPLOADED,
      create: { status: 409, body: { code: "SOURCE_UPLOAD_CONSUMED", message: "Upload upl_1 was already used." } },
    });
    vi.stubGlobal("fetch", fn);

    const out = JSON.parse(await handler({ project: "acme/ghost-app", projectPath: dir, deviceCode: "dev-code" }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("create-unconfirmed");
    expect(out.error.message).toContain("already consumed");
    expect(out.error.message).toContain("is unknown");
    expect(out.hint).toContain("again with this same deviceCode");
  });

  it("says the lane is closed before it asks for a repo", async () => {
    const { fn } = createFetch({
      code: {
        status: 403,
        body: {
          error: "access_denied",
          message: "Headless project creation is not open on this host yet.",
          code: "CLI_PROJECT_CREATE_DISABLED",
        },
      },
      token: [],
    });
    vi.stubGlobal("fetch", fn);

    const out = JSON.parse(await handler({ project: "acme/ghost-app" }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("lane-closed");
    expect(out.error.code).toBe("E_PLATFORM");
    expect(out.value.createUrl).toBe(`${API}/import?name=ghost-app&workspace=acme`);
    expect(out.value.prefilled).toEqual(["name", "workspace"]);
    expect(out.value.askedOnTheForm).toEqual(["repository", "browsers"]);
    expect(out.hint).toContain(out.value.createUrl);
    expect(out.hint).toContain("GitHub repository the source is pushed to");
  });

  it("carries a prefilled create form link when the lane is closed", async () => {
    const { fn } = createFetch({
      code: {
        status: 403,
        body: {
          error: "access_denied",
          message: "Headless project creation is not open on this host yet.",
          code: "CLI_PROJECT_CREATE_DISABLED",
        },
      },
      token: [],
    });
    vi.stubGlobal("fetch", fn);

    const out = JSON.parse(await handler(baseArgs));

    expect(out.status).toBe("lane-closed");
    expect(out.value.createUrl).toBe(`${API}/import?repository=acme%2Fghost-app-src&name=ghost-app&workspace=acme`);
    expect(out.value.prefilled).toEqual(["repository", "name", "workspace"]);
    expect(out.value.askedOnTheForm).toEqual(["browsers"]);
    expect(out.value.consoleUrl).toBeDefined();
    expect(out.hint).toContain("Create the project in the console");
    expect(out.hint).toContain(out.value.createUrl);
    expect(out.hint).toContain("repository acme/ghost-app-src, name ghost-app and workspace acme prefilled");
    expect(out.hint).toContain("extension_builds (action: configure)");
    expect(out.hint).toContain("extension_auth (action: login)");
  });

  it("489: says in its description that the platform takes the source from the folder or from a GitHub repository", () => {
    expect(schema.description).toContain("projectPath");
    expect(schema.description).toContain("GitHub repo");
    expect(schema.description).not.toContain("GitHub only");
    expect(schema.description).not.toContain("no call uploads");
    expect(schema.inputSchema.properties.projectPath.description).toContain("manifest.json");
    expect(schema.inputSchema.properties.projectPath.description).toContain("default: the cwd");
    expect(schema.inputSchema.properties.repo.description).not.toContain("required");
    expect(schema.inputSchema.properties.repo.description).toContain("instead of projectPath");
  });

  it("asks for no installation id, because the platform resolves it", () => {
    expect(schema.inputSchema.required).not.toContain("installationId");
    expect(schema.inputSchema.properties.installationId.description).toContain(
      "connect link",
    );
  });

  it("refuses a malformed project before any network call", async () => {
    const { fn } = createFetch({ token: [] });
    vi.stubGlobal("fetch", fn);
    const out = JSON.parse(
      await handler({ ...baseArgs, project: "no-slash" }),
    );
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe("E_BAD_REQUEST");
    expect(fn).not.toHaveBeenCalled();
  });

  it("refuses to send the grant to a hostile api argument", async () => {
    const { fn } = createFetch({ token: [] });
    vi.stubGlobal("fetch", fn);
    const out = JSON.parse(
      await handler({ ...baseArgs, api: "https://evil.example" }),
    );
    expect(out.ok).toBe(false);
    expect(out.error.message).toContain("Refusing to send the access token");
    expect(fn).not.toHaveBeenCalled();
  });

  it("returns the device code and approval link when authorization is pending", async () => {
    const { fn } = createFetch({
      token: [{ status: 400, body: { error: "authorization_pending" } }],
    });
    vi.stubGlobal("fetch", fn);
    const out = JSON.parse(await handler(baseArgs));
    expect(out.ok).toBe(true);
    expect(out.status).toBe("authorization-pending");
    expect(out.error).toBeNull();
    expect(out.value.deviceCode).toBe("dev-code");
    expect(out.value.verificationUriComplete).toContain("ABCD-1234");
    expect(out.value.expiresInSeconds).toBe(900);
    expect(Date.parse(out.value.expiresAt) - Date.now()).toBeGreaterThan(890_000);
    expect(out.hint).toContain("The code expires at");
    expect(out.hint).toContain("waitSeconds: 900");
    expect(out.hint).toContain("blocks until the owner approves");
    expect(pendingCreate(API, "acme/ghost-app")).toEqual({
      userCode: "ABCD-1234",
      verificationUri: "https://extension.dev/device",
      verificationUriComplete: "https://extension.dev/device?code=ABCD-1234",
      expiresAt: out.value.expiresAt,
    });
  });

  it("drops the pending create record once the code is spent", async () => {
    const pending = createFetch({ token: [{ status: 400, body: { error: "authorization_pending" } }] });
    vi.stubGlobal("fetch", pending.fn);
    await handler(baseArgs);
    expect(pendingCreate(API, "acme/ghost-app")).not.toBeNull();

    const expired = createFetch({ token: [{ status: 400, body: { error: "expired_token", message: "The device code has expired." } }] });
    vi.stubGlobal("fetch", expired.fn);
    const out = JSON.parse(await handler({ ...baseArgs, deviceCode: "dev-code" }));
    expect(out.status).toBe("create-expired");
    expect(pendingCreate(API, "acme/ghost-app")).toBeNull();
  });

  it("says why an approved code can still read as expired and how to restart", async () => {
    const { fn } = createFetch({
      token: [{ status: 400, body: { error: "expired_token", message: "The device code has expired." } }],
    });
    vi.stubGlobal("fetch", fn);
    const out = JSON.parse(await handler({ ...baseArgs, deviceCode: "dev-code" }));
    expect(out.status).toBe("create-expired");
    expect(out.error.code).toBe("E_AUTH_EXPIRED");
    expect(out.error.message).toContain("fifteen minutes");
    expect(out.error.message).toContain("no project was created");
    expect(out.error.message).toContain("without the old deviceCode");
  });

  it("relays the server's closed-lane message verbatim", async () => {
    const serverSentence =
      "extension.dev is not open to the public yet. Project creation will be available when the platform opens.";
    const { fn } = createFetch({
      code: {
        status: 403,
        body: {
          error: "access_denied",
          message: serverSentence,
          code: "CLI_PROJECT_CREATE_DISABLED",
        },
      },
      token: [],
    });
    vi.stubGlobal("fetch", fn);
    const out = JSON.parse(await handler(baseArgs));
    expect(out.ok).toBe(false);
    expect(out.status).toBe("lane-closed");
    expect(out.error.message).toBe(serverSentence);
    expect(out.error.message.toLowerCase()).not.toContain("console");
    expect(out.hint).toContain("public hold");
    expect(out.hint).toContain("console answers its gate page");
    expect(out.hint).not.toContain("Create the project in the console");
    expect(out.hint).not.toContain("every workspace");
  });

  it("falls back to the console pointer only when the server sends no message", async () => {
    const { fn } = createFetch({
      code: {
        status: 403,
        body: {
          error: "access_denied",
          code: "CLI_PROJECT_CREATE_DISABLED",
        },
      },
      token: [],
    });
    vi.stubGlobal("fetch", fn);
    const out = JSON.parse(await handler(baseArgs));
    expect(out.ok).toBe(false);
    expect(out.status).toBe("lane-closed");
    expect(out.error.message).toContain("Headless project creation is not open on");
    expect(out.hint).toContain("Create the project in the console");
    expect(out.hint).toContain("extension_auth");
  });

  it("creates the project with the provisioning grant and stores nothing locally", async () => {
    const { fn, calls } = createFetch({
      token: [{ status: 200, body: grantBody }],
      create: {
        status: 200,
        body: {
          success: true,
          message: "Repository created successfully",
          projectId: "prj_new",
          projectSlug: "ghost-app",
          workspaceSlug: "acme",
          idempotencyKey: "idem-1",
          initialBuild: { dispatched: true },
        },
      },
    });
    vi.stubGlobal("fetch", fn);
    const out = JSON.parse(
      await handler({ ...baseArgs, deviceCode: "dev-code" }),
    );
    expect(out.ok).toBe(true);
    expect(out.status).toBe("created");
    expect(out.value.projectId).toBe("prj_new");
    expect(out.value.firstBuild).toEqual({ dispatched: true, spent: 1 });
    expect(out.hint).toContain("Its first build was dispatched.");
    expect(out.value.allowance.spent).toContain("including its first build");
    expect(out.warnings ?? []).toEqual([]);
    expect(out.value.nextSteps[0]).toContain("extension_auth");

    const createCall = calls.find((c) =>
      c.url.endsWith("/api/cli/projects/create"),
    );
    expect(createCall).toBeDefined();
    const headers = (createCall!.init?.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe("Bearer provision-token");
    const body = JSON.parse(String(createCall!.init?.body));
    expect(body.github).toMatchObject({
      owner: "acme",
      repo: "ghost-app-src",
    });

    expect(body.github.installationId).toBeUndefined();
    expect(body.origin).toBeUndefined();
    expect(body.createdFrom).toEqual({
      kind: "repository",
      ref: "acme/ghost-app-src",
    });

    expect(readCredentials()).toBeNull();
  });

  async function createBodyFor(extra: Record<string, unknown>) {
    const { fn, calls } = createFetch({
      token: [{ status: 200, body: grantBody }],
      create: {
        status: 200,
        body: {
          success: true,
          projectId: "prj_new",
          projectSlug: "ghost-app",
          workspaceSlug: "acme",
        },
      },
    });
    vi.stubGlobal("fetch", fn);
    await handler({ ...baseArgs, deviceCode: "dev-code", ...extra });
    const createCall = calls.find((c) =>
      c.url.endsWith("/api/cli/projects/create"),
    );

    return JSON.parse(String(createCall!.init?.body));
  }

  it("keeps the Chrome-only default when no browsers are named, with the browser named in the build command", async () => {
    const body = await createBodyFor({});
    expect(body.build.chrome).toMatchObject({
      enabled: true,
      buildCommand: "npm run build -- --browser chrome",
      outputDirectory: "dist/chrome",
    });

    expect(body.build.edge.enabled).toBe(false);
    expect(body.build.firefox.enabled).toBe(false);
  });

  it("names each enabled browser in its own default build command", async () => {
    const body = await createBodyFor({ browsers: ["chrome", "edge", "firefox"] });

    for (const name of ["chrome", "edge", "firefox"]) {
      expect(body.build[name]).toMatchObject({
        enabled: true,
        buildCommand: `npm run build -- --browser ${name}`,
        outputDirectory: `dist/${name}`,
      });
    }
  });

  it("enables every named browser with its own Extension.js output", async () => {
    const body = await createBodyFor({
      browsers: ["chrome", "edge", "firefox"],
      installCommand: "pnpm install",
      buildCommand: "pnpm build",
    });

    for (const name of ["chrome", "edge", "firefox"]) {
      expect(body.build[name]).toEqual({
        enabled: true,
        installCommand: "pnpm install",
        buildCommand: "pnpm build",
        outputDirectory: `dist/${name}`,
      });
    }
  });

  it("fills a <browser> placeholder and lets a per-browser override win", async () => {
    const body = await createBodyFor({
      browsers: ["chrome", "edge", "firefox"],
      buildCommand: "pnpm build -- --browser <browser>",
      outputDirectory: "packages/ext/dist/<browser>",
      outputDirectories: { edge: "build/manifestv3" },
    });
    expect(body.build.firefox.buildCommand).toBe("pnpm build -- --browser firefox");
    expect(body.build.chrome.outputDirectory).toBe("packages/ext/dist/chrome");
    expect(body.build.edge.outputDirectory).toBe("build/manifestv3");
    expect(body.build.firefox.outputDirectory).toBe(
      "packages/ext/dist/firefox",
    );
  });

  it("sends intent create when starting the device flow", async () => {
    const { fn, calls } = createFetch({
      token: [{ status: 400, body: { error: "authorization_pending" } }],
    });
    vi.stubGlobal("fetch", fn);
    await handler(baseArgs);
    const codeCall = calls.find((c) => c.url.endsWith("/api/cli/device/code"));
    expect(codeCall).toBeDefined();
    expect(JSON.parse(String(codeCall!.init?.body)).intent).toBe("create");
  });

  it("keeps the login the platform minted when the project already exists, so no second approval is asked", async () => {
    const { fn } = createFetch({
      token: [
        {
          status: 200,
          body: { ...grantBody, token: "login-token", tokenKind: undefined },
        },
      ],
    });
    vi.stubGlobal("fetch", fn);
    const out = JSON.parse(
      await handler({ ...baseArgs, deviceCode: "dev-code" }),
    );
    expect(out.ok).toBe(true);
    expect(out.status).toBe("project-exists-logged-in");
    expect(out.value).toMatchObject({ workspaceSlug: "acme", projectSlug: "ghost-app", stored: true });
    expect(out.hint).toMatch(/no second approval is needed/);
    const { readCredentials } = await import("../lib/credentials");
    expect(readCredentials({ project: "acme/ghost-app" })?.token).toBe("login-token");
  });

  it("answers lane-closed with the platform's code when the lane shut between approval and poll", async () => {
    const { fn } = createFetch({
      token: [
        {
          status: 403,
          body: { error: "access_denied", code: "CLI_PROJECT_CREATE_DISABLED", message: "Headless project creation is closed on this host." },
        },
      ],
    });
    vi.stubGlobal("fetch", fn);
    const out = JSON.parse(await handler({ ...baseArgs, deviceCode: "dev-code" }));
    expect(out.status).toBe("lane-closed");
    expect(out.error.message).toMatch(/closed on this host/);
    expect(out.hint).not.toMatch(/this workspace is not on it/);
  });

  it("relays the platform's own sentence for an unknown or redeemed device code", async () => {
    const { fn } = createFetch({
      token: [
        {
          status: 400,
          body: { error: "expired_token", error_description: "This device code was already redeemed. Start the flow again." },
        },
      ],
    });
    vi.stubGlobal("fetch", fn);
    const out = JSON.parse(await handler({ ...baseArgs, deviceCode: "dev-code" }));
    expect(out.status).toBe("create-expired");
    expect(out.error.message).toMatch(/already redeemed/);
  });

  it("refuses a grant scoped to a different project and creates nothing", async () => {
    const { fn, calls } = createFetch({
      token: [
        {
          status: 200,
          body: { ...grantBody, projectSlug: "other-app" },
        },
      ],
    });
    vi.stubGlobal("fetch", fn);
    const out = JSON.parse(
      await handler({ ...baseArgs, deviceCode: "dev-code" }),
    );
    expect(out.ok).toBe(false);
    expect(out.error.message).toContain("Nothing was created");
    expect(
      calls.some((c) => c.url.endsWith("/api/cli/projects/create")),
    ).toBe(false);
  });

  it("surfaces a denial from the device page", async () => {
    const { fn } = createFetch({
      token: [{ status: 400, body: { error: "access_denied" } }],
    });
    vi.stubGlobal("fetch", fn);
    const out = JSON.parse(
      await handler({ ...baseArgs, deviceCode: "dev-code" }),
    );
    expect(out.ok).toBe(false);
    expect(out.status).toBe("create-denied");
    expect(out.error.code).toBe("E_AUTH_DENIED");
  });

  it("carries an explicit installationId through when an operator names one", async () => {
    const { fn, calls } = createFetch({
      token: [{ status: 200, body: grantBody }],
      create: {
        status: 200,
        body: { success: true, projectId: "prj_new" },
      },
    });
    vi.stubGlobal("fetch", fn);
    await handler({
      ...baseArgs,
      deviceCode: "dev-code",
      installationId: "99999999",
    });

    const createCall = calls.find((c) =>
      c.url.endsWith("/api/cli/projects/create"),
    );
    const body = JSON.parse(String(createCall!.init?.body));
    expect(body.github.installationId).toBe("99999999");
  });

  it("refuses a malformed installationId override without a network call", async () => {
    const { fn } = createFetch({ token: [] });
    vi.stubGlobal("fetch", fn);
    const out = JSON.parse(
      await handler({ ...baseArgs, installationId: "not-a-number" }),
    );
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe("E_BAD_REQUEST");
    expect(fn).not.toHaveBeenCalled();
  });

  it("echoes the platform's connect link and never builds one", async () => {
    const { fn } = createFetch({
      token: [{ status: 200, body: grantBody }],
      create: {
        status: 403,
        body: {
          message: "The extension.dev GitHub App is not installed on octocat.",
          code: "INSTALLATION_ABSENT",
          connectUrl:
            "https://www.extension.dev/connect/github?next=project-create",
        },
      },
    });
    vi.stubGlobal("fetch", fn);
    const out = JSON.parse(
      await handler({ ...baseArgs, deviceCode: "dev-code" }),
    );
    expect(out.ok).toBe(false);
    expect(out.status).toBe("installation-required");
    expect(out.value.connectUrl).toBe(
      "https://www.extension.dev/connect/github?next=project-create",
    );

    expect(out.hint).toContain("Nothing was created");
  });

  it("says what to do when the platform sends no connect link", async () => {
    const { fn } = createFetch({
      token: [{ status: 200, body: grantBody }],
      create: {
        status: 409,
        body: {
          message: "octocat holds 2 installations.",
          code: "INSTALLATION_AMBIGUOUS",
        },
      },
    });
    vi.stubGlobal("fetch", fn);
    const out = JSON.parse(
      await handler({ ...baseArgs, deviceCode: "dev-code" }),
    );
    expect(out.ok).toBe(false);
    expect(out.status).toBe("installation-required");
    expect(out.value).toBeNull();
    expect(out.hint).toContain("Nothing was created");
  });

  it("surfaces a server refusal of the create call honestly", async () => {
    const { fn } = createFetch({
      token: [{ status: 200, body: grantBody }],
      create: {
        status: 403,
        body: {
          message: "That GitHub App installation is not on the account that approved this grant.",
          code: "INSTALLATION_NOT_HELD",
        },
      },
    });
    vi.stubGlobal("fetch", fn);
    const out = JSON.parse(
      await handler({ ...baseArgs, deviceCode: "dev-code" }),
    );
    expect(out.ok).toBe(false);
    expect(out.status).toBe("create-failed");
    expect(out.error.message).toContain("403");
    expect(out.error.message).toContain(
      "installation is not on the account that approved",
    );
  });

  async function createdWith(body: Record<string, unknown>) {
    const { fn } = createFetch({
      token: [{ status: 200, body: grantBody }],
      create: {
        status: 200,
        body: {
          success: true,
          message: "Repository created successfully",
          projectId: "prj_new",
          projectSlug: "ghost-app",
          workspaceSlug: "acme",
          idempotencyKey: "idem-1",
          ...body,
        },
      },
    });
    vi.stubGlobal("fetch", fn);

    return JSON.parse(await handler({ ...baseArgs, deviceCode: "dev-code" }));
  }

  it.each([
    ["allowance_exhausted", "used its build allowance"],
    ["no_commits", "no commits yet"],
    ["no_build_workflow", "no build workflow"],
    ["dispatch_paused", "paused on the platform"],
    ["dispatch_failed", "could not"],
  ])(
    "does not claim a first build the platform withheld (%s)",
    async (reason, words) => {
      const out = await createdWith({
        initialBuild: { dispatched: false, reason },
      });

      expect(out.ok).toBe(true);
      expect(out.status).toBe("created");
      expect(out.value.firstBuild).toEqual({ dispatched: false, reason });
      expect(out.hint).not.toContain("Its first build was dispatched");
      expect(out.hint).toContain("No first build was dispatched");
      expect(out.hint).toContain(words);
      expect(out.hint).toContain("/builds");
      expect(out.value.allowance.spent).not.toContain("including its first build");
      expect(out.warnings.join(" ")).toContain(words);
      expect(out.value.nextSteps.join(" ")).toContain("extension_release_status");
    },
  );

  it("relays a reason it has no sentence for instead of dropping it", async () => {
    const out = await createdWith({
      initialBuild: { dispatched: false, reason: "some_future_reason" },
    });

    expect(out.hint).toContain("some_future_reason");
  });

  it("claims no build when the answer does not say one was dispatched", async () => {
    const out = await createdWith({});

    expect(out.ok).toBe(true);
    expect(out.value.firstBuild).toEqual({ dispatched: null });
    expect(out.hint).not.toContain("Its first build was dispatched");
    expect(out.hint).toContain("did not say whether a first build was dispatched");
    expect(out.warnings.join(" ")).toContain("did not say");
  });

  it.each([[{ dispatched: "true" }], [{ dispatched: 1 }], ["yes"], [[true]]])(
    "takes only a literal true for dispatched (%j)",
    async (initialBuild) => {
      const out = await createdWith({ initialBuild });

      expect(out.value.firstBuild).toEqual({ dispatched: null });
      expect(out.hint).not.toContain("Its first build was dispatched");
    },
  );

  it("reads the workspace's plan with a stored login of that workspace before the create, and says what the first build leaves", async () => {
    const { writeCredentials } = await import("../lib/credentials");
    writeCredentials({ version: 1, token: "other.sig", workspaceSlug: "acme", projectSlug: "other-app", expiresAt: FUTURE + 3600, api: API });
    const { fn, calls } = createFetch({
      token: [{ status: 200, body: grantBody }],
      create: {
        status: 200,
        body: { success: true, projectId: "prj_new", projectSlug: "ghost-app", workspaceSlug: "acme", idempotencyKey: "idem-1", initialBuild: { dispatched: true } },
      },
    });
    const routed = vi.fn(async (url: any, init?: RequestInit) => {
      if (String(url).endsWith("/api/workspaces/acme/plan")) {
        calls.push({ url: String(url), init });

        return jsonResponse({ plan: "pro", limits: { buildsPerMonth: 350, projects: 10 }, used: { buildsThisMonth: 342, projects: 3 } });
      }

      return fn(url, init);
    });
    vi.stubGlobal("fetch", routed);

    const out = JSON.parse(await handler({ ...baseArgs, deviceCode: "dev-code" }));

    expect(out.status).toBe("created");
    expect(out.value.firstBuild).toEqual({ dispatched: true, spent: 1 });
    expect(out.value.allowance.remains).toBe("Before this call the workspace had 8 of 350 builds left this month; the first build spends one, leaving 7.");
    expect(out.value.allowance.remaining).toBe(7);
    expect(out.value.allowance.warning).toBe("7 builds remain of 350 this month; each project creation spends one, and so does a push to the build branch that changes a file under the root directory; a push to another branch, one that changes only docs or license files outside public/, or one whose head commit says [skip build] (or [skip ci], or carries an Extension-Build: skip trailer) spends nothing (extension_builds list names each skipped push with its outcome).");

    const planCall = calls.findIndex((c) => c.url.endsWith("/api/workspaces/acme/plan"));
    const createCall = calls.findIndex((c) => c.url.endsWith("/api/cli/projects/create"));

    expect(planCall).toBeGreaterThanOrEqual(0);
    expect(planCall).toBeLessThan(createCall);
    expect((calls[planCall]!.init?.headers as Record<string, string>).authorization).toBe("Bearer other.sig");
    expect(calls.filter((c) => c.url.endsWith("/plan"))).toHaveLength(1);
  });

  it("asks the platform for no plan without a login of that workspace, and still says the first build spent one", async () => {
    const out = await createdWith({ initialBuild: { dispatched: true } });

    expect(out.value.firstBuild).toEqual({ dispatched: true, spent: 1 });
    expect(out.value.allowance.remains).toContain("never invents one");
    expect(out.value.allowance.remains).toContain("The first build spent one of the month's allowance");
    expect(out.value.allowance.remaining).toBeUndefined();

    const withheld = await createdWith({ initialBuild: { dispatched: false, reason: "no_commits" } });

    expect(withheld.value.firstBuild).toEqual({ dispatched: false, reason: "no_commits" });
    expect(withheld.value.allowance.remains).not.toContain("first build spent one");
  });

  it("says in its description that the first build spends one of the monthly allowance", () => {
    expect(schema.description).toContain("spends one build of the workspace's monthly allowance");
  });

  async function createAnswers(create: Route | "no-answer") {
    const { fn } = createFetch({
      token: [{ status: 200, body: grantBody }],
      ...(create === "no-answer" ? {} : { create }),
    });
    const routed = vi.fn(async (url: any, init?: RequestInit) => {
      if (create === "no-answer" && String(url).endsWith("/api/cli/projects/create")) {
        throw new Error("socket hang up");
      }

      return fn(url, init);
    });
    vi.stubGlobal("fetch", routed);

    return JSON.parse(await handler({ ...baseArgs, deviceCode: "dev-code" }));
  }

  it.each([
    ["no answer at all", "no-answer" as const, "no answer came back"],
    ["a gateway timeout", { status: 504, body: "<html>504</html>" }, "in front of the platform"],
    ["a bare server error", { status: 500, body: { message: "no" } }, "no platform code"],
    ["an empty 200", { status: 200, body: "" }, "did not carry success: true"],
    ["an empty object", { status: 200, body: {} }, "did not carry success: true"],
    ["a page of html", { status: 200, body: "<html>ok</html>" }, "did not carry success: true"],
    ["success with no id", { status: 200, body: { success: true } }, "named no project id"],
    [
      "success with no names",
      { status: 200, body: { success: true, projectId: "prj_new" } },
      "did not name the workspace and project",
    ],
  ])("calls %s unconfirmed, never created and never failed", async (_label, create, words) => {
    const out = await createAnswers(create as Route | "no-answer");

    expect(out.ok).toBe(false);
    expect(out.status).toBe("create-unconfirmed");
    expect(out.error.message).toContain(words);
    expect(out.error.message).toContain("is unknown");
    expect(out.hint).toContain("again with this same deviceCode and the same arguments");
    expect(out.hint).toContain("never creates acme/ghost-app twice");
  });

  it("keeps a failure the platform named a failure", async () => {
    const out = await createAnswers({
      status: 500,
      body: { message: "Project creation was rolled back.", code: "PROJECT_CREATE_ROLLED_BACK" },
    });

    expect(out.status).toBe("create-failed");
    expect(out.error.message).toContain("rolled back");
  });

  it("reports the names the platform registered, not the ones asked for", async () => {
    const out = await createdWith({
      projectSlug: "ghost-app-2",
      initialBuild: { dispatched: true },
    });

    expect(out.status).toBe("created");
    expect(out.value.projectSlug).toBe("ghost-app-2");
    expect(out.warnings.join(" ")).toContain("registered this project as acme/ghost-app-2");
    expect(out.value.nextSteps[0]).toContain("acme/ghost-app-2");
  });
});
