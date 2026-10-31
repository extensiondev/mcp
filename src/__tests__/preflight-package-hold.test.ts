import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { isBuildInput } from "../lib/build-inputs";
import { capResetsAt } from "../lib/head-push";
import { handler as submit } from "../tools/submit";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const PREFLIGHT = `${PROJECT_ROUTE}/stores/chrome/submissions/preflight`;
const EDGE_PREFLIGHT = `${PROJECT_ROUTE}/stores/edge/submissions/preflight`;
const BUILDS = `${PROJECT_ROUTE}/builds`;
const PLAN = "/api/workspaces/acme/plan";
const RECEIVED = "2026-10-30T21:11:41.000Z";
const CONNECTED = { kind: "oauth", connectedAs: "cezar@example.com", healthy: true, itemId: "abcdefghijklmnopabcdefghijklmnop", publisherId: "pub-1", itemLinked: true };

function report(store: string, built: string) {
  return {
    store,
    summary: { pass: 1, warn: 1, fail: 0, blockingFailures: 0, canSubmit: true },
    checks: [
      { id: "credentials", label: "Store credentials", status: "pass", severity: "blocking", message: "" },
      { id: "package.third_party_notices", label: "Third-party license notices", status: "warn", severity: "warning", message: `The ${store} package of build ${built} bundles third-party code and carries no license notices file.` },
    ],
    connection: CONNECTED,
  };
}

function gitProject(): { root: string; commit: (files: Record<string, string>, message: string) => string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-preflight-hold-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, stdio: "ignore" });
  git("init", "-q");

  const commit = (files: Record<string, string>, message: string) => {
    for (const [file, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), body);
    }

    git("add", ".");
    git("commit", "-q", "-m", message);

    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  };

  commit({ "manifest.json": '{"name":"Leon","version":"0.1.0"}', "STORE.md": "# Store metadata\n\n## Listing\n\n- Name: Leon\n" }, "code");

  return { root, commit };
}

describe("the rule for what a platform build reads mirrors the platform's own DOCS_ONLY filter", () => {
  it("keeps markdown and notice files outside public/ out of the package and everything else in", () => {
    for (const file of ["STORE.md", "README.md", "docs/guide.mdx", "notes/CHANGELOG.markdown", "LICENSE", "LICENSE-MIT", "NOTICE", "COPYING", "THIRD_PARTY_NOTICES.txt"]) expect(isBuildInput(file), file).toBe(false);
    for (const file of ["manifest.json", "src/index.ts", "images/icon.png", "public/README.md", "public/THIRD_PARTY_NOTICES.txt", "docs/public/x.md", ".github/workflows/store.yml", "package.json", "_locales/en/messages.json", "store.json"]) expect(isBuildInput(file), file).toBe(true);
  });

  it("reads the cap's reset as the first instant of the next UTC month", () => {
    expect(capResetsAt("2026-10")).toBe("2026-11-01T00:00:00Z");
    expect(capResetsAt("2026-12")).toBe("2027-01-01T00:00:00Z");
    expect(capResetsAt("")).toBeNull();
    expect(capResetsAt("2026-13")).toBeNull();
  });
});

