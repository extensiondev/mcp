// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { describe, expect, it } from "vitest";

import { envelope } from "../lib/envelope";
import { scrubRunAnswer } from "../lib/run-privacy";
import { TOOL_POLICY } from "../lib/tool-policy";
import { FULL_SHA, MIRROR_REPO, MIRROR_RUN_URL, WORLD_API, usePlatformWorld } from "./fixtures/platform-world";
import { WORLD_CASES, type WorldCase } from "./fixtures/platform-world-cases";

const FORBIDDEN = [/extension-user-land(-dev)?\//, /actions\/runs\//, /\bmirror\b/i, /\b\d+--prj_/];
const P = "/api/projects/prj_world";
const CONSOLE_BUILD_PAGE = /^https?:\/\/console\.[^/]+\/[^/]+\/[^/]+\/builds\/[^/?#]+$/;
const PROD_PII_RUN_URL = "https://github.com/extension-user-land/4672033--prj_a017a32f-5b6c-4d7e-8f90-a1b2c3d4e5f6/actions/runs/39292347354";

const MIRROR_HEAVY: Record<string, WorldCase[]> = {
  extension_builds: [
    {
      name: "a failed dispatch whose message names the run",
      args: { action: "rebuild", buildId: FULL_SHA, api: WORLD_API },
      setup: (world) => {
        world.routes.push([new RegExp(`^POST ${P}/builds/dispatch$`), () => ({ status: 500, body: { code: "DISPATCH_FAILED", message: `The CI run on the mirror ${MIRROR_REPO} failed: ${MIRROR_RUN_URL}` } })]);
      },
    },
  ],
  extension_release_status: [
    { name: "history", args: { include: ["history"], api: WORLD_API } },
    { name: "stores", args: { include: ["stores"], api: WORLD_API } },
  ],
  extension_workspace: [{ name: "projects", args: { action: "projects", api: WORLD_API } }],
};

function strings(value: unknown, at = "value"): Array<[string, string]> {
  if (typeof value === "string") return [[at, value]];
  if (Array.isArray(value)) return value.flatMap((item, i) => strings(item, `${at}[${i}]`));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([key, item]) => strings(item, `${at}.${key}`));

  return [];
}

function runIdsOutsideInternal(value: unknown, at = "value"): string[] {
  if (Array.isArray(value)) return value.flatMap((item, i) => runIdsOutsideInternal(item, `${at}[${i}]`));
  if (!value || typeof value !== "object") return [];

  return Object.entries(value).flatMap(([key, item]) => {
    if (key === "internal") return [];
    if (["runId", "workflowRunId"].includes(key)) return [`${at}.${key}`];
    if (["runUrl", "workflowRunUrl", "htmlUrl"].includes(key) && !CONSOLE_BUILD_PAGE.test(String(item))) return [`${at}.${key}`];

    return runIdsOutsideInternal(item, `${at}.${key}`);
  });
}

function answerText(out: any): Array<[string, string]> {
  return [
    ...strings(out.value, "value"),
    ...strings(out.hint ?? "", "hint"),
    ...strings(out.error?.message ?? "", "error.message"),
    ...strings(out.warnings ?? [], "warnings"),
  ];
}

describe("no platform answer tells a person where or how the platform runs builds", () => {
  const world = usePlatformWorld("extdev-private-runs-");

  const all = Object.entries(WORLD_CASES).map(([tool, cases]) => [tool, [...cases, ...(MIRROR_HEAVY[tool] ?? [])]] as const);

  for (const [tool, cases] of all) {
    for (const entry of cases) {
      it(`${tool} ${entry.name} names no build host, run url, run id or mirror`, async () => {
        if (process.platform === "win32") return;
        if (entry.login !== false) world.login();

        entry.setup?.(world);

        const args = typeof entry.args === "function" ? entry.args() : entry.args;
        const out = await world.call(tool, args);
        const leaks = answerText(out).filter(([, text]) => FORBIDDEN.some((pattern) => pattern.test(text)));

        expect(leaks, JSON.stringify(out).slice(0, 2000)).toEqual([]);
        expect(runIdsOutsideInternal(out.value)).toEqual([]);
      });
    }
  }
});

describe("the shared answer guard", () => {
  it("replaces a nested run link with the build page of the record that holds it and drops its run ids", () => {
    const rowPage = "https://console.extension.dev/cezaraugusto/pii-shield/builds/b418732";
    const answer = envelope({
      ok: true,
      command: "extension_release_status",
      status: "read",
      value: {
        trackUrl: "https://console.extension.dev/cezaraugusto/pii-shield/releases",
        rows: [
          {
            consoleUrl: rowPage,
            runUrl: PROD_PII_RUN_URL,
            workflowRun: { id: 39292347354, number: 12, htmlUrl: PROD_PII_RUN_URL, status: "completed" },
          },
        ],
        other: { workflowRunUrl: PROD_PII_RUN_URL },
      },
    });

    const out = JSON.parse(scrubRunAnswer(answer));

    expect(out.value.rows[0].runUrl).toBe(rowPage);
    expect(out.value.rows[0].workflowRun).toEqual({ htmlUrl: rowPage, status: "completed" });
    expect(out.value.other).toEqual({});
    expect(JSON.stringify(out)).not.toMatch(/extension-user-land|actions\/runs|39292347354/);
  });
});
