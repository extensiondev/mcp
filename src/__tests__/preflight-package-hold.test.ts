import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { isBuildInput } from "../lib/build-inputs";
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
});

const GIT_CELL_BUDGET_MS = 30_000;
