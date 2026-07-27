import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { schema, handler, storeMdWarnings } from "../tools/submit";
import { writeCredentials } from "../lib/credentials";
import { tools as ALL_TOOLS } from "../index";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("extension_submit: registration + schema", () => {
  it("is registered under the extension_submit name", () => {
    expect(schema.name).toBe("extension_submit");
    expect(ALL_TOOLS.map((t) => t.schema.name)).toContain("extension_submit");
  });

  it("requires browsers + buildSha and exposes no credential/zip/path property", () => {
    const req = (schema.inputSchema as { required: string[] }).required;
    expect(req).toContain("browsers");
    expect(req).toContain("buildSha");
    const props = Object.keys(
      (schema.inputSchema as { properties: Record<string, unknown> }).properties,
    );
    for (const p of props) {
      expect(p).not.toMatch(
        /secret|token|apiKey|clientId|clientSecret|refreshToken|serviceAccount|zip|publisherId/i,
      );
    }
  });
});

describe("extension_submit: platform submit handler", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevToken: string | undefined;
  let prevFetch: typeof fetch;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-submit-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevToken = process.env.EXTENSION_DEV_TOKEN;
    prevFetch = global.fetch;
    process.env.XDG_CONFIG_HOME = tmp;
    delete process.env.EXTENSION_DEV_TOKEN;
  });

  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevToken === undefined) delete process.env.EXTENSION_DEV_TOKEN;
    else process.env.EXTENSION_DEV_TOKEN = prevToken;
    global.fetch = prevFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("fails with SubmitAuthError before any fetch when no token resolves", async () => {
    let called = false;
    global.fetch = (async () => {
      called = true;
      return jsonResponse({});
    }) as unknown as typeof fetch;
    const out = JSON.parse(
      await handler({ browsers: ["chrome"], buildSha: "abc1234" }),
    );
    expect(out.ok).toBe(false);
    expect(out.status).toBe("auth-required");
    expect(out.error.code).toBe("E_AUTH_REQUIRED");
    expect(out.error.name).toBe("SubmitAuthError");
    expect(called).toBe(false);
  });

  it("fails with SubmitInputError before any fetch when browsers/buildSha missing", async () => {
    process.env.EXTENSION_DEV_TOKEN = "tok";
    let called = false;
    global.fetch = (async () => {
      called = true;
      return jsonResponse({});
    }) as unknown as typeof fetch;
    const noBrowsers = JSON.parse(
      await handler({ browsers: [], buildSha: "abc1234" }),
    );
    expect(noBrowsers.error.name).toBe("SubmitInputError");
    expect(noBrowsers.error.code).toBe("E_BAD_REQUEST");
    const noSha = JSON.parse(
      await handler({ browsers: ["chrome"], buildSha: "" }),
    );
    expect(noSha.error.name).toBe("SubmitInputError");
    expect(called).toBe(false);
  });

  it("POSTs to /api/cli/stores/submit with a bearer token, dry-run by default", async () => {
    process.env.EXTENSION_DEV_TOKEN = "tok-123";
    let captured: { url: string; init: any } | null = null;
    global.fetch = (async (url: string, init: any) => {
      captured = { url, init };
      return jsonResponse({ ok: true, dryRun: true, message: "Preflight OK" });
    }) as unknown as typeof fetch;

    const out = JSON.parse(
      await handler({
        browsers: ["chrome", "Firefox"],
        buildSha: "abc1234",
        api: "https://www.extension.dev",
      }),
    );

    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("https://www.extension.dev/api/cli/stores/submit");
    expect(captured!.init.method).toBe("POST");
    expect(captured!.init.headers.authorization).toBe("Bearer tok-123");
    const body = JSON.parse(captured!.init.body);
    expect(body.browsers).toEqual(["chrome", "firefox"]);
    expect(body.buildSha).toBe("abc1234");
    expect(body.dryRun).toBe(true);
    expect(out.value.mode).toBe("platform");
    expect(out.ok).toBe(true);
    expect(out.status).toBe("preflight");
    expect(out.value.platformMessage).toBe("Preflight OK");
    expect(out.value.preflight).toHaveLength(2);
    for (const row of out.value.preflight) {
      expect(row.ok).toBe(false);
      expect(row.configured).toBe("unknown");
    }
    expect(out.hint).toContain("cannot be verified");
    expect(out.hint).toContain("advisory only");
  });

  it("keeps a platform-reported failure primary when no local ref exists", async () => {
    process.env.EXTENSION_DEV_TOKEN = "tok";
    global.fetch = (async () =>
      jsonResponse({
        ok: false,
        dryRun: true,
        message: "Build abc1234 has no completed build",
      })) as unknown as typeof fetch;
    const out = JSON.parse(
      await handler({ browsers: ["chrome"], buildSha: "abc1234" }),
    );
    expect(out.ok).toBe(false);
    expect(out.hint).toContain("FAILED");
    expect(out.hint).toContain("Build abc1234 has no completed build");
    expect(out.hint).not.toContain("the platform verified");
  });

  it("keeps a platform failure primary even when store credentials are healthy", async () => {
    process.env.EXTENSION_DEV_TOKEN = "tok";
    writeCredentials({
      version: 1,
      token: "tok",
      workspaceSlug: "acme",
      projectSlug: "widget",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      api: "https://www.extension.dev",
    });
    global.fetch = (async (url: string) => {
      const u = String(url);
      if (u.includes("/api/cli/stores/submit")) {
        return jsonResponse({ ok: false, dryRun: true, message: "Denied" });
      }
      if (u.includes("stores/health.json")) {
        return jsonResponse({ stores: { chrome: { ok: true } } });
      }
      if (u.includes("channels.json")) {
        return jsonResponse({ stable: { sha: "abc1234" } });
      }
      return jsonResponse({});
    }) as unknown as typeof fetch;
    const out = JSON.parse(
      await handler({ browsers: ["chrome"], buildSha: "abc1234" }),
    );
    expect(out.value.preflight[0].ok).toBe(true);
    expect(out.ok).toBe(false);
    expect(out.hint).toContain("FAILED");
    expect(out.hint).not.toContain("the platform verified");
  });

  it("still fails the dry run when every requested store is definitively blocked", async () => {
    process.env.EXTENSION_DEV_TOKEN = "tok";
    writeCredentials({
      version: 1,
      token: "tok",
      workspaceSlug: "acme",
      projectSlug: "widget",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      api: "https://www.extension.dev",
    });
    global.fetch = (async (url: string) => {
      const u = String(url);
      if (u.includes("/api/cli/stores/submit")) {
        return jsonResponse({ ok: true, dryRun: true });
      }
      if (u.includes("stores/health.json")) {
        return jsonResponse({ stores: {} });
      }
      if (u.includes("channels.json")) {
        return jsonResponse({ stable: { sha: "abc1234" } });
      }
      return jsonResponse({});
    }) as unknown as typeof fetch;
    const out = JSON.parse(
      await handler({ browsers: ["chrome"], buildSha: "abc1234" }),
    );
    expect(out.ok).toBe(false);
    expect(out.value.preflight[0].configured).toBe(false);
    expect(out.hint).toContain("NOT actionable");
  });

  it("reads STORE.md from projectPath instead of the server's cwd", async () => {
    process.env.EXTENSION_DEV_TOKEN = "tok";
    global.fetch = (async () =>
      jsonResponse({ ok: true, dryRun: true })) as unknown as typeof fetch;
    const project = path.join(tmp, "project");
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(
      path.join(project, "STORE.md"),
      [
        "## firefox-amo",
        "### Reviewer notes",
        "Test account and steps.",
        "## Edge Add-ons",
        "### Certification notes",
        "Guidance.",
      ].join("\n"),
    );
    const elsewhere = path.join(tmp, "elsewhere");
    fs.mkdirSync(elsewhere, { recursive: true });
    const prevCwd = process.cwd();
    process.chdir(elsewhere);
    try {
      const out = JSON.parse(
        await handler({
          browsers: ["firefox", "edge"],
          buildSha: "abc1234",
          projectPath: project,
        }),
      );
      expect(
        out.warnings.some((w: string) => w.includes("No STORE.md")),
      ).toBe(false);
    } finally {
      process.chdir(prevCwd);
    }
  });

  it("passes dryRun:false through only when explicitly set", async () => {
    process.env.EXTENSION_DEV_TOKEN = "tok";
    let body: any = null;
    global.fetch = (async (_url: string, init: any) => {
      body = JSON.parse(init.body);
      return jsonResponse({ ok: true, submissions: [] });
    }) as unknown as typeof fetch;
    await handler({ browsers: ["edge"], buildSha: "def5678", dryRun: false });
    expect(body.dryRun).toBe(false);
  });

  it("attaches STORE.md warnings to the result without blocking it", async () => {
    process.env.EXTENSION_DEV_TOKEN = "tok";
    global.fetch = (async () =>
      jsonResponse({ ok: true, dryRun: true })) as unknown as typeof fetch;
    const prevCwd = process.cwd();
    process.chdir(tmp);
    try {
      const out = JSON.parse(
        await handler({ browsers: ["firefox"], buildSha: "abc1234" }),
      );
      expect(out.warnings).toHaveLength(2);
      expect(out.warnings[0]).toContain("No STORE.md");
      expect(out.warnings[1]).toBe("channel: stable (default)");
      expect(out.value.preflight[0].reason).not.toContain("STORE.md");
    } finally {
      process.chdir(prevCwd);
    }
  });

  it("surfaces a non-OK response as SubmitError", async () => {
    process.env.EXTENSION_DEV_TOKEN = "tok";
    global.fetch = (async () =>
      jsonResponse(
        { message: "Build not found", code: "UNKNOWN_BUILD" },
        false,
        404,
      )) as unknown as typeof fetch;
    const out = JSON.parse(
      await handler({ browsers: ["chrome"], buildSha: "deadbeef" }),
    );
    expect(out.ok).toBe(false);
    expect(out.status).toBe("submit-failed");
    expect(out.error.code).toBe("E_PLATFORM");
    expect(out.error.name).toBe("SubmitError");
    expect(out.error.message).toContain("404");
  });
});

describe("storeMdWarnings", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-storemd-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("stays silent for chrome-only submissions", () => {
    expect(storeMdWarnings(["chrome"], tmp)).toEqual([]);
  });

  it("warns once when STORE.md is missing entirely", () => {
    const warnings = storeMdWarnings(["firefox", "edge"], tmp);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("No STORE.md");
  });

  it("warns per store for empty or absent note fields", () => {
    fs.writeFileSync(
      path.join(tmp, "STORE.md"),
      [
        "## Firefox Add-ons",
        "### Reviewer notes",
        "<!-- fill me in -->",
        "## Edge Add-ons",
        "### Certification notes",
        "Real guidance here.",
      ].join("\n"),
    );
    const warnings = storeMdWarnings(["firefox", "edge"], tmp);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Firefox reviewer notes");
  });

  it("stays silent when the fields are filled in", () => {
    fs.writeFileSync(
      path.join(tmp, "STORE.md"),
      [
        "## firefox-amo",
        "### Reviewer notes",
        "Test account and steps.",
        "## Edge Add-ons",
        "### Certification notes",
        "Guidance.",
      ].join("\n"),
    );
    expect(storeMdWarnings(["firefox", "edge"], tmp)).toEqual([]);
  });
});
