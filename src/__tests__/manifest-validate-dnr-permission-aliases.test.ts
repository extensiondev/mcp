// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { execFileSync } from "node:child_process";
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
const { MANIFEST_BYTES_MAX, jsonReadFailure, readManifestFile, withoutParserQuote } = await import("../lib/manifest-path");

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
    expect(firefox.dnrIssues[0]).toMatch(/chrome\.declarativeNetRequest.*firefox build's permissions do not include "declarativeNetRequest"/);
    expect(firefox.out.value.browserSupport.firefox.supported).toBe(false);
  });
});

describe("1058: only a manifest.json that really sits in its project is read", () => {
  const tmp = (prefix: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    dirs.push(dir);

    return dir;
  };

  it("1058: a manifestPath that names another file, or sits outside projectPath, is refused before anything is read", async () => {
    const inside = tmp("extjs-manifest-in-");
    const outside = tmp("extjs-manifest-out-");
    const notes = path.join(outside, "notes.env");
    fs.writeFileSync(notes, "SECRET_TOKEN=hunter2-first-line\n");
    fs.writeFileSync(path.join(outside, "package.json"), JSON.stringify({ name: "outside-secret-name" }));
    fs.writeFileSync(path.join(outside, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Outside Secret", version: "1.0.0" }));
    fs.writeFileSync(path.join(inside, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Inside", version: "1.0.0" }));

    for (const args of [
      { manifestPath: notes },
      { manifestPath: path.join(outside, "package.json") },
      { manifestPath: path.join(outside, "missing.json") },
      { manifestPath: path.join(outside, "manifest.json"), projectPath: inside },
      { manifestPath: path.join(inside, "..", path.basename(outside), "manifest.json"), projectPath: inside },
    ]) {
      const parsed = JSON.parse(await manifestValidate.handler(args));

      expect(parsed, JSON.stringify(args)).toMatchObject({ ok: false, status: "manifest-path-refused", error: { code: "E_BAD_REQUEST", retry: "no" }, value: { valid: false } });
      expect(parsed.error.message).toMatch(/so nothing was read\.$/);
      expect(parsed.error.hint).toMatch(/^Pass /);
      expect(JSON.stringify(parsed)).not.toMatch(/SECRET|hunter2|outside-secret-name|Outside Secret/);
    }

    expect(JSON.parse(await manifestValidate.handler({ manifestPath: path.join(inside, "manifest.json"), projectPath: inside })).status).not.toBe("manifest-path-refused");
    expect(JSON.parse(await manifestValidate.handler({ manifestPath: path.join(outside, "manifest.json") })).status).not.toBe("manifest-path-refused");
  });

  it.skipIf(process.platform === "win32")("1058: a manifest.json that is a link to a file outside the project is refused, and a project reached through a linked folder is read", async () => {
    const inside = tmp("extjs-manifest-in-");
    const outside = tmp("extjs-manifest-out-");
    const link = path.join(inside, "manifest.json");
    fs.writeFileSync(path.join(outside, "notes.env"), "SECRET_TOKEN=hunter2-first-line\n");
    fs.writeFileSync(path.join(outside, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Outside Secret", version: "1.0.0" }));
    fs.writeFileSync(path.join(inside, "settings.json"), JSON.stringify({ name: "Inside Secret" }));

    for (const target of [path.join(outside, "notes.env"), path.join(outside, "manifest.json"), path.join(inside, "settings.json")]) {
      fs.rmSync(link, { force: true });
      fs.symlinkSync(target, link);

      for (const args of [{ manifestPath: link }, { projectPath: inside }, { manifestPath: link, projectPath: inside }]) {
        const parsed = JSON.parse(await manifestValidate.handler(args));

        expect(parsed, `${target} ${JSON.stringify(args)}`).toMatchObject({ ok: false, status: "manifest-path-refused", error: { code: "E_BAD_REQUEST" } });
        expect(parsed.error.hint).toMatch(/^(Pass|Put) /);
        expect(JSON.stringify(parsed)).not.toMatch(/SECRET|hunter2|Outside Secret|Inside Secret/);
      }
    }

    const linkedFolder = path.join(outside, "linked-project");
    fs.rmSync(link);
    fs.writeFileSync(link, JSON.stringify({ manifest_version: 3, name: "Inside", version: "1.0.0" }));
    fs.symlinkSync(inside, linkedFolder);

    expect(JSON.parse(await manifestValidate.handler({ manifestPath: path.join(linkedFolder, "manifest.json") })).status).not.toMatch(/refused|unreadable/);
  });

  it("1058: an oversized file is refused unread, and the name is matched in any case", async () => {
    const inside = tmp("extjs-manifest-big-");
    const big = path.join(inside, "manifest.json");
    const shouted = path.join(tmp("extjs-manifest-case-"), "MANIFEST.JSON");
    const read = vi.spyOn(fs, "readSync");
    fs.writeFileSync(big, JSON.stringify({ pad: "x".repeat(MANIFEST_BYTES_MAX - 9) }));
    fs.writeFileSync(shouted, JSON.stringify({ manifest_version: 3, name: "Shouted", version: "1.0.0" }));

    const refused = readManifestFile(big);

    expect(refused).toMatchObject({ ok: false, kind: "unreadable", hint: "Pass the path of the project's own manifest.json and call again." });
    expect(refused.ok ? "" : refused.message).toBe(`${big} is ${MANIFEST_BYTES_MAX + 1} bytes, over the 1048576 bytes a manifest.json is read up to, so it was not read.`);
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();

    fs.writeFileSync(big, JSON.stringify({ pad: "x".repeat(MANIFEST_BYTES_MAX - 10) }));

    expect(fs.statSync(big).size).toBe(MANIFEST_BYTES_MAX);
    expect(readManifestFile(big).ok).toBe(true);
    expect(readManifestFile(shouted)).toMatchObject({ ok: true, manifest: { name: "Shouted" } });
    expect(JSON.parse(await manifestValidate.handler({ manifestPath: shouted })).status).not.toMatch(/refused|unreadable/);
  });

  it.skipIf(process.platform === "win32")("1058: a manifest.json that is not a regular file is answered as unreadable without waiting on it", () => {
    const pipe = path.join(tmp("extjs-manifest-pipe-"), "manifest.json");
    const folder = path.join(tmp("extjs-manifest-dir-"), "manifest.json");
    execFileSync("mkfifo", [pipe]);
    fs.mkdirSync(folder);

    expect(readManifestFile(pipe)).toMatchObject({ ok: false, kind: "unreadable", message: `${pipe} could not be read (ENOTSUP)` });
    expect(readManifestFile(folder)).toMatchObject({ ok: false, kind: "unreadable", message: `${folder} could not be read (EISDIR)` });
  });

  it("1058: a failure is worded as its own sentence, its code or its place, and a relayed parser message loses the text it quoted", () => {
    const file = path.join(tmp("extjs-manifest-words-"), "package.json");
    fs.writeFileSync(file, "root:x:0:0:SECRETLINE\n");

    expect(jsonReadFailure(new Error("the ready contract names no port"), file)).toBe("the ready contract names no port");
    expect(jsonReadFailure(new TypeError("SECRETLINE is not iterable"), file)).toBe("read failed");
    expect(jsonReadFailure(Object.assign(new Error("EACCES: permission denied, open SECRETLINE"), { code: "EACCES" }), file)).toBe("EACCES");
    expect(withoutParserQuote(`${file} cannot be read as JSON (Unexpected token 'r', "root:x:0:0"... is not valid JSON), so no dependency was checked`, file)).toBe(
      `${file} cannot be read as JSON (not valid JSON at line 1, column 1), so no dependency was checked`,
    );

    expect(withoutParserQuote('a (Unexpected token \'S\', ..."T", "x": SECRET"... is not valid JSON) b (Unexpected token r in JSON at position 0) c')).toBe("a (not valid JSON) b (not valid JSON) c");
    expect(withoutParserQuote("Unexpected end of JSON input")).toBe("Unexpected end of JSON input");
  });
});
