import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  actionsPath,
  browserArtifactsDir,
  buildSummaryPath,
  eventsPath,
  logsPath,
  readyContractPath,
  sessionArtifactsRootDir,
  sessionPathHint,
  sessionStateDir,
} from "../lib/session-paths";

const PROJECT = "/tmp/mcp-session-paths-project";

describe("engine session-path helpers match the layout this package used to hardcode", () => {
  it("puts the ready contract exactly where the literals put it", () => {
    for (const browser of ["chrome", "chromium", "edge", "firefox"]) {
      expect(readyContractPath(PROJECT, browser)).toBe(
        path.resolve(PROJECT, "dist", "extension-js", browser, "ready.json"),
      );
    }
  });

  it("puts logs.ndjson exactly where the literals put it", () => {
    expect(logsPath(PROJECT, "chrome")).toBe(
      path.resolve(PROJECT, "dist", "extension-js", "chrome", "logs.ndjson"),
    );
  });

  it("puts build-summary.json exactly where the literals put it", () => {
    expect(buildSummaryPath(PROJECT, "chrome")).toBe(
      path.resolve(
        PROJECT,
        "dist",
        "extension-js",
        "chrome",
        "build-summary.json",
      ),
    );
  });

  it("roots the per-browser scan exactly where the literals rooted it", () => {
    expect(sessionArtifactsRootDir(PROJECT)).toBe(
      path.resolve(PROJECT, "dist", "extension-js"),
    );
    expect(browserArtifactsDir(PROJECT, "chrome")).toBe(
      path.resolve(PROJECT, "dist", "extension-js", "chrome"),
    );
  });

  it("keeps every artifact inside the per-browser directory", () => {
    const dir = browserArtifactsDir(PROJECT, "chrome");
    for (const file of [
      readyContractPath(PROJECT, "chrome"),
      logsPath(PROJECT, "chrome"),
      eventsPath(PROJECT, "chrome"),
      actionsPath(PROJECT, "chrome"),
      buildSummaryPath(PROJECT, "chrome"),
    ]) {
      expect(path.dirname(file)).toBe(dir);
    }
  });

  it("keeps the dist-surviving state root separate from the dist-scoped one", () => {
    expect(sessionStateDir(PROJECT)).toBe(path.resolve(PROJECT, ".extension-js"));
    expect(sessionStateDir(PROJECT)).not.toBe(sessionArtifactsRootDir(PROJECT));
  });

  it("keys every artifact by browser, so two browsers never share a slot", () => {
    expect(readyContractPath(PROJECT, "chrome")).not.toBe(
      readyContractPath(PROJECT, "firefox"),
    );
    expect(logsPath(PROJECT, "chrome")).not.toBe(logsPath(PROJECT, "firefox"));
  });
});

describe("sessionPathHint", () => {
  it("names the absolute path so a layout mismatch is not silent", () => {
    const file = readyContractPath(PROJECT, "chrome");
    const hint = sessionPathHint(file);
    expect(hint).toContain(file);
    expect(hint).toMatch(/older Extension\.js/);
  });
});
