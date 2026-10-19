import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handler as builds } from "../tools/builds";
import { writeCredentials } from "../lib/credentials";
import { TOOL_POLICY } from "../lib/tool-policy";
import { fenceUntrusted } from "../lib/untrusted-fence";

const API = "http://localhost:3100";
const PROJECT_ID = "prj_probe";
const RUN_URL = "https://github.com/mirror/4672033--prj/actions/runs/39264909147";
const JOB = "⏵⏵⏵ Build and Deploy Preview";
const STEP = "⏵⏵⏵ Checkout user repository";
const EXCHANGE_403 =
  '[mint-source-token] Exchange returned 403: {"message":"Only mirror repositories may exchange a token here."}';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

const PENDING = ["chrome", "edge", "firefox"].map((browser) => ({
  browser,
  status: "pending",
  issueKind: "info",
  runUrl: RUN_URL,
  logs: [],
}));

const SKIPPED = ["chrome", "edge", "firefox"].map((browser) => ({
  browser,
  status: "skipped",
  issueKind: "info",
  runUrl: RUN_URL,
  reason: "the run failed before this browser's job started",
  logs: [],
}));

const SHARED_FAILURE_LOGS = {
  buildId: "b418732",
  runUrl: RUN_URL,
  runUrlAvailable: true,
  run: {
    status: "completed",
    conclusion: "failure",
    failedJob: {
      name: JOB,
      step: STEP,
      conclusion: "failure",
      lines: ["Run ./.github/actions/checkout-user-repo", EXCHANGE_403, "Process completed with exit code 1."],
    },
  },
  items: SKIPPED,
};

const LEGACY_LOGS = { buildId: "b418732", runUrl: RUN_URL, runUrlAvailable: true, items: PENDING };

const FAILED_DETAIL = {
  id: "b418732",
  buildId: "b418732",
  status: "failed",
  duration: "24s",
  browsers: [],
  failureCause: { kind: "step_failed", jobName: JOB, stepName: STEP },
  runUrl: RUN_URL,
};

