import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { tools as ALL_TOOLS } from "../index";
import * as browsers from "../tools/browsers";

import * as manifestValidate from "../tools/manifest-validate";
import * as analyze from "../tools/analyze";
import * as inspectTool from "../tools/inspect";
import * as logs from "../tools/logs";
import * as storage from "../tools/storage";
import * as addFeature from "../tools/add-feature";

vi.mock("../lib/cdp-port", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/cdp-port")>()),
  resolveCdpPort: async () => null,
  resolveRdpPort: async () => null,
}));

describe("MCP Server tool registry", () => {
  it("has exactly 28 tools", () => {
    expect(ALL_TOOLS.length).toBe(28);
  });

  for (const tool of ALL_TOOLS) {
    describe(`tool: ${tool.schema.name}`, () => {
      it("exports a schema with name, description, and inputSchema", () => {
        expect(tool.schema).toBeDefined();
        expect(typeof tool.schema.name).toBe("string");
        expect(tool.schema.name).toMatch(/^extension_/);
        expect(typeof tool.schema.description).toBe("string");
        expect(tool.schema.description.length).toBeGreaterThan(10);
        expect(tool.schema.inputSchema).toBeDefined();
        expect(tool.schema.inputSchema.type).toBe("object");
        expect(tool.schema.inputSchema.properties).toBeDefined();
      });

      it("exports a handler function", () => {
        expect(typeof tool.handler).toBe("function");
      });

      it("has unique tool name", () => {
        const otherTools = ALL_TOOLS.filter((t) => t !== tool);
        const duplicate = otherTools.find(
          (t) => t.schema.name === tool.schema.name,
        );
        expect(duplicate).toBeUndefined();
      });
    });
  }
});

describe("Tool schema validation", () => {
  it("required fields reference existing properties", () => {
    for (const tool of ALL_TOOLS) {
      const required = (tool.schema.inputSchema.required ?? []) as string[];
      const properties = Object.keys(
        (tool.schema.inputSchema.properties ?? {}) as Record<string, unknown>,
      );
      for (const field of required) {
        expect(properties).toContain(field);
      }
    }
  });
});

describe("extension_browsers list action", () => {
  it("returns valid JSON with expected fields", async () => {
    const result = await browsers.handler({ action: "list" });
    const parsed = JSON.parse(result);
    expect(typeof parsed.value.cacheRoot).toBe("string");
    expect(typeof parsed.value.cacheExists).toBe("boolean");
    expect(Array.isArray(parsed.value.installed)).toBe(true);
    expect(Array.isArray(parsed.value.availableToInstall)).toBe(true);
  });
});

describe("manifest-validate handler", () => {
  const writeManifest = (manifest: Record<string, unknown>): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "extjs-manifest-"));
    const file = path.join(dir, "manifest.json");
    fs.writeFileSync(file, JSON.stringify(manifest));
    return file;
  };

  it("returns error for non-existent manifest", async () => {
    const result = await manifestValidate.handler({
      manifestPath: "/tmp/nonexistent-manifest.json",
    });
    const parsed = JSON.parse(result);
    expect(parsed.value.valid).toBe(false);
    expect(parsed.value.errors.length).toBeGreaterThan(0);
  });

  it("recognizes chrome:/edge: prefixes, not just chromium:", async () => {
    const file = writeManifest({
      name: "prefixed",
      version: "1.0.0",
      "chrome:manifest_version": 2,
    });
    const parsed = JSON.parse(
      await manifestValidate.handler({ manifestPath: file, browsers: ["chrome"] }),
    );
    expect(parsed.value.errors).not.toContain(
      expect.stringContaining("Missing manifest_version"),
    );
    expect(parsed.value.browserSupport.chrome.issues.join(" ")).toContain(
      "Manifest V2 is deprecated",
    );
  });

  it("accepts nested firefox:scripts as the background fallback", async () => {
    const file = writeManifest({
      name: "bg",
      version: "1.0.0",
      manifest_version: 3,
      background: {
        service_worker: "sw.js",
        "firefox:scripts": ["bg.js"],
      },
    });
    const parsed = JSON.parse(
      await manifestValidate.handler({
        manifestPath: file,
        browsers: ["firefox"],
      }),
    );
    expect(parsed.value.browserSupport.firefox.issues.join(" ")).not.toContain(
      "firefox:scripts",
    );
  });

  it("flags a Firefox background missing its scripts fallback", async () => {
    const file = writeManifest({
      name: "bg",
      version: "1.0.0",
      manifest_version: 3,
      background: { service_worker: "sw.js" },
    });
    const parsed = JSON.parse(
      await manifestValidate.handler({
        manifestPath: file,
        browsers: ["firefox"],
      }),
    );
    expect(parsed.value.browserSupport.firefox.issues.join(" ")).toContain(
      "firefox:scripts",
    );
  });
});

