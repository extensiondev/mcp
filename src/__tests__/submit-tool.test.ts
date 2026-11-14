import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

import { readSubmitFacts } from "../lib/submit-facts-local";
import { handler as judgeSubmit, storeMdWarnings } from "../tools/submit";
import { schema, handler } from "../tools/submit-local";
import { writeCredentials } from "../lib/credentials";
import { WRITE_FAILURE_REPORT_URL } from "../lib/settings-write";
import { actionFingerprint } from "../lib/approval-gate";
import { INSTALL_FILES_HINT, STORE_REFUSED_INSTALL_STATUS } from "../lib/store-refused-install";
import { PLATFORM_UNAVAILABLE_SENTENCE, PLATFORM_UNAVAILABLE_STATUS } from "../lib/store-run-unavailable";
import { submitAnswer } from "./fixtures/platform-answers";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

function claimsToken(u: string, p: string): string {
  return `${Buffer.from(JSON.stringify({ u, p, exp: Math.floor(Date.now() / 1000) + 600 })).toString("base64url")}.sig`;
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("extension_submit: registration + schema", () => {
  it("leaves browsers + buildSha to the submit action and exposes no credential/zip/path property", () => {
    const req = (schema.inputSchema as { required: string[] }).required;
    expect(req).toEqual([]);
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
  let prevGate: string | undefined;
  let prevFetch: typeof fetch;

  beforeEach(() => {
    prevGate = process.env.EXTENSION_DEV_APPROVAL_GATE;
    process.env.EXTENSION_DEV_APPROVAL_GATE = "0";
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
    if (prevGate === undefined) delete process.env.EXTENSION_DEV_APPROVAL_GATE;
    else process.env.EXTENSION_DEV_APPROVAL_GATE = prevGate;

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
    process.env.EXTENSION_DEV_TOKEN = claimsToken("acme", "widget");
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
      if (String(url).endsWith("/api/cli/stores/submit")) captured = { url, init };

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
      expect(row.configured).toBe("not checked");
    }

    expect(out.value.verdict).toBe("not-checked");
    expect(out.value.nextStep.kind).toBe("submit");
    expect(out.hint).toContain("not checked here");
    expect(JSON.stringify(out)).not.toContain("unknown");
  });

  it("keeps a platform-reported failure primary when no local ref exists", async () => {
    process.env.EXTENSION_DEV_TOKEN = claimsToken("acme", "widget");
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
    expect(out.value.verdict).toBe("platform-refused");
    expect(out.hint).toContain("the platform refused this dry run");
    expect(out.hint).toContain("Build abc1234 has no completed build");
    expect(out.hint).not.toContain("the platform verified");
  });

  it("keeps a platform failure primary even when store credentials are healthy", async () => {
    process.env.EXTENSION_DEV_TOKEN = claimsToken("acme", "widget");
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
    expect(out.value.verdict).toBe("platform-refused");
    expect(out.hint).not.toContain("the platform verified");
  });

  it("still fails the dry run when every requested store is definitively blocked", async () => {
    process.env.EXTENSION_DEV_TOKEN = claimsToken("acme", "widget");
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
    expect(out.value.verdict).toBe("store-not-configured");
    expect(out.value.nextStep.kind).toBe("connect");
    expect(out.hint).toContain("Not ready for chrome");
  });

  it("reads STORE.md from projectPath instead of the server's cwd", async () => {
    process.env.EXTENSION_DEV_TOKEN = claimsToken("acme", "widget");
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
    process.env.EXTENSION_DEV_TOKEN = claimsToken("acme", "widget");
    let body: any = null;
    global.fetch = (async (_url: string, init: any) => {
      body = JSON.parse(init.body);

      return jsonResponse(submitAnswer(["edge"]));
    }) as unknown as typeof fetch;

    await handler({ browsers: ["edge"], buildSha: "def5678", dryRun: false });
    expect(body.dryRun).toBe(false);
  });

  it("attaches STORE.md warnings to the result without blocking it", async () => {
    process.env.EXTENSION_DEV_TOKEN = claimsToken("acme", "widget");
    global.fetch = (async () =>
      jsonResponse({ ok: true, dryRun: true })) as unknown as typeof fetch;

    const prevCwd = process.cwd();
    process.chdir(tmp);

    try {
      const out = JSON.parse(
        await handler({ browsers: ["firefox"], buildSha: "abc1234" }),
      );
      expect(out.warnings[0]).toContain("No STORE.md");
      expect(out.warnings.join(" ")).not.toContain("channel:");
      expect(out.value.preflight[0].reason).not.toContain("STORE.md");
    } finally {
      process.chdir(prevCwd);
    }
  });

  it("surfaces a non-OK response as SubmitError", async () => {
    process.env.EXTENSION_DEV_TOKEN = claimsToken("acme", "widget");
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

  it("answers platform-unavailable, not submit-failed, when the platform has no store run after an approval, naming the report path and never the platform's words (ledger 508)", async () => {
    process.env.EXTENSION_DEV_TOKEN = claimsToken("acme", "widget");
    const line = "No store submission workflow (the store run) found on the project's build environment";
    global.fetch = (async () => jsonResponse({ message: line }, false, 404)) as unknown as typeof fetch;

    const out = JSON.parse(await handler({ browsers: ["firefox"], buildSha: "4cec881", dryRun: false, approvalId: "apr_508" }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe(PLATFORM_UNAVAILABLE_STATUS);
    expect(out.error).toMatchObject({ code: "E_PLATFORM", name: "PlatformUnavailable" });
    expect(out.value).toMatchObject({ owner: "platform", approvalId: "apr_508", approvalRefunded: "unknown", platformLine: line, reportUrl: WRITE_FAILURE_REPORT_URL });
    expect(out.hint).toContain(PLATFORM_UNAVAILABLE_SENTENCE);
    expect(out.hint).toContain(`${WRITE_FAILURE_REPORT_URL} with the project acme/widget, the store firefox and build 4cec881`);
    expect(out.hint).toContain("extension_approvals (action: status, approvalId: apr_508)");
    expect(JSON.stringify(out, (key, value) => (key === "platformLine" ? undefined : value))).not.toMatch(/workflow|store\.yml|fix the cause/i);
  });

  it("answers a 503 with a code it does not know, such as an older platform's STORE_RUN_UNAVAILABLE, as a plain submit failure in the platform's words", async () => {
    process.env.EXTENSION_DEV_TOKEN = claimsToken("acme", "widget");
    const line = "Store submissions for this project run on the build lane, which is not taking them yet.";
    global.fetch = (async () => jsonResponse({ code: "STORE_RUN_UNAVAILABLE", message: line }, false, 503)) as unknown as typeof fetch;

    const out = JSON.parse(await handler({ browsers: ["firefox"], buildSha: "4cec881" }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe("submit-failed");
    expect(out.error).toMatchObject({ code: "E_PLATFORM", name: "SubmitError", platformCode: "STORE_RUN_UNAVAILABLE" });
    expect(out.error.message).toBe(`preflight failed (503): ${line}`);
    expect(JSON.stringify(out)).not.toContain("undefined");
  });
});

describe("extension_submit answers an upload the store's installation test refused as the person's to fix (ledger 510)", () => {
  const INSTALL_LINE = "The Chrome Web Store refused the package for item abcdefghijklmnopabcdefghijklmnop: ITEM_INSTALL_FAILED: The extension could not be installed. Service worker file background.js was not found in the package.";
  const said = (out: any): string => JSON.stringify(out, (key, value) => (key === "platformLine" ? undefined : value));
  let tmp: string;
  let prevXdg: string | undefined;
  let prevToken: string | undefined;
  let prevGate: string | undefined;
  let prevFetch: typeof fetch;

  beforeEach(() => {
    prevGate = process.env.EXTENSION_DEV_APPROVAL_GATE;
    process.env.EXTENSION_DEV_APPROVAL_GATE = "0";
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-submit-510-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevToken = process.env.EXTENSION_DEV_TOKEN;
    prevFetch = global.fetch;
    process.env.XDG_CONFIG_HOME = tmp;
    process.env.EXTENSION_DEV_TOKEN = claimsToken("acme", "widget");
  });

  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevToken === undefined) delete process.env.EXTENSION_DEV_TOKEN;
    else process.env.EXTENSION_DEV_TOKEN = prevToken;
    if (prevGate === undefined) delete process.env.EXTENSION_DEV_APPROVAL_GATE;
    else process.env.EXTENSION_DEV_APPROVAL_GATE = prevGate;

    global.fetch = prevFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("answers store-refused-install with the store's reason, owner you and the manifest hint when the submit route refuses the upload after an approval", async () => {
    global.fetch = (async () => jsonResponse({ ok: false, code: "CHROME_UPLOAD_FAILED", store: "chrome", message: INSTALL_LINE }, false, 422)) as unknown as typeof fetch;

    const out = JSON.parse(await handler({ browsers: ["chrome"], buildSha: "4cec881", dryRun: false, approvalId: "apr_510" }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe(STORE_REFUSED_INSTALL_STATUS);
    expect(out.error).toMatchObject({ name: "StoreRefusedInstall", platformCode: "CHROME_UPLOAD_FAILED" });
    expect(out.value).toMatchObject({ owner: "you", store: "chrome", approvalId: "apr_510", approvalRefunded: "unknown", platformLine: INSTALL_LINE });
    expect(out.value.nextStep).toMatchObject({ kind: "resubmit" });
    expect(out.value.trackUrl).toContain("4cec881");
    expect(out.hint).toContain(`the store's reason: "${INSTALL_LINE.replace(/\.$/, "")}"`);
    expect(out.hint).toContain(INSTALL_FILES_HINT);
    expect(out.hint).toContain("extension_approvals (action: status, approvalId: apr_510)");
    expect(said(out)).not.toMatch(/platform cannot take|workflow|store\.yml|report it|fix the cause/i);
  });

  it("answers store-refused-install, not submit-failed, when the platform's record after the run carries the store's install refusal", async () => {
    const records = {
      submissions: [
        {
          id: "sub_c",
          store: "chrome",
          version: "0.1.0",
          status: "failed",
          rawStatus: "upload_failed",
          failureReason: INSTALL_LINE,
          statusRead: { word: "failed", readAt: "2026-11-11T18:00:00.000Z", source: "poll", storeWord: "FAILED", note: INSTALL_LINE },
          storeUpload: { state: "FAILED", checkedAt: "2026-11-11T18:00:00.000Z", source: "poll", message: INSTALL_LINE },
        },
      ],
    };
    global.fetch = (async (url: string, init?: RequestInit) => {
      const target = String(url);
      const method = String(init?.method ?? "GET").toUpperCase();

      if (method === "POST" && target.endsWith("/api/cli/stores/submit")) {
        return jsonResponse({ ok: true, buildId: "4cec881", dispatchedAt: "2026-11-11T17:59:00.000Z", submissions: [{ id: "sub_c", store: "chrome", status: "pending" }] });
      }

      if (target.includes("/api/cli/approvals/")) {
        return jsonResponse({ status: "approved", used: false, expiresAt: new Date(Date.now() + 600_000).toISOString(), fingerprint: actionFingerprint("extension_submit", { browsers: ["chrome"], buildSha: "4cec881" }) });
      }

      if (target.includes("/api/cli/stores/submissions")) return jsonResponse(records);

      return jsonResponse({}, false, 404);
    }) as unknown as typeof fetch;

    const out = JSON.parse(await handler({ browsers: ["chrome"], buildSha: "4cec881", dryRun: false, approvalId: "apr_510", waitSeconds: 5 }));

    expect(out.ok).toBe(false);
    expect(out.status).toBe(STORE_REFUSED_INSTALL_STATUS);
    expect(out.error.name).toBe("StoreRefusedInstall");
    expect(out.value).toMatchObject({ owner: "you", platformLine: INSTALL_LINE, refusals: [{ store: "chrome", platformLine: INSTALL_LINE }] });
    expect(out.value.nextStep).toMatchObject({ kind: "resubmit" });
    expect(out.hint).toContain(INSTALL_FILES_HINT);
    expect(out.hint).toContain("The approval was spent on this upload");
    expect(said(out)).not.toMatch(/fix the cause|platform cannot take/i);
  });
});

describe("storeMdWarnings", () => {
  const file = path.join("/work/extension", "STORE.md");
  const read = (content: string | null) => ({ file, content });

  it("stays silent for chrome-only submissions", () => {
    expect(storeMdWarnings(["chrome"], read(null))).toEqual([]);
  });

  it("warns once when STORE.md is missing entirely", () => {
    const warnings = storeMdWarnings(["firefox", "edge"], read(null));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("No STORE.md");
    expect(warnings[0]).toContain("the source the platform holds at the built commit (an uploaded project's stored tree, or the repository at that commit)");
    expect(warnings[0]).not.toContain("source repository");
  });

  it("warns per store for empty or absent note fields", () => {
    const warnings = storeMdWarnings(["firefox", "edge"], read(
      [
        "## Firefox Add-ons",
        "### Reviewer notes",
        "<!-- fill me in -->",
        "## Edge Add-ons",
        "### Certification notes",
        "Real guidance here.",
      ].join("\n"),
    ));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Firefox reviewer notes");
  });

  it("names the file it read when the fields are filled in", () => {
    const warnings = storeMdWarnings(["firefox", "edge"], read(
      [
        "## firefox-amo",
        "### Reviewer notes",
        "Test account and steps.",
        "## Edge Add-ons",
        "### Certification notes",
        "Guidance.",
      ].join("\n"),
    ));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(file);
    expect(warnings[0]).toContain("the source the platform holds at the built commit (an uploaded project's stored tree, or the repository at that commit)");
    expect(warnings[0]).toContain("a re-seed with extension_project_create (a new upload) for an uploaded project");
    expect(warnings[0]).not.toContain("unpushed");
  });

  it("warns on prefixed note headings, which the platform does not read", () => {
    const warnings = storeMdWarnings(["firefox", "edge"], read(
      [
        "## Firefox",
        "### AMO reviewer notes",
        "Test account and steps.",
        "## Edge",
        "### Edge certification notes",
        "Guidance.",
      ].join("\n"),
    ));
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("no Firefox reviewer notes");
    expect(warnings[1]).toContain("no Edge certification notes");
  });
});

describe("extension_submit: the platform half judges the facts it is handed", () => {
  const platform = useProjectRoutes("extdev-submit-facts-");
  const preflight = (store: string) => ({ store, summary: { pass: 1, warn: 0, fail: 0, blockingFailures: 0, canSubmit: true }, checks: [] });
  let project: string;

  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-submit-facts-project-"));
    fs.mkdirSync(path.join(project, "src"));
    fs.writeFileSync(path.join(project, "src", "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Widget", version: "1.0.0", description: "Counts the tabs you keep open." }));
    fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "widget", version: "1.0.0", license: "MIT" }));
    fs.writeFileSync(path.join(project, "STORE.md"), "# Widget\n\n## Listing\n\n- Name: Widget\n- Summary: Counts tabs.\n\n## Firefox Add-ons\n\n### Reviewer notes\n\nBuild from source with Node 22.12.0, pnpm 10.19.0 and Extension.js 4.1.39: run pnpm install, then pnpm build.\n");
    fs.writeFileSync(path.join(project, "CHROMEWEBSTORE.md"), "# Widget\n\n## Description\n\nCounts tabs.\n");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(project, { recursive: true, force: true });
  });

  it("answers a preflight byte for byte from the facts, with no file read under projectPath", async () => {
    platform.login();
    for (const store of ["chrome", "firefox", "safari"]) platform.routes[`POST ${PROJECT_ROUTE}/stores/${store}/submissions/preflight`] = () => ({ body: preflight(store) });

    const args = { action: "preflight", browsers: ["chrome", "firefox", "safari"], projectPath: project, api: API };
    const whole = await handler(args);
    const facts = readSubmitFacts(args);
    const roots = [project, fs.realpathSync(project)];
    const touched: string[] = [];

    const watch = <K extends "readFileSync" | "existsSync" | "statSync" | "realpathSync" | "readdirSync" | "openSync">(name: K) => {
      const original = fs[name] as (...rest: unknown[]) => unknown;
      vi.spyOn(fs, name).mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
        touched.push(String(target));

        return original.call(fs, target, ...rest);
      }) as never);
    };

    for (const name of ["readFileSync", "existsSync", "statSync", "realpathSync", "readdirSync", "openSync"] as const) watch(name);

    const judged = await judgeSubmit(args, facts);
    vi.restoreAllMocks();

    expect(judged).toBe(whole);
    expect(JSON.parse(judged).value.stores.firefox).toBeTruthy();
    expect(touched.filter((file) => roots.some((root) => file.startsWith(root)))).toEqual([]);
  });
});
