import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handler as builds } from "../tools/builds";
import { DEFAULT_USAGE_GUIDE, usageValue } from "../lib/build-usage";
import { writeCredentials } from "../lib/credentials";

const API = "http://localhost:3100";
const PROJECT_ID = "prj_rebeccat";
const SHA = "bc5fc4f";
const BUILD_ROUTE = `/api/projects/${PROJECT_ID}/builds/${SHA}`;

const DEFAULT_GUIDE_AS_SERVED = [
  "# How to try this extension",
  "",
  "This is the default guide shown on your preview and deployment pages. To replace",
  "it with your own notes, edit the usage guide from your project dashboard or",
  "update this file in your repository.",
  "",
  "## Run locally from source",
  "",
  "```bash",
  "npm run dev",
  "```",
  "",
].join("\n");

const OWN_GUIDE = "# Try Rebeccat\n\nOpen any page with an email address and watch the badge count.\n";

type Route = { body?: unknown; status?: number };

function response(route: Route): Response {
  const status = route.status ?? 200;
  const textBody = JSON.stringify(route.body ?? null);

  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => textBody,
    json: async () => JSON.parse(textBody),
  } as unknown as Response;
}

describe("407 item 5: extension_builds get leaves out the unedited default usage guide", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let prevApi: string | undefined;
  let prevFetch: typeof fetch;
  let routes: Record<string, Route>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-builds-usage-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevApi = process.env.EXTENSION_DEV_API_URL;
    delete process.env.EXTENSION_DEV_API_URL;
    process.env.XDG_CONFIG_HOME = tmp;
    prevFetch = global.fetch;
    routes = {
      "/api/cli/whoami": {
        body: { login: "cezaraugusto/rebeccat", live: true, projectId: PROJECT_ID, workspaceSlug: "cezaraugusto", projectSlug: "rebeccat" },
      },
      [BUILD_ROUTE]: {
        body: { id: SHA, buildId: SHA, status: "success", conclusion: "success", browsers: [{ name: "chrome", status: "success", size: "1.0 MB", bytes: 1000000 }] },
      },
      [`${BUILD_ROUTE}/artifacts`]: { body: [] },
      [`${BUILD_ROUTE}/integrity/chrome`]: { body: { ok: true, checks: [] } },
    };

    global.fetch = (async (url: string) => {
      const route = routes[new URL(String(url)).pathname];

      return route ? response(route) : response({ body: { message: "not found" }, status: 404 });
    }) as unknown as typeof fetch;

    writeCredentials({
      version: 1,
      token: "claims.sig",
      workspaceSlug: "cezaraugusto",
      projectSlug: "rebeccat",
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

  async function getWithUsage(usage: unknown) {
    routes[`${BUILD_ROUTE}/usage`] = { body: usage };
    const out = JSON.parse(await builds({ action: "get", buildId: SHA, api: API }));
    expect(out.ok).toBe(true);

    return out;
  }

  it("answers usage: {recorded: true, default: true} for the template guide with no updatedAt, and never passes npm run dev through", async () => {
    if (process.platform === "win32") return;

    const out = await getWithUsage({ markdown: DEFAULT_USAGE_GUIDE, updatedAt: null });

    expect(out.value.usage).toEqual({ recorded: true, default: true });
    expect(JSON.stringify(out)).not.toContain("npm run dev");
    expect(JSON.stringify(out)).not.toContain("How to try this extension");
  });

  it("recognizes the template by its opening when the served copy drifted in whitespace or length", async () => {
    if (process.platform === "win32") return;

    const out = await getWithUsage({ markdown: DEFAULT_GUIDE_AS_SERVED, updatedAt: null });

    expect(out.value.usage).toEqual({ recorded: true, default: true });
  });

  it("keeps a guide the owner wrote, and the default text once the platform dates it", async () => {
    if (process.platform === "win32") return;

    const own = await getWithUsage({ markdown: OWN_GUIDE, updatedAt: null });
    const dated = await getWithUsage({ markdown: DEFAULT_USAGE_GUIDE, updatedAt: "Thu, 05 Nov 2026 10:00:00 GMT" });

    expect(own.value.usage).toEqual({ recorded: true, markdown: OWN_GUIDE.trim(), updatedAt: null });
    expect(dated.value.usage).toMatchObject({ recorded: true, updatedAt: "Thu, 05 Nov 2026 10:00:00 GMT" });
    expect(dated.value.usage.markdown).toContain("npm run dev");
    expect(dated.value.usage.default).toBeUndefined();
  });

  it("keeps recorded: false for an empty guide and recorded: unknown for an unread one", async () => {
    if (process.platform === "win32") return;

    const empty = await getWithUsage({ markdown: null, updatedAt: null });
    expect(empty.value.usage).toEqual({ recorded: false });

    routes[`${BUILD_ROUTE}/usage`] = { body: { message: "nope" }, status: 500 };
    const unread = JSON.parse(await builds({ action: "get", buildId: SHA, api: API }));
    expect(unread.value.usage).toEqual({ recorded: "unknown" });
  });

  it("usageValue is the one place that decides", () => {
    expect(usageValue({ markdown: DEFAULT_USAGE_GUIDE, updatedAt: null })).toEqual({ recorded: true, default: true });
    expect(usageValue({ markdown: `${DEFAULT_USAGE_GUIDE}\n## Our notes\n\nSomething.\n`, updatedAt: null })).toEqual({ recorded: true, default: true });
    expect(usageValue({ markdown: OWN_GUIDE, updatedAt: "" })).toEqual({ recorded: true, markdown: OWN_GUIDE.trim(), updatedAt: null });
    expect(usageValue({ markdown: "   ", updatedAt: null })).toEqual({ recorded: false });
    expect(usageValue(null)).toEqual({ recorded: false });
  });
});
