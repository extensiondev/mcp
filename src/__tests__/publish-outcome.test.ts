import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handler } from "../tools/publish";
import { publishAnswer } from "./fixtures/platform-answers";

const saved: Record<string, string | undefined> = {};
let tmp: string;

function stubPublish(body: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any) => {
      const href = String(url);

      if (href.endsWith("/api/cli/publish")) {
        return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
      }

      throw new Error(`Unexpected fetch: ${href}`);
    }),
  );
}

beforeEach(() => {
  for (const key of ["XDG_CONFIG_HOME", "EXTENSION_DEV_API_URL", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_PROJECT"]) {
    saved[key] = process.env[key];
  }

  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-publish-outcome-"));
  process.env.XDG_CONFIG_HOME = tmp;
  process.env.EXTENSION_DEV_API_URL = "https://api.test";
  process.env.EXTENSION_DEV_TOKEN = "release-token";
  delete process.env.EXTENSION_DEV_PROJECT;
});

afterEach(() => {
  vi.unstubAllGlobals();

  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("extension_publish says what the share serves", () => {
  it("says published over the platform's real answer", async () => {
    stubPublish(publishAnswer());
    const out = JSON.parse(await handler({}));

    expect(out.ok).toBe(true);
    expect(out.status).toBe("published");
    expect(out.warnings.join(" ")).not.toContain("serves NO build");
  });

  it("names a share the platform minted over no build", async () => {
    stubPublish(publishAnswer({ buildSha: null, version: null, builtAt: null, previewCommands: {} }));
    const out = JSON.parse(await handler({}));

    expect(out.ok).toBe(true);
    expect(out.status).toBe("published-without-build");
    expect(out.warnings[0]).toContain("serves NO build");
  });

  it.each([["an empty object", {}], ["a page of html", "<html>ok</html>"], ["an empty body", ""]])(
    "calls %s unconfirmed, never published",
    async (_label, body) => {
      stubPublish(body);
      const out = JSON.parse(await handler({}));

      expect(out.ok).toBe(false);
      expect(out.status).toBe("publish-unconfirmed");
      expect(out.hint).toContain("extension_shares");
    },
  );

  it("tells an unknown pinned build apart from a missing project", async () => {
    stubPublish(
      { message: "Build abc1234 was not found in this project's build index.", code: "UNKNOWN_BUILD" },
      404,
    );

    const out = JSON.parse(await handler({ buildSha: "abc1234" }));

    expect(out.status).toBe("build-unknown");
    expect(out.error.platformCode).toBe("UNKNOWN_BUILD");
    expect(out.hint).toContain("extension_release_status");
    expect(out.hint).not.toContain("create");
  });

  it("keeps the project hint for the platform's PROJECT_NOT_FOUND", async () => {
    stubPublish(
      { message: "Project not found", code: "PROJECT_NOT_FOUND", createProjectUrl: "https://www.extension.dev/new" },
      404,
    );

    const out = JSON.parse(await handler({}));

    expect(out.status).not.toBe("build-unknown");
    expect(JSON.stringify(out)).toMatch(/project/i);
  });
});
