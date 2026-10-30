import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { LINK_ITEM_POINTER } from "../lib/link-item-answer";
import { buildsReadByPackageChecks } from "../lib/package-checks-build";
import { handler as submit } from "../tools/submit";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const PREFLIGHT = `${PROJECT_ROUTE}/stores/chrome/submissions/preflight`;
const BUILDS = `${PROJECT_ROUTE}/builds`;
const PACKAGE = "http://localhost:3100/api/projects/prj_probe/builds/154767e/chrome.zip?token=signed";
const NEW_ITEM = "https://chrome.google.com/webstore/devconsole/";
const LINK_ITEM = "http://console.extension.localhost/acme/widget/project-settings/stores?link=chrome";

const CONNECTED = { kind: "oauth", connectedAs: "cezar@example.com", healthy: true, itemId: "abcdefghijklmnopabcdefghijklmnop", publisherId: "pub-1", itemLinked: true };

const DESCRIPTION_ROW = {
  id: "chrome.package_description",
  label: "Manifest description fits Chrome's 132 characters",
  severity: "blocking",
  status: "fail",
  message: "The manifest description of build 154767e is 171 characters, over the 132 Chrome allows; the store reads it as the listing summary and refuses the package. Shorten it and rebuild.",
  expected: "up to 132 characters",
  actual: "171 characters",
  docs: "https://developer.chrome.com/docs/extensions/reference/manifest/description",
};

const PRIVACY_ROW = {
  id: "chrome.privacy_policy_for_user_data",
  label: "A package that reads user data links a privacy policy",
  severity: "warn",
  status: "fail",
  message: "The Chrome package of build 154767e reads user data and the listing carries no privacy policy URL.",
  docs: "https://developer.chrome.com/docs/webstore/program-policies/user-data-faq",
};

function report(extra: Record<string, unknown> = {}, connection: Record<string, unknown> = CONNECTED) {
  return {
    store: "chrome",
    summary: { pass: 1, warn: 1, fail: 0, blockingFailures: 0, canSubmit: true },
    checks: [
      { id: "credentials", label: "Store credentials", status: "pass", severity: "blocking", message: "" },
      {
        id: "package.third_party_notices",
        label: "Third-party license notices",
        status: "warn",
        severity: "warning",
        message: "The chrome package of build 154767e bundles third-party code and carries no license notices file.",
      },
    ],
    connection,
    ...extra,
  };
}

function gitProject(): { root: string; head: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-preflight-build-"));
  fs.writeFileSync(path.join(root, "STORE.md"), "# Store metadata\n\n## Listing\n\n- Name: Hands-free\n");
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("add", ".");
  git("commit", "-q", "-m", "notices");

  return { root, head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim() };
}

describe("the Chrome preflight says the owner's step once and points the other fields at it", () => {
  const platform = useProjectRoutes("extdev-preflight-once-");

  it("store-item-not-linked carries the sentences in sayToPerson only; hint and nextStep.say point at it", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT}`] = () => ({
      body: report({}, { kind: "oauth", connectedAs: "cezar@example.com", healthy: true, itemId: null, itemLinked: false, newItemUrl: NEW_ITEM, packageUrl: PACKAGE, linkItemUrl: LINK_ITEM }),
    });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["chrome"], api: API }));

    expect(out.status).toBe("store-item-not-linked");
    expect(out.value.sayToPerson).toContain(`with this package ${PACKAGE}, and fill its Store listing and Privacy tabs there`);
    expect(out.hint).toBe(LINK_ITEM_POINTER);
    expect(out.value.nextStep).toMatchObject({ kind: "link-item", say: LINK_ITEM_POINTER, url: LINK_ITEM });
    expect(out.value.packageUrl).toBe(PACKAGE);
    expect(out.hint).not.toContain(PACKAGE);
    expect(out.value.nextStep.say).not.toContain(PACKAGE);
    expect(out.value.sayToPerson.split(PACKAGE)).toHaveLength(2);
    expect(JSON.stringify(out).split("One step is yours, once")).toHaveLength(2);
    expect(JSON.stringify(out).length).toBeLessThan(6000);
  });
});

describe("every id storePreflight names has a row that explains it", () => {
  const platform = useProjectRoutes("extdev-preflight-ids-");

  it("carries the platform's rows for the blocking and warning ids, with label, expected, actual and what to do", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT}`] = () => ({
      body: report({
        chromePreflight: {
          act: "upload",
          checks: [{ id: "chrome.package_manifest_v3", label: "Package is Manifest V3", severity: "blocking", status: "pass", message: "The Chrome package of build 154767e is Manifest V3." }, DESCRIPTION_ROW, PRIVACY_ROW],
          blocking: ["chrome.package_description"],
          warnings: ["chrome.privacy_policy_for_user_data"],
          lock: null,
          inFlight: null,
          approval: "Upload lands as a draft beside what Chrome serves and enters no review; Chrome is reviewing nothing else for this item.",
        },
      }),
    });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["chrome"], api: API }));
    const block = out.value.storePreflight.chrome;

    expect(block.blocking).toEqual(["chrome.package_description"]);
    expect(block.warnings).toEqual(["chrome.privacy_policy_for_user_data"]);
    expect(block.checks).toEqual([
      {
        id: "chrome.package_description",
        label: "Manifest description fits Chrome's 132 characters",
        severity: "blocking",
        status: "fail",
        expected: "up to 132 characters",
        actual: "171 characters",
        message: DESCRIPTION_ROW.message,
        docsUrl: DESCRIPTION_ROW.docs,
      },
      {
        id: "chrome.privacy_policy_for_user_data",
        label: "A package that reads user data links a privacy policy",
        severity: "warn",
        status: "fail",
        message: PRIVACY_ROW.message,
        docsUrl: PRIVACY_ROW.docs,
      },
    ]);

    expect(block.checks.map((row: { id: string }) => row.id)).toEqual([...block.blocking, ...block.warnings]);
  });

  it("names the platform endpoint when an id in blocking has no row of its own", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT}`] = () => ({
      body: report({
        chromePreflight: { act: "upload", checks: [], blocking: ["chrome.package_description"], warnings: [], lock: null, inFlight: null, approval: "Upload lands as a draft." },
      }),
    });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["chrome"], api: API }));

    expect(out.value.storePreflight.chrome.checks).toEqual([
      {
        id: "chrome.package_description",
        label: "chrome.package_description",
        status: "fail",
        actual: "the platform's store preflight named it without a reason: POST stores/chrome/submissions/preflight listed it in chromePreflight.blocking with no row of that id in chromePreflight.checks",
        expected: "a row in chromePreflight.checks with the rule's label, expected, actual and what to do",
      },
    ]);
  });

  it("answers no checks list when nothing blocks or warns", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT}`] = () => ({
      body: report({ chromePreflight: { act: "upload", checks: [DESCRIPTION_ROW], blocking: [], warnings: [], lock: null, inFlight: null, approval: "Upload lands as a draft." } }),
    });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["chrome"], api: API }));

    expect(out.value.storePreflight.chrome).not.toHaveProperty("checks");
  });
});

