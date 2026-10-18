// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, afterEach, vi } from "vitest";

import type * as TemplatesCacheModule from "../lib/templates-cache";

vi.mock("../lib/templates-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof TemplatesCacheModule>();

  return { ...actual, listTemplates: async () => [] };
});

const manifestValidate = await import("../tools/manifest-validate");

const dirs: string[] = [];

const BASE = {
  "chromium:manifest_version": 3,
  "firefox:manifest_version": 2,
  name: "pii-shield",
  version: "1.0.0",
};

const DNR_CALL = "export async function rules() { return chrome.declarativeNetRequest.getDynamicRules(); }\n";

function project(manifest: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-validate-dnr-"));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "manifest.json"), JSON.stringify({ ...BASE, ...manifest }));
  fs.writeFileSync(path.join(dir, "src", "background.ts"), DNR_CALL);

  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function validate(projectPath: string, browser: string) {
  const out = JSON.parse(await manifestValidate.handler({ projectPath, browsers: [browser] }));
  const dnrWarnings = (out.value.warnings as string[]).filter((w) => w.includes("chrome.declarativeNetRequest"));
  const dnrIssues = ((out.value.browserSupport[browser]?.issues ?? []) as string[]).filter((w) =>
    w.includes("declarativeNetRequest"),
  );

  return { out, dnrWarnings, dnrIssues };
}

describe("declarativeNetRequestWithHostAccess grants chrome.declarativeNetRequest in the permission scan", () => {
  it("does not warn on a chrome build when only chromium:permissions carries declarativeNetRequestWithHostAccess", async () => {
    const dir = project({ "chromium:permissions": ["declarativeNetRequestWithHostAccess"], "chromium:host_permissions": ["<all_urls>"] });
    const { out, dnrWarnings, dnrIssues } = await validate(dir, "chrome");
    expect(dnrWarnings).toEqual([]);
    expect(dnrIssues).toEqual([]);
    expect(out.value.browserSupport.chrome.supported).toBe(true);
  });

  it("does not warn on a firefox build when only firefox:permissions carries declarativeNetRequestWithHostAccess", async () => {
    const dir = project({ "firefox:permissions": ["declarativeNetRequestWithHostAccess", "<all_urls>"] });
    const { out, dnrWarnings, dnrIssues } = await validate(dir, "firefox");
    expect(dnrWarnings).toEqual([]);
    expect(dnrIssues).toEqual([]);
    expect(out.value.browserSupport.firefox.supported).toBe(true);
  });

  it("does not warn when the bare permissions key carries declarativeNetRequestWithHostAccess", async () => {
    const dir = project({ permissions: ["declarativeNetRequestWithHostAccess"] });
    const { dnrWarnings, dnrIssues } = await validate(dir, "chrome");
    expect(dnrWarnings).toEqual([]);
    expect(dnrIssues).toEqual([]);
  });

  it("still accepts the bare permissions key with declarativeNetRequest itself", async () => {
    const dir = project({ permissions: ["declarativeNetRequest"] });
    const { dnrWarnings, dnrIssues } = await validate(dir, "chrome");
    expect(dnrWarnings).toEqual([]);
    expect(dnrIssues).toEqual([]);
  });

  it("keeps the warning, naming both grants, when declarativeNetRequestFeedback is the only one declared", async () => {
    const dir = project({ permissions: ["declarativeNetRequestFeedback"] });
    const { dnrWarnings } = await validate(dir, "chrome");
    expect(dnrWarnings).toHaveLength(1);
    expect(dnrWarnings[0]).toMatch(/"declarativeNetRequest" or "declarativeNetRequestWithHostAccess"/);
    expect(dnrWarnings[0]).toMatch(/declarativeNetRequestFeedback/);
  });

  it("keeps the warning when none of the three permissions is declared", async () => {
    const dir = project({ permissions: ["storage"] });
    const { dnrWarnings } = await validate(dir, "chrome");
    expect(dnrWarnings).toHaveLength(1);
    expect(dnrWarnings[0]).toMatch(/Code calls chrome\.declarativeNetRequest but "declarativeNetRequest" is not in permissions/);
    expect(dnrWarnings[0]).toMatch(/"declarativeNetRequest" or "declarativeNetRequestWithHostAccess"/);
  });

  it("flags the firefox build when declarativeNetRequestWithHostAccess sits only under chromium:permissions", async () => {
    const dir = project({ "chromium:permissions": ["declarativeNetRequestWithHostAccess"] });
    const chrome = await validate(dir, "chrome");
    expect(chrome.dnrWarnings).toEqual([]);
    expect(chrome.dnrIssues).toEqual([]);
    const firefox = await validate(dir, "firefox");
    expect(firefox.dnrWarnings).toEqual([]);
    expect(firefox.dnrIssues).toHaveLength(1);
    expect(firefox.dnrIssues[0]).toMatch(/browser\.declarativeNetRequest.*firefox build's permissions do not include "declarativeNetRequest"/);
    expect(firefox.out.value.browserSupport.firefox.supported).toBe(false);
  });
});
