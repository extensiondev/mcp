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

import type * as ExecModule from "../lib/exec";

let spawns = 0;

vi.mock("../lib/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof ExecModule>();

  return {
    ...actual,
    spawnExtensionCli: () => {
      spawns += 1;

      throw new Error("the preflight should have refused before any spawn");
    },
  };
});

const dev = await import("../tools/dev");
const { xcodeTeamsReader } = await import("../lib/xcode-teams");
const { adHocDespiteTeamWarning } = await import("../lib/safari-signing");

const stubbedTeams = xcodeTeamsReader.read;
const tmpDirs: string[] = [];

function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-dev-safari-team-"));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "manifest.json"), JSON.stringify({ name: "Rebeccat", version: "0.3.0" }));

  return dir;
}

afterEach(() => {
  spawns = 0;
  xcodeTeamsReader.read = stubbedTeams;

  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("extension_dev refuses a team Xcode has no account for before the Safari start (ledger 347)", () => {
  it("answers team-unknown-to-xcode and starts nothing", async () => {
    xcodeTeamsReader.read = async () => [];

    const result = JSON.parse(
      await dev.handler({ projectPath: project(), browser: "safari", developmentTeam: "JU3XAJJQ2G", enableExtension: true }),
    );

    expect(result.status).toBe("team-unknown-to-xcode");
    expect(result.error.message).toContain("Xcode lists no team at all");
    expect(result.error.message).toContain("Nothing was started");
    expect(result.value.knownTeams).toEqual([]);
    expect(spawns).toBe(0);
  });

  it("says the fallback is fell-back-to-ad-hoc and that the enable step then needs the unsigned toggle", () => {
    const warning = adHocDespiteTeamWarning("JU3XAJJQ2G", "");

    expect(warning).toContain("signing.status is fell-back-to-ad-hoc");
    expect(warning).toContain("Allow unsigned extensions");
    expect(warning).toContain("after each Safari launch");
  });
});
