import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readLogEvents } from "../tools/logs-filter";
import { declaredBackground, readBuiltManifest } from "../lib/project-manifest";
import { logsPath } from "../lib/session-paths";
import { handler as analyze } from "../tools/analyze";
import { logFile, logEvent } from "./fixtures/engine-answers";

let root: string;
let sub: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-root-readers-"));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "mono", devDependencies: { extension: "4.1.31" } }),
  );
  sub = path.join(root, "Extensions", "combined");
  fs.mkdirSync(path.join(sub, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(sub, "src", "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "Sub",
      version: "1.0.0",
      background: { "chromium:service_worker": "background.js" },
    }),
  );
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("every reader of a project's files uses the engine's project root", () => {
  it("reads the log the engine wrote under the package root for a manifest subfolder", () => {
    const file = logsPath(sub, "chrome");
    expect(file.startsWith(path.join(root, "dist"))).toBe(true);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, logFile("run-1", [logEvent("background", "error", ["boom"])]));

    expect(readLogEvents(sub, "chrome", { level: "error" })).toHaveLength(1);
  });

  it("reads the built manifest at the package root before the source one", () => {
    const dist = path.join(root, "dist", "chrome");
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(
      path.join(dist, "manifest.json"),
      JSON.stringify({ manifest_version: 3, name: "Sub", version: "1.0.0", background: { service_worker: "sw.js" } }),
    );

    const read = readBuiltManifest(sub, "chrome");
    expect(read?.file).toBe(path.join(dist, "manifest.json"));
    expect(declaredBackground(read!.manifest)).toEqual({ kind: "service_worker", ref: "sw.js" });
  });

  it("folds browser prefixes when it has to fall back to the source manifest", () => {
    const read = readBuiltManifest(sub, "chrome");
    expect(read?.file).toBe(path.join(sub, "src", "manifest.json"));
    expect(declaredBackground(read!.manifest).kind).toBe("service_worker");
    expect(declaredBackground(readBuiltManifest(sub, "firefox")!.manifest).kind).toBe("none");
  });

  it("analyzes the dist at the package root", async () => {
    const dist = path.join(root, "dist", "chrome");
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Sub", version: "1.0.0" }));

    const out = JSON.parse(await analyze({ projectPath: sub }));
    expect(out.ok).toBe(true);
    expect(out.status).not.toBe("no-dist");
  });
});