describe("extension_builds logs names a failure in a step every browser shares", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevFetch: typeof fetch;
  let prevApi: string | undefined;
  let routes: Record<string, { body: unknown; status?: number }>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-builds-207-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevApi = process.env.EXTENSION_DEV_API_URL;
    delete process.env.EXTENSION_DEV_API_URL;
    process.env.XDG_CONFIG_HOME = tmp;
    prevFetch = global.fetch;
    routes = {
      "/api/cli/whoami": {
        body: { login: "acme/widget", live: true, projectId: PROJECT_ID, workspaceSlug: "acme", projectSlug: "widget" },
      },
      [`/api/projects/${PROJECT_ID}/builds/b418732`]: { body: FAILED_DETAIL },
      [`/api/projects/${PROJECT_ID}/builds/b418732/logs`]: { body: SHARED_FAILURE_LOGS },
    };

    global.fetch = (async (url: string) => {
      const route = routes[new URL(String(url)).pathname];

      return route ? jsonResponse(route.body, route.status ?? 200) : jsonResponse({ message: "not found" }, 404);
    }) as unknown as typeof fetch;

    writeCredentials({
      version: 1,
      token: "claims.sig",
      workspaceSlug: "acme",
      projectSlug: "widget",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      api: API,
    });
  });

  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevApi === undefined) delete process.env.EXTENSION_DEV_API_URL;
    else process.env.EXTENSION_DEV_API_URL = prevApi;

    global.fetch = prevFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function readLogs(extra: Record<string, unknown> = {}) {
    return JSON.parse(await builds({ action: "logs", buildId: "b418732", api: API, ...extra }));
  }

  it("leads with the failed job and step and that step's last lines, fenced as untrusted", async () => {
    if (process.platform === "win32") return;

    const raw = await builds({ action: "logs", buildId: "b418732", api: API });
    const out = JSON.parse(raw);

    expect(out.ok).toBe(true);
    expect(out.value.run.failedJob).toMatchObject({ name: JOB, step: STEP, conclusion: "failure" });
    expect(out.value.run.failedJob.lines).toContain(EXCHANGE_403);
    expect(Object.keys(out.value).indexOf("run")).toBeLessThan(Object.keys(out.value).indexOf("items"));
    expect(out.hint.startsWith(`The run failed in ${JOB} at step ${STEP} before any browser built:\n`)).toBe(true);
    expect(out.hint).toContain(EXCHANGE_403);
    expect(TOOL_POLICY.extension_builds.untrusted).toBe(true);

    const fenced = fenceUntrusted(raw, () => "b207");

    expect(fenced.indexOf('"untrusted":')).toBeLessThan(fenced.indexOf("Exchange returned 403"));
    expect(fenced.lastIndexOf("Exchange returned 403")).toBeLessThan(fenced.indexOf('"untrustedEnd":"</untrusted-data-b207>"'));
  });

  it("answers skipped with the reason and never pending on a concluded run", async () => {
    if (process.platform === "win32") return;

    routes[`/api/projects/${PROJECT_ID}/builds/b418732/logs`] = {
      body: { ...SHARED_FAILURE_LOGS, items: PENDING },
    };

    const out = await readLogs();

    expect(out.value.items.map((item: { status: string }) => item.status)).toEqual(["skipped", "skipped", "skipped"]);
    expect(out.value.items[0].reason).toBe("the run failed before this browser's job started");
    expect(JSON.stringify(out)).not.toContain('"pending"');
  });

  it("keeps pending while the run is still going", async () => {
    if (process.platform === "win32") return;

    routes[`/api/projects/${PROJECT_ID}/builds/b418732/logs`] = {
      body: { ...LEGACY_LOGS, run: { status: "in_progress", conclusion: null, failedJob: null } },
    };

    const out = await readLogs();

    expect(out.value.items.every((item: { status: string }) => item.status === "pending")).toBe(true);
  });

  it("on an older platform with every browser pending on a failed build, says the run failed before the browser steps", async () => {
    if (process.platform === "win32") return;

    routes[`/api/projects/${PROJECT_ID}/builds/b418732/logs`] = { body: LEGACY_LOGS };

    const out = await readLogs();

    expect(out.value.items.map((item: { status: string }) => item.status)).toEqual(["skipped", "skipped", "skipped"]);
    expect(out.hint).toContain("The run failed");
    expect(out.hint).toContain("before the browser steps");
    expect(out.hint).toContain(STEP);
    expect(out.hint).toContain("/builds/b418732");
    expect(JSON.stringify(out)).not.toContain('"pending"');
  });

  it("on an older platform leaves pending alone when the build has not failed", async () => {
    if (process.platform === "win32") return;

    routes[`/api/projects/${PROJECT_ID}/builds/b418732/logs`] = { body: LEGACY_LOGS };
    routes[`/api/projects/${PROJECT_ID}/builds/b418732`] = { body: { ...FAILED_DETAIL, status: "building" } };

    const out = await readLogs();

    expect(out.value.items.every((item: { status: string }) => item.status === "pending")).toBe(true);
    expect(out.hint).not.toContain("The run failed");
  });
});

const PARTIAL_LIST_ROW = {
  id: "b418732",
  buildId: "b418732",
  commit: "b4187328629d45bf8f1d5d52a2c3d684694c45e8",
  status: "success",
  summaryStatus: "partial",
  outcome: "partial",
  failedBrowsers: ["edge", "firefox"],
  browsers: ["chrome", "edge", "firefox"],
};

const SUCCESS_LINES = [
  { level: "info", message: "Building" },
  { level: "success", message: "Browser metadata written" },
];

const UNSUMMARIZED_REASON =
  "No failure line was recorded for this browser. The platform marks a browser failed when its package record (meta or manifest) is missing from the registry after the build. The manifest validator reported no errors for it.";

const PARTIAL_LOGS = {
  buildId: "b418732",
  runUrl: RUN_URL,
  runUrlAvailable: true,
  run: {
    status: "completed",
    conclusion: "failure",
    failedJob: null,
    validation: {
      ran: true,
      strict: false,
      errors: 0,
      warnings: 2,
      failedBrowsers: [],
      diagnostics: [{ browser: "edge", level: "warning", message: "action is not supported in edge." }],
    },
  },
  items: [
    { browser: "chrome", status: "success", logs: SUCCESS_LINES },
    { browser: "edge", status: "failed", summarized: false, reason: UNSUMMARIZED_REASON, logs: SUCCESS_LINES },
    { browser: "firefox", status: "failed", summarized: false, reason: UNSUMMARIZED_REASON, logs: SUCCESS_LINES },
  ],
};