describe("the package checks say they still hold when HEAD changes nothing the build reads", () => {
  const platform = useProjectRoutes("extdev-preflight-hold-");

  it("names the changed files, the build the checks hold for, and asks for no push after a STORE.md-only commit", async () => {
    if (process.platform === "win32") return;

    const project = gitProject();
    const built = execFileSync("git", ["rev-parse", "HEAD"], { cwd: project.root, encoding: "utf8" }).trim();
    const builtShort = built.slice(0, 7);
    const head = project.commit({ "STORE.md": "# Store metadata\n\n## Listing\n\n- Name: Leon\n- Category: Productivity\n" }, "store line");
    const short = head.slice(0, 7);

    platform.login();
    platform.routes[`POST ${PREFLIGHT}`] = () => ({ body: report("chrome", builtShort) });
    platform.routes[`POST ${EDGE_PREFLIGHT}`] = () => ({ body: report("edge", builtShort) });
    platform.routes[`GET ${BUILDS}`] = () => ({ body: { items: [{ buildId: builtShort, commit: built, status: "success" }] } });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["chrome", "edge"], projectPath: project.root, api: API }));
    const say = `chrome: the package checks read build ${builtShort}; HEAD ${short} changes only STORE.md, which the build does not read, so the package checks still hold for build ${builtShort} and no push is needed.`;

    expect(out.status).toBe("preflight-read");
    expect(out.value.stores.chrome.packageBuild).toEqual({ read: [builtShort], head: short, holds: { build: builtShort, changed: ["STORE.md"] }, say });
    expect(out.value.stores.edge.packageBuild.say).toBe(say.replace("chrome:", "edge:"));
    expect(out.hint.split(say)).toHaveLength(2);
    expect(JSON.stringify(out)).not.toContain("push it");
    expect(platform.sent("GET", PLAN)).toHaveLength(0);
  });

  it("keeps the push advice when a changed file lands in the package, public/ included", async () => {
    if (process.platform === "win32") return;

    const project = gitProject();
    const built = execFileSync("git", ["rev-parse", "HEAD"], { cwd: project.root, encoding: "utf8" }).trim();
    const builtShort = built.slice(0, 7);

    platform.login();
    platform.routes[`POST ${PREFLIGHT}`] = () => ({ body: report("chrome", builtShort) });
    platform.routes[`GET ${BUILDS}`] = () => ({ body: { items: [{ buildId: builtShort, commit: built, status: "success" }] } });

    const code = project.commit({ "README.md": "# Leon\n", "src/index.ts": "export {};\n" }, "code and readme").slice(0, 7);
    const withCode = JSON.parse(await submit({ action: "preflight", browsers: ["chrome"], projectPath: project.root, api: API }));

    expect(withCode.value.stores.chrome.packageBuild).toEqual({ read: [builtShort], head: code, say: `chrome: the package checks read build ${builtShort}; HEAD ${code} has no platform build yet; push it so the package checks read it.` });

    const packaged = project.commit({ "public/NOTES.md": "shipped inside the package\n" }, "packaged markdown").slice(0, 7);
    const withPublic = JSON.parse(await submit({ action: "preflight", browsers: ["chrome"], projectPath: project.root, api: API }));

    expect(withPublic.value.stores.chrome.packageBuild.say).toBe(`chrome: the package checks read build ${builtShort}; HEAD ${packaged} has no platform build yet; push it so the package checks read it.`);
    expect(withPublic.value.stores.chrome.packageBuild.holds).toBeUndefined();
  });
});