describe("analyze handler", () => {
  it("returns error when dist does not exist", async () => {
    const result = await analyze.handler({
      projectPath: "/tmp/nonexistent-project",
    });
    const parsed = JSON.parse(result);
    expect(parsed.error).toBeDefined();
    expect(parsed.error.message).toContain("not found");
  });

  it("excludes .zip artifacts from the shippable size", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-inspect-zip-"));
    try {
      const distDir = path.join(dir, "dist", "chrome");
      fs.mkdirSync(distDir, { recursive: true });
      fs.writeFileSync(
        path.join(distDir, "manifest.json"),
        JSON.stringify({ manifest_version: 3, name: "F", version: "1.0.0" }),
      );
      fs.writeFileSync(path.join(distDir, "background.js"), "x".repeat(1000));
      const zipSize = 11 * 1024 * 1024;
      fs.writeFileSync(
        path.join(distDir, "zipprobeext-1.0.0.zip"),
        Buffer.alloc(zipSize),
      );

      const parsed = JSON.parse(await analyze.handler({ projectPath: dir }));

      expect(parsed.value.byType.archive.count).toBe(1);
      expect(parsed.value.totalSize).toBe(parsed.value.shippableSize + zipSize);
      expect(parsed.value.shippableSize).toBe(
        parsed.value.totalSize - parsed.value.byType.archive.size,
      );
      expect(parsed.warnings.join(" ")).toContain("shippableSize excludes them");
      expect(parsed.value.buildType).toBe("production");
      expect(parsed.value.totalSize).toBeGreaterThan(10 * 1024 * 1024);
      expect(parsed.value.storeReadiness.under10MB).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps shippableSize intact when no archive is present", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-inspect-nozip-"));
    try {
      const distDir = path.join(dir, "dist", "chrome");
      fs.mkdirSync(distDir, { recursive: true });
      fs.writeFileSync(
        path.join(distDir, "manifest.json"),
        JSON.stringify({ manifest_version: 3, name: "F", version: "1.0.0" }),
      );
      fs.writeFileSync(path.join(distDir, "background.js"), "x".repeat(1000));

      const parsed = JSON.parse(await analyze.handler({ projectPath: dir }));

      expect(parsed.value.shippableSize).toBe(parsed.value.totalSize);
      expect(parsed.warnings.join(" ")).not.toContain("shippableSize excludes them");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("add-feature handler", () => {
  it("returns error when manifest does not exist", async () => {
    const result = await addFeature.handler({
      projectPath: "/tmp/nonexistent-project",
      feature: "sidebar",
    });
    const parsed = JSON.parse(result);
    expect(parsed.error).toBeDefined();
    expect(parsed.error.message).toContain("manifest.json");
  });
});

describe("inspect handler", () => {
  it("documents the Firefox bridge pairing instead of a Chromium-only claim", () => {
    expect(inspectTool.schema.description).toContain("agent bridge");
    expect(inspectTool.schema.description).toContain("Firefox");
    expect(inspectTool.schema.description).not.toMatch(/Chromium only/i);
  });

  it("returns error when no dev session is running", async () => {
    const result = await inspectTool.handler({
      projectPath: "/tmp/nonexistent-project",
    });
    const parsed = JSON.parse(result);
    expect(parsed.error).toBeDefined();
    expect(parsed.hint).toContain("dev session");
  });
});

describe("logs handler", () => {
  it("returns error when no logs file exists (one-shot)", async () => {
    const result = await logs.handler({
      projectPath: "/tmp/nonexistent-project-logs",
    });
    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.status).toBe("no-log-file");
    expect(parsed.error.code).toBe("E_LOGS_MISSING");
    expect(parsed.error.message).toContain("No logs found");
  });

  it("reads, filters, and caps events from logs.ndjson", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "extjs-logs-"));
    const dir = path.join(root, "dist", "extension-js", "chrome");
    fs.mkdirSync(dir, { recursive: true });
    const lines = [
      { v: 1, type: "header", runId: "run-xyz", startedAt: "2026-05-27T00:00:00.000Z" },
      { v: 1, id: "a", seq: 1, timestamp: 1, level: "info", context: "background", messageParts: ["boot"], runId: "run-xyz" },
      { v: 1, id: "b", seq: 2, timestamp: 2, level: "error", context: "content", messageParts: ["boom"], eventType: "dx.signal", code: "X", status: "fail", url: "https://shop.example/checkout", hostname: "shop.example", tabId: 7, runId: "run-xyz" },
      { v: 1, id: "c", seq: 3, timestamp: 3, level: "debug", context: "background", messageParts: ["noise"], runId: "run-xyz" },
    ];
    fs.writeFileSync(
      path.join(dir, "logs.ndjson"),
      lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    );

    const all = JSON.parse(await logs.handler({ projectPath: root }));
    expect(all.ok).toBe(true);
    expect(all.value.source).toBe("file");
    expect(all.value.runId).toBe("run-xyz");
    expect(all.value.count).toBe(3);
    expect(all.value.nextSince).toBe(3);

    const signals = JSON.parse(await logs.handler({ projectPath: root, signalsOnly: true }));
    expect(signals.value.count).toBe(1);
    expect(signals.value.events[0].code).toBe("X");

    const errors = JSON.parse(await logs.handler({ projectPath: root, level: "error" }));
    expect(errors.value.count).toBe(1);
    expect(errors.value.events[0].seq).toBe(2);

    const since = JSON.parse(await logs.handler({ projectPath: root, since: 2 }));
    expect(since.value.count).toBe(1);
    expect(since.value.events[0].seq).toBe(3);

    const byUrl = JSON.parse(await logs.handler({ projectPath: root, url: "shop.example/*" }));
    expect(byUrl.value.count).toBe(1);
    expect(byUrl.value.events[0].seq).toBe(2);
    const byUrlSubstr = JSON.parse(await logs.handler({ projectPath: root, url: "checkout" }));
    expect(byUrlSubstr.value.count).toBe(1);
    expect(byUrlSubstr.value.events[0].seq).toBe(2);

    const byTab = JSON.parse(await logs.handler({ projectPath: root, tab: 7 }));
    expect(byTab.value.count).toBe(1);
    expect(byTab.value.events[0].seq).toBe(2);
    const byTabMiss = JSON.parse(await logs.handler({ projectPath: root, tab: 999 }));
    expect(byTabMiss.value.count).toBe(0);

    const capped = JSON.parse(await logs.handler({ projectPath: root, limit: 1 }));
    expect(capped.value.count).toBe(1);
    expect(capped.value.windowTruncated).toBe(true);
    expect(capped.value.events[0].seq).toBe(3);

    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("storage act tool", () => {
  it("rejects set without a value before shelling out", async () => {
    const result = JSON.parse(
      await storage.handler({
        projectPath: "/tmp/whatever",
        action: "set",
        key: "k",
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ name: "BadRequest" });
  });
});
