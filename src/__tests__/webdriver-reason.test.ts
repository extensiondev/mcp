import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  readWebDriverSession,
  readWebDriverUnavailableReason,
  webdriverSessionMissingHint,
} from "../lib/webdriver";
import { readyContractPath } from "../lib/session-paths";
import { safariDevContract } from "./fixtures/engine-answers";

const dirs: string[] = [];

function projectWith(contract: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-webdriver-reason-"));
  dirs.push(dir);
  const file = readyContractPath(dir, "safari");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(contract));

  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/* @invariant Extension.js 4.1.32 opens the Safari session the client side was
   built for. These cells read contracts in
   the shape that release writes, and pin that the hint no longer says no
   release opens one. */
describe("The Safari session the engine now stamps", () => {
  it("reads the session from a contract shaped as the engine writes it", () => {
    const dir = projectWith(safariDevContract({ port: 61234, sessionId: "E3A9-webdriver-writer" }));
    expect(readWebDriverSession(dir, "safari")).toEqual({ port: 61234, sessionId: "E3A9-webdriver-writer" });
    expect(readWebDriverUnavailableReason(dir, "safari")).toBeNull();
  });

  it("reads the engine's reason when it opened no session", () => {
    const dir = projectWith(safariDevContract({ unavailableReason: "safaridriver --enable was not run" }));
    expect(readWebDriverSession(dir, "safari")).toBeNull();
    expect(readWebDriverUnavailableReason(dir, "safari")).toBe("safaridriver --enable was not run");
  });

  it("relays the reason in the hint and no longer says no release opens a session", () => {
    const withReason = webdriverSessionMissingHint("Allow Remote Automation is off");
    expect(withReason).toContain("Allow Remote Automation is off");
    expect(withReason).toContain("extension_dev --browser=safari");
    const without = webdriverSessionMissingHint(null);
    expect(without).toContain("4.1.32");

    for (const hint of [withReason, without]) {
      expect(hint).not.toMatch(/no Extension\.js release opens one/i);
      expect(hint).toContain("extension_logs");
    }
  });
});