describe("the package checks name the build they read and say once when HEAD is newer", () => {
  const platform = useProjectRoutes("extdev-preflight-build-");

  it("reads the build ids out of the package checks and the store block, once each", () => {
    const ids = buildsReadByPackageChecks(
      report({ chromePreflight: { checks: [DESCRIPTION_ROW, { id: "x", message: "The Chrome package of build 154767e has no manifest name." }] } }),
      "chrome",
    );

    expect(ids).toEqual(["154767e"]);
    expect(buildsReadByPackageChecks({ checks: [{ id: "credentials", message: "" }] }, "chrome")).toEqual([]);
  });

  it("says once that the checks read an older build and HEAD is pending on the platform", async () => {
    if (process.platform === "win32") return;

    const { root, head } = gitProject();
    const short = head.slice(0, 7);

    platform.login();
    platform.routes[`POST ${PREFLIGHT}`] = () => ({ body: report({ chromePreflight: { act: "upload", checks: [DESCRIPTION_ROW], blocking: ["chrome.package_description"], warnings: [], lock: null, inFlight: null, approval: "Upload lands as a draft." } }) });
    platform.routes[`GET ${BUILDS}`] = () => ({ body: { items: [{ buildId: short, commit: head, status: "building" }, { buildId: "154767e", commit: "154767e96aca6864db7db35d00154940807560e1", status: "success" }] } });
    platform.routes[`GET ${BUILDS}/${short}`] = () => ({ body: { build: { buildId: short, commit: head, status: "building" } } });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["chrome"], projectPath: root, api: API }));
    const say = `chrome: the package checks read build 154767e; HEAD ${short} is pending on the platform: build ${short} of the checked out commit is building on the platform, not completed.`;

    expect(out.status).toBe("preflight-read");
    expect(out.value.stores.chrome.packageBuild).toEqual({ read: ["154767e"], head: short, say });
    expect(out.hint.split(say)).toHaveLength(2);
    expect(out.value.sayToPerson.split(say)).toHaveLength(2);
    expect(JSON.stringify(out.value.stores.chrome.warnings).split("pending on the platform")).toHaveLength(1);
  });

  it("says nothing about the build when the checks read the checked out commit", async () => {
    if (process.platform === "win32") return;

    const { root, head } = gitProject();
    const short = head.slice(0, 7);
    const row = { ...DESCRIPTION_ROW, message: DESCRIPTION_ROW.message.replace("154767e", short) };

    platform.login();
    platform.routes[`POST ${PREFLIGHT}`] = () => ({
      body: report({ chromePreflight: { act: "upload", checks: [row], blocking: ["chrome.package_description"], warnings: [], lock: null, inFlight: null, approval: "Upload lands as a draft." } }),
    });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["chrome"], projectPath: root, api: API }));

    expect(out.value.stores.chrome.packageBuild).toBeUndefined();
    expect(out.hint).not.toContain("package checks read");
    expect(platform.sent("GET", BUILDS)).toHaveLength(0);
  });
});
