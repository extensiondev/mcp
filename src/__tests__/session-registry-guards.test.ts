import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findSessionInfo,
  getSession,
  listSessionMarkers,
  registerSession,
  removeSession,
  removeSessionMarker,
  sessionSinceMs,
} from "../lib/process-manager";

const tmpDirs: string[] = [];
function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-registry-guard-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    removeSession(dir, "chrome");
    removeSessionMarker(dir, "chrome");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("pid-guarded removal after replace", () => {
  it("a stale exit handler cannot remove the successor session", () => {
    const project = tmpProject();
    registerSession({ pid: 111, browser: "chrome", projectPath: project, command: "dev" });
    registerSession({ pid: 222, browser: "chrome", projectPath: project, command: "dev" });

    removeSession(project, "chrome", 111);

    expect(getSession(project, "chrome")?.pid).toBe(222);
  });

  it("a matching pid still removes the session", () => {
    const project = tmpProject();
    registerSession({ pid: 333, browser: "chrome", projectPath: project, command: "dev" });

    removeSession(project, "chrome", 333);

    expect(getSession(project, "chrome")).toBeUndefined();
  });

  it("a stale exit handler cannot delete the successor's marker", () => {
    const project = tmpProject();
    registerSession({ pid: 111, browser: "chrome", projectPath: project, command: "dev" });
    registerSession({ pid: 222, browser: "chrome", projectPath: project, command: "dev" });

    removeSessionMarker(project, "chrome", 111);

    const marker = listSessionMarkers().find(
      (m) => path.resolve(m.projectPath) === path.resolve(project),
    );
    expect(marker?.pid).toBe(222);

    removeSessionMarker(project, "chrome", 222);
    expect(
      listSessionMarkers().some(
        (m) => path.resolve(m.projectPath) === path.resolve(project),
      ),
    ).toBe(false);
  });
});

describe("sessionSinceMs", () => {
  it("keeps the original registration time across a same-pid re-register", async () => {
    const project = tmpProject();
    registerSession({ pid: 444, browser: "chrome", projectPath: project, command: "dev" });
    const first = sessionSinceMs(project, "chrome");
    await new Promise((r) => setTimeout(r, 20));
    registerSession({
      pid: 444,
      browser: "chrome",
      projectPath: project,
      command: "dev",
      port: 8081,
    });

    expect(sessionSinceMs(project, "chrome")).toBe(first);
  });

  it("advances when a new pid takes the slot", async () => {
    const project = tmpProject();
    registerSession({ pid: 444, browser: "chrome", projectPath: project, command: "dev" });
    const first = sessionSinceMs(project, "chrome")!;
    await new Promise((r) => setTimeout(r, 20));
    registerSession({ pid: 555, browser: "chrome", projectPath: project, command: "dev" });

    expect(sessionSinceMs(project, "chrome")!).toBeGreaterThan(first);
  });

  it("survives registry amnesia through the on-disk marker", () => {
    const project = tmpProject();
    registerSession({ pid: 666, browser: "chrome", projectPath: project, command: "dev" });
    const inMemory = sessionSinceMs(project, "chrome")!;
    removeSession(project, "chrome");

    expect(findSessionInfo(project, "chrome")?.pid).toBe(666);
    const fromMarker = sessionSinceMs(project, "chrome")!;
    expect(Math.abs(fromMarker - inMemory)).toBeLessThan(1000);
  });

  it("is null when nothing is known", () => {
    expect(sessionSinceMs(tmpProject(), "chrome")).toBeNull();
  });
});