describe("extension_builds never claims a failure summary that is not there", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevFetch: typeof fetch;
  let prevApi: string | undefined;
  let routes: Record<string, { body: unknown; status?: number }>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-builds-209-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevApi = process.env.EXTENSION_DEV_API_URL;
    delete process.env.EXTENSION_DEV_API_URL;
    process.env.XDG_CONFIG_HOME = tmp;
    prevFetch = global.fetch;
    routes = {
      "/api/cli/whoami": {
        body: { login: "acme/widget", live: true, projectId: PROJECT_ID, workspaceSlug: "acme", projectSlug: "widget" },
      },
      [`/api/projects/${PROJECT_ID}/builds`]: { body: { items: [PARTIAL_LIST_ROW] } },
      [`/api/projects/${PROJECT_ID}/builds/b418732/logs`]: { body: PARTIAL_LOGS },
      [`/api/projects/${PROJECT_ID}/builds/b418732`]: {
        body: {
          ...FAILED_DETAIL,
          status: "success",
          failureCause: null,
          validation: {
            checks: [
              {
                id: "manifest",
                name: "Manifest validity",
                status: "failed",
                detail: "No complete package record (meta or upload manifest) for edge, firefox.",
                browsers: ["edge", "firefox"],
              },
            ],
          },
          validationOutcome: PARTIAL_LOGS.run.validation,
        },
      },
    };

    global.fetch = (async (url: string) => {
      const route = routes[new URL(String(url)).pathname];

      return route ? jsonResponse(route.body, route.status ?? 200) : jsonResponse({ message: "not found" }, 404);
    }) as unknown as typeof fetch;

    writeCredentials({
      version: 1,
      token: "claims.sig",
      workspaceSlug: "acme",
      projectSlug: "widget",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      api: API,
    });
  });

  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevApi === undefined) delete process.env.EXTENSION_DEV_API_URL;
    else process.env.EXTENSION_DEV_API_URL = prevApi;

    global.fetch = prevFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("relays the platform's reason for a failed browser with only success lines and never claims a summary", async () => {
    if (process.platform === "win32") return;

    const out = JSON.parse(await builds({ action: "logs", buildId: "b418732", api: API }));

    expect(out.hint).not.toContain("summary of the");
    expect(out.hint).toContain("edge, firefox failed with no failure line in their logs.");
    expect(out.hint).toContain("package record (meta or manifest) is missing");
    expect(out.hint).toContain("The manifest validator reported 0 errors and 2 warnings (strict off)");
    expect(out.value.run.validation.diagnostics[0].browser).toBe("edge");
  });

  it("keeps the summary wording for a failed browser whose lines carry one", async () => {
    if (process.platform === "win32") return;

    routes[`/api/projects/${PROJECT_ID}/builds/b418732/logs`] = {
      body: {
        ...PARTIAL_LOGS,
        items: [
          {
            browser: "edge",
            status: "failed",
            summarized: true,
            reason: "the manifest validator failed this browser",
            logs: [{ level: "error", message: 'permission "scripting" is not supported in edge.' }],
          },
        ],
      },
    };

    const out = JSON.parse(await builds({ action: "logs", buildId: "b418732", api: API }));

    expect(out.hint).toContain("edge failed; its lines lead with the platform's summary of the failure.");
  });

  it("on an older platform with no summarized flag, says no summary was sent instead of claiming one", async () => {
    if (process.platform === "win32") return;

    routes[`/api/projects/${PROJECT_ID}/builds/b418732/logs`] = {
      body: {
        buildId: "b418732",
        runUrl: RUN_URL,
        items: [{ browser: "edge", status: "failed", logs: SUCCESS_LINES }],
      },
    };

    const out = JSON.parse(await builds({ action: "logs", buildId: "b418732", api: API }));

    expect(out.hint).not.toContain("summary of the");
    expect(out.hint).toContain("the platform sent no failure summary for it");
    expect(out.hint).not.toContain(RUN_URL);
    expect(out.hint).toContain("/acme/widget/builds/b418732");
  });

  it("lists a partial build as partial with its failed browsers, not a bare success", async () => {
    if (process.platform === "win32") return;

    const out = JSON.parse(await builds({ action: "list", api: API }));
    const row = out.value.builds[0];

    expect(row).toMatchObject({ status: "partial", conclusion: "partial", runStatus: "success", failedBrowsers: ["edge", "firefox"] });
    expect(out.hint).toContain("(partial)");
  });

  it("get names the failed browsers and the manifest validator's outcome", async () => {
    if (process.platform === "win32") return;

    const out = JSON.parse(await builds({ action: "get", buildId: "b418732", api: API }));

    expect(out.value.failures.failedBrowsers).toEqual(["edge", "firefox"]);
    expect(out.value.failures.validation.errors).toBe(0);
    expect(out.hint).toContain("edge, firefox failed (No complete package record");
    expect(out.hint).toContain("The manifest validator failed no browser (0 errors, 2 warnings).");
  });
});
