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

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { handler } from "../tools/wait";
import {
  registerSession,
  removeSession,
  removeSessionMarker,
} from "../lib/process-manager";
import {
  NO_ATTACH_DIAGNOSIS_NOTE,
  freshProfilePath,
} from "../lib/compiled-not-attached";
import { browserProfileRootDir } from "../lib/session-paths";
import {
  writeCompiledUnattachedContract,
  writeModernContract,
} from "./fixtures/ready-contract";

const PROFILE = "/tmp/pii-shield/dist/extension-profile-chrome";
const HINT =
  "Chrome (pid 66462) is up, but the extension has not connected after 15 s.\n" +
  `Profile ${PROFILE} had been run before: a profile picker, a restore prompt or a stale copy of the extension in it can keep the extension from connecting.\n` +
  'Dismiss any dialog there, or stop this session and run again on a fresh profile (delete that folder, or pass --profile <new path>). The session keeps waiting and says "ready" once the extension connects.';

function stamp(dir: string, browser = "chrome"): void {
  writeCompiledUnattachedContract(dir, browser, {
    pid: process.pid,
    browserPid: 66462,
    profilePath: PROFILE,
    profileReused: true,
    browserUpNotAttachedAt: "2026-10-24T01:39:15.000Z",
    browserUpNotAttachedWaitMs: 15_000,
    browserUpNotAttachedHint: HINT,
  });
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-wait-not-attached-"));
});

afterEach(() => {
  vi.useRealTimers();

  for (const browser of ["chrome", "safari"]) {
    removeSession(dir, browser);
    removeSessionMarker(dir, browser);
  }

  fs.rmSync(dir, { recursive: true, force: true });
});

describe("extension_wait answers the engine's own attach diagnosis as soon as ready.json carries it", () => {
  it("returns on the first poll with the hint verbatim, the profile facts and the fresh-profile relaunch, spending none of the budget", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    registerSession({ pid: process.pid, browser: "chrome", projectPath: dir, command: "dev" });
    stamp(dir);

    const result = JSON.parse(await handler({ projectPath: dir, browser: "chrome" }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("compiled-not-attached");
    expect(result.error.code).toBe("E_NOT_ATTACHED");
    expect(result.value.budgetMs).toBe(45_000);
    expect(result.value.elapsedMs).toBe(0);
    expect(result.value).toMatchObject({
      compiled: true,
      browserAttached: false,
      browserUpNotAttachedHint: HINT,
      browserUpNotAttachedAt: "2026-10-24T01:39:15.000Z",
      profilePath: PROFILE,
      profileReused: true,
      browserPid: 66462,
      waitedMs: 15_000,
    });

    expect(result.value.nextStep.tool).toBe("extension_dev");
    expect(result.value.nextStep.args).toMatchObject({ projectPath: dir, browser: "chrome", replace: true });
    expect(result.value.nextStep.args.profile).toMatch(new RegExp(`^${PROFILE}-fresh-\\d{12}$`));
    expect(result.value.sayToPerson.startsWith(HINT)).toBe(true);
    expect(result.value.sayToPerson).toContain("replace: true and profile:");
    expect(result.hint.startsWith(HINT)).toBe(true);
    expect(result.error.message).toContain(HINT);
  });

  it("keeps the budget-long answer for an engine that stamps no diagnosis, and says so in the message", async () => {
    registerSession({ pid: process.pid, browser: "chrome", projectPath: dir, command: "dev" });
    writeCompiledUnattachedContract(dir, "chrome", { pid: process.pid });

    const result = JSON.parse(await handler({ projectPath: dir, browser: "chrome", timeoutMs: 1500 }));

    expect(result.status).toBe("compiled-not-attached");
    expect(result.error.code).toBe("E_NOT_ATTACHED");
    expect(result.value.elapsedMs).toBeGreaterThanOrEqual(1500);
    expect(result.error.message).toContain(NO_ATTACH_DIAGNOSIS_NOTE);
    expect(result.hint).toContain("This is usually transient: call extension_wait again");
    expect(result.value.browserUpNotAttachedHint).toBeUndefined();
    expect(result.value.nextStep).toBeUndefined();
  }, 10_000);

  it("leaves the Safari not-enabled answer without the engine-update sentence, since Safari's cause is already named", async () => {
    registerSession({ pid: process.pid, browser: "safari", projectPath: dir, command: "dev" });
    writeCompiledUnattachedContract(dir, "safari", { pid: process.pid });

    const result = JSON.parse(await handler({ projectPath: dir, browser: "safari", timeoutMs: 1500 }));

    expect(result.status).toBe("compiled-not-attached");
    expect(result.error.message).not.toContain(NO_ATTACH_DIAGNOSIS_NOTE);
    expect(result.hint).toContain("The extension is not enabled in Safari yet");
  }, 10_000);

  it("answers ready once the first attach clears the three fields on the same contract", async () => {
    registerSession({ pid: process.pid, browser: "chrome", projectPath: dir, command: "dev" });
    stamp(dir);

    const early = JSON.parse(await handler({ projectPath: dir, browser: "chrome", timeoutMs: 1500 }));

    expect(early.status).toBe("compiled-not-attached");

    writeModernContract(dir, "chrome", { pid: process.pid, browserPid: 66462, profilePath: PROFILE, profileReused: true });

    const later = JSON.parse(await handler({ projectPath: dir, browser: "chrome", timeoutMs: 1500 }));

    expect(later.ok).toBe(true);
    expect(later.status).toBe("ready");
    expect(later.value.browserAttached).toBe(true);
    expect(later.value.browserUpNotAttachedHint).toBeUndefined();
    expect(later.value.nextStep).toBeUndefined();
  }, 10_000);
});

describe("the fresh profile path is a sibling of the one the engine named", () => {
  const now = new Date(2026, 9, 24, 1, 39);

  it("appends -fresh-<yyyymmddhhmm> to the profile the contract carries, trailing slash dropped", () => {
    expect(freshProfilePath({ profilePath: PROFILE, projectPath: "/p", browser: "chrome", now })).toBe(`${PROFILE}-fresh-202610240139`);
    expect(freshProfilePath({ profilePath: `${PROFILE}/`, projectPath: "/p", browser: "chrome", now })).toBe(`${PROFILE}-fresh-202610240139`);
  });

  it("falls back to a fresh directory under the managed profile root when the contract names no profile", () => {
    expect(freshProfilePath({ profilePath: null, projectPath: "/p", browser: "chrome", now })).toBe(
      path.join(browserProfileRootDir("/p", "chrome"), "fresh-202610240139"),
    );
  });
});
