// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { describe, expect, it } from "vitest";

import { TOOL_POLICY } from "../lib/tool-policy";
import { FULL_SHA, MIRROR_REPO, MIRROR_RUN_URL, WORLD_API, usePlatformWorld } from "./fixtures/platform-world";
import { WORLD_CASES, type WorldCase } from "./fixtures/platform-world-cases";

const FORBIDDEN = [/extension-user-land(-dev)?\//, /actions\/runs\//, /\bmirror\b/i, /\b\d+--prj_/];
const P = "/api/projects/prj_world";

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
    if (["runId", "workflowRunId", "runUrl", "workflowRunUrl"].includes(key)) return [`${at}.${key}`];

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

  it("flags no platform tool as operator-facing, so every one of them is held to this", () => {
    const platform = Object.entries(TOOL_POLICY).filter(([, policy]) => policy.group === "platform");

    expect(platform.length).toBeGreaterThanOrEqual(11);
    for (const [name] of platform) expect(WORLD_CASES[name]?.length ?? 0, name).toBeGreaterThan(0);
  });

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

  it("still relays the failed step and its lines from a build whose run the platform linked", async () => {
    if (process.platform === "win32") return;

    world.login();

    const out = await world.call("extension_builds", { action: "logs", buildId: "603fc8a", api: WORLD_API });

    expect(out.ok).toBe(true);
    expect(out.value.run.failedJob).toMatchObject({ name: "build", step: "Checkout" });
    expect(out.value.run.failedJob.lines).toHaveLength(2);
    expect(out.value.runUrl).toBeUndefined();
    expect(out.hint).toContain("http://console.extension.localhost/acme/widget/builds/603fc8a");
  });

  it("keeps the run id a rebuild needs to be matched under internal only", async () => {
    if (process.platform === "win32") return;

    world.login();

    const out = await world.call("extension_builds", { action: "rebuild", buildId: FULL_SHA, api: WORLD_API });

    expect(out.value.internal).toEqual({ runId: 18234567999 });
    expect(out.value.runId).toBeUndefined();
    expect(out.hint).not.toContain("18234567999");
  });
});