describe("a push the platform refused over the build cap is named as refused, with the reset and the newest submittable build", () => {
  const platform = useProjectRoutes("extdev-preflight-cap-");
  const OLDER = { buildId: "154767e", commit: "154767e96aca6864db7db35d00154940807560e1", status: "success" };
  const NEWEST = { buildId: "914c593", commit: "914c593a6aca6864db7db35d00154940807560e1", status: "success" };

  function pushed(head: string, outcome: string) {
    return { commit: head, ref: "main", receivedAt: RECEIVED, outcome, dispatched: false };
  }

  it("says the monthly build cap refused HEAD, when it resets, and which build is submittable, reading the plan once for two stores", async () => {
    if (process.platform === "win32") return;

    const project = gitProject();
    const head = project.commit({ "src/index.ts": "export const leon = 1;\n" }, "feature");
    const short = head.slice(0, 7);

    platform.login();
    platform.routes[`POST ${PREFLIGHT}`] = () => ({ body: report("chrome", "154767e") });
    platform.routes[`POST ${EDGE_PREFLIGHT}`] = () => ({ body: report("edge", "154767e") });
    platform.routes[`GET ${BUILDS}`] = () => ({ body: { items: [NEWEST, OLDER], lastPush: pushed(head, "QUOTA_EXCEEDED") } });
    platform.routes[`GET ${PLAN}`] = () => ({ body: { plan: "pro", month: "2026-10", limits: { buildsPerMonth: 350 }, used: { buildsThisMonth: 352 } } });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["chrome", "edge"], projectPath: project.root, api: API }));
    const say = `chrome: the package checks read build 154767e; HEAD ${short} was pushed (received 2026-10-30T21:11:41Z) and the platform refused it over the monthly build cap (352 of 350 builds this month; the cap resets 2026-11-01T00:00:00Z); the newest submittable build is 914c593.`;

    expect(out.value.stores.chrome.packageBuild).toEqual({ read: ["154767e"], head: short, headPush: { outcome: "QUOTA_EXCEEDED", receivedAt: "2026-10-30T21:11:41Z" }, say });
    expect(out.value.stores.edge.packageBuild.say).toBe(say.replace("chrome:", "edge:"));
    expect(out.hint.split(say)).toHaveLength(2);
    expect(JSON.stringify(out)).not.toContain("push it");
    expect(platform.sent("GET", PLAN)).toHaveLength(1);
    expect(platform.sent("GET", BUILDS)).toHaveLength(1);
  });

  it("names the counter without a cap claim when the plan cannot be read, and the reset for spent push builds", async () => {
    if (process.platform === "win32") return;

    const project = gitProject();
    const head = project.commit({ "src/index.ts": "export const leon = 2;\n" }, "feature");
    const short = head.slice(0, 7);

    platform.login();
    platform.routes[`POST ${PREFLIGHT}`] = () => ({ body: report("chrome", "154767e") });
    platform.routes[`GET ${BUILDS}`] = () => ({ body: { items: [OLDER], lastPush: pushed(head, "QUOTA_EXCEEDED") } });
    platform.routes[`GET ${PLAN}`] = () => ({ status: 503, body: { error: { code: "GITHUB_BUDGET_SPENT" } } });

    const unread = JSON.parse(await submit({ action: "preflight", browsers: ["chrome"], projectPath: project.root, api: API }));

    expect(unread.value.stores.chrome.packageBuild.say).toBe(
      `chrome: the package checks read build 154767e; HEAD ${short} was pushed (received 2026-10-30T21:11:41Z) and the platform refused it as QUOTA_EXCEEDED (the platform's build counter refused the dispatch; extension_workspace info reads the allowance); the newest submittable build is 154767e.`,
    );

    platform.routes[`GET ${BUILDS}`] = () => ({ body: { items: [OLDER], lastPush: pushed(head, "PUSH_BUILDS_EXHAUSTED") } });
    platform.routes[`GET ${PLAN}`] = () => ({ body: { plan: "free", month: "2026-10", limits: { buildsPerMonth: 100 }, used: { buildsThisMonth: 40 } } });

    const exhausted = JSON.parse(await submit({ action: "preflight", browsers: ["chrome"], projectPath: project.root, api: API }));

    expect(exhausted.value.stores.chrome.packageBuild.say).toBe(
      `chrome: the package checks read build 154767e; HEAD ${short} was pushed (received 2026-10-30T21:11:41Z) and the platform refused it as PUSH_BUILDS_EXHAUSTED: the workspace's push builds for this month are spent; the cap resets 2026-11-01T00:00:00Z (extension_workspace info reads the allowance); the newest submittable build is 154767e.`,
    );
  });

  it("leads with the local proof and keeps the refusal when the refused HEAD changes only docs", async () => {
    if (process.platform === "win32") return;

    const project = gitProject();
    const built = execFileSync("git", ["rev-parse", "HEAD"], { cwd: project.root, encoding: "utf8" }).trim();
    const builtShort = built.slice(0, 7);
    const head = project.commit({ "STORE.md": "# Store metadata\n\n## Listing\n\n- Name: Leon\n- Visibility: unlisted\n" }, "store line");
    const short = head.slice(0, 7);

    platform.login();
    platform.routes[`POST ${PREFLIGHT}`] = () => ({ body: report("chrome", builtShort) });
    platform.routes[`GET ${BUILDS}`] = () => ({ body: { items: [{ buildId: builtShort, commit: built, status: "success" }], lastPush: pushed(head, "QUOTA_EXCEEDED") } });
    platform.routes[`GET ${PLAN}`] = () => ({ body: { plan: "pro", month: "2026-10", limits: { buildsPerMonth: 350 }, used: { buildsThisMonth: 350 } } });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["chrome"], projectPath: project.root, api: API }));

    expect(out.value.stores.chrome.packageBuild.holds).toEqual({ build: builtShort, changed: ["STORE.md"] });
    expect(out.value.stores.chrome.packageBuild.say).toBe(
      `chrome: the package checks read build ${builtShort}; HEAD ${short} changes only STORE.md, which the build does not read, so the package checks still hold for build ${builtShort} and no push is needed; HEAD ${short} was pushed (received 2026-10-30T21:11:41Z) and the platform refused it over the monthly build cap (350 of 350 builds this month; the cap resets 2026-11-01T00:00:00Z); the newest submittable build is ${builtShort}.`,
    );
  });
});
