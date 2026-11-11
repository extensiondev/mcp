// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { describe, expect, it } from "vitest";

import { startAnswer, type StartFacts } from "../lib/start-answer";
import { firstLogsRecoveryNote } from "../tools/dev";

function facts(overrides: Partial<StartFacts> = {}): StartFacts {
  return {
    command: "extension_start",
    verb: "start",
    projectPath: "/tmp/lance",
    browser: "chrome",
    pid: 4242,
    noBrowser: false,
    profileReused: false,
    headless: false,
    idleMinutes: null,
    allowControl: true,
    allowEval: false,
    controlPort: 53605,
    controlledCopy: "/tmp/lance/dist/extension-js/chrome/controlled",
    identity: {},
    launch: { browserPid: 777, browserAlive: true, extensionLoaded: true, loadEvidence: "the target list names it." },
    contract: null,
    replacedSession: undefined,
    warnings: [],
    landing: null,
    engineExit: null,
    ...overrides,
  };
}

describe("ledger 396: extension_start says its copy is fixed and sends a watched window to extension_dev", () => {
  it("a headful controlled session says a rebuild needs replace and that extension_dev reloads in place", () => {
    const hint = String(JSON.parse(startAnswer(facts())).hint);

    expect(hint).toContain("never reads a rebuilt build folder");
    expect(hint).toContain("use extension_dev instead");
  });

  it("a headless session keeps the copy line and leaves out the watched window line", () => {
    const hint = String(JSON.parse(startAnswer(facts({ headless: true }))).hint);

    expect(hint).toContain("never reads a rebuilt build folder");
    expect(hint).not.toContain("use extension_dev instead");
  });
});

describe("ledger 515: extension_start names the idle time a session the agent owns ends at", () => {
  it("a session with an idle limit carries it in the value and the hint", () => {
    const answer = JSON.parse(startAnswer(facts({ headless: true, idleMinutes: 30 })));

    expect(answer.value.idleMinutes).toBe(30);
    expect(String(answer.hint)).toContain("ends itself after 30 minutes");
  });

  it("a session without one says null and nothing about ending itself", () => {
    const answer = JSON.parse(startAnswer(facts()));

    expect(answer.value.idleMinutes).toBeNull();
    expect(String(answer.hint)).not.toContain("ends itself");
  });
});

describe("ledger 397: extension_dev says firstLogs holds lines from before a recovery reload", () => {
  it("names the reload time when the executor recovery attached", () => {
    expect(firstLogsRecoveryNote({ executorRecovery: { outcome: "attached", reloadedAt: "2026-11-04T22:00:00.000Z" } })).toContain("2026-11-04T22:00:00.000Z");
  });

  it("says nothing without a recovery", () => {
    expect(firstLogsRecoveryNote({})).toBeNull();
    expect(firstLogsRecoveryNote({ executorRecovery: { outcome: "not-attached", reloadedAt: "x" } })).toBeNull();
  });
});
