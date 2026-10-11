import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readStores } from "../tools/store-status";
import { handler as releaseStatus } from "../tools/release-status";
import { writeCredentials } from "../lib/credentials";

const API = "https://www.extension.dev";
const RUN_URL = "https://github.com/mirror/1--prj/actions/runs/7001";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const FAILED_BEFORE_STORE = {
  ok: true,
  projectId: "prj_probe",
  submissions: [
    {
      id: "sub_1",
      store: "chrome",
      channel: "stable",
      buildId: "603fc8a",
      version: "603fc8a",
      status: "failed",
      submittedAt: "2026-10-11T18:37:59.602Z",
      failureReason:
        'The submission run ended failure at "Fetch the store submit tooling" before any store step ran, so no store received this submission.',
      workflowRunId: 7001,
      workflowRunUrl: RUN_URL,
      run: {
        id: 7001,
        status: "completed",
        conclusion: "failure",
        htmlUrl: RUN_URL,
        completedAt: "2026-10-11T18:38:53Z",
      },
      outcome: "failed-before-store",
      storeReached: false,
      failedStep: "Fetch the store submit tooling",
      message:
        'The submission run ended failure at "Fetch the store submit tooling" before any store step ran, so no store received this submission. Nothing was sent to chrome; fix the cause shown in the run and submit again.',
      settled: true,
    },
  ],
};

describe("store status after a submission whose run never recorded", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevFetch: typeof fetch;
  let platformCalls: Array<{ url: string; auth: string }>;
  let platformAnswer: { body: unknown; status: number };
  let registryFiles: Record<string, unknown>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-submission-run-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tmp;
    prevFetch = global.fetch;
    platformCalls = [];
    platformAnswer = { body: FAILED_BEFORE_STORE, status: 200 };
    registryFiles = {};

    global.fetch = (async (url: string, init?: RequestInit) => {
      const target = String(url);

      if (target.includes("/api/cli/stores/submissions")) {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        platformCalls.push({ url: target, auth: String(headers.authorization ?? "") });

        return jsonResponse(platformAnswer.body, platformAnswer.status);
      }

      for (const [suffix, body] of Object.entries(registryFiles)) {
        if (target.endsWith(suffix)) return jsonResponse(body);
      }

      return jsonResponse({ message: "not found" }, 404);
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;

    global.fetch = prevFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function login(workspace = "acme", project = "widget") {
    writeCredentials({
      version: 1,
      token: "claims.sig",
      workspaceSlug: workspace,
      projectSlug: project,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      api: API,
    });
  }

  it("reports the failed run and that no store was reached when the registry has nothing", async () => {
    if (process.platform === "win32") return;

    login();

    const out = JSON.parse(await releaseStatus({ include: ["stores"] }));

    expect(out.ok).toBe(true);
    const chrome = out.value.stores.value.stores.find(
      (row: { store: string }) => row.store === "chrome",
    );
    expect(chrome.lastSubmission.status).toBe("failed");
    expect(chrome.submissionRun).toMatchObject({
      status: "completed",
      conclusion: "failure",
      url: RUN_URL,
      outcome: "failed-before-store",
      storeReached: false,
      failedStep: "Fetch the store submit tooling",
    });

    expect(out.value.stores.hint).toContain("no store received this submission");
    expect(out.value.stores.hint).toContain("submit again");
  });

  it("asks the platform with the project's own token", async () => {
    if (process.platform === "win32") return;

    login();

    await readStores({});

    expect(platformCalls).toHaveLength(1);
    expect(platformCalls[0]?.url).toBe(`${API}/api/cli/stores/submissions`);
    expect(platformCalls[0]?.auth).toBe("Bearer claims.sig");
  });

  it("reads the platform only with a token for the project being read", async () => {
    if (process.platform === "win32") return;

    login("acme", "widget");

    await readStores({});
    expect(platformCalls).toHaveLength(1);

    const claims = Buffer.from(JSON.stringify({ u: "other", p: "thing" })).toString("base64url");
    const prevToken = process.env.EXTENSION_DEV_TOKEN;
    process.env.EXTENSION_DEV_TOKEN = `${claims}.sig`;

    try {
      await readStores({});
    } finally {
      if (prevToken === undefined) delete process.env.EXTENSION_DEV_TOKEN;
      else process.env.EXTENSION_DEV_TOKEN = prevToken;
    }

    expect(platformCalls).toHaveLength(1);
  });

  it("lets a newer platform submission replace an older registry one", async () => {
    if (process.platform === "win32") return;

    login();
    registryFiles = {
      "stores/submissions.json": {
        submissions: [
          {
            store: "chrome",
            status: "approved",
            version: "1.0.0",
            submittedAt: "2026-10-01T00:00:00.000Z",
          },
        ],
      },
    };

    const out = JSON.parse(await readStores({}));
    const chrome = out.value.stores.find(
      (row: { store: string }) => row.store === "chrome",
    );

    expect(chrome.lastSubmission.status).toBe("failed");
    expect(chrome.lastSubmission.buildSha).toBe("603fc8a");
  });

  it("warns, rather than staying silent, when the platform records cannot be read", async () => {
    if (process.platform === "win32") return;

    login();
    platformAnswer = { body: { message: "boom" }, status: 500 };
    registryFiles = { "stores/health.json": { stores: { chrome: { ok: true } } } };

    const out = JSON.parse(await readStores({}));

    expect(out.ok).toBe(true);
    expect(
      out.warnings.some((w: string) => w.includes("platform's submission records could not be read")),
    ).toBe(true);
  });
});
