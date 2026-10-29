// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { describe, expect, it } from "vitest";

import { WORLD_API, WORLD_PROJECT_ID, usePlatformWorld, type World } from "./fixtures/platform-world";

const PREFLIGHT = new RegExp(`^POST /api/projects/${WORLD_PROJECT_ID}/stores/firefox/submissions/preflight$`);
const SUBMIT = /^POST \/api\/cli\/stores\/submit$/;
const LANDING =
  "The next upload lands in AMO's unlisted channel as version 0.2.0.8; 0.2.0.7, awaiting review, stays in AMO's queue untouched, since AMO retires only versions of the same channel.";
const DRY_RUN = { action: "submit", browsers: ["firefox"], buildSha: "069d4b8", dryRun: true, api: WORLD_API };

function firefoxPreflight(world: World, withMode = true): void {
  world.routes.push([
    PREFLIGHT,
    () => ({
      body: {
        store: "firefox",
        summary: { pass: 9, warn: 0, fail: 0, canSubmit: true },
        checks: [],
        connection: { kind: "api-key", connectedAs: "rebeccat@example.com", healthy: true, itemId: "rebeccat@extension.dev", itemLinked: true },
        ...(withMode
          ? { submissionMode: { id: "unlisted", label: "Unlisted", description: "Firefox versions will upload to the unlisted channel for limited distribution." } }
          : {}),
        firefoxPreflight: {
          act: "upload",
          checks: [],
          blocking: [],
          warnings: [],
          lock: null,
          inFlight: { version: "0.2.0.7", status: "submitted", storeState: "unreviewed", readAt: "2026-10-29T12:00:00.000Z" },
          approval: "Upload sends build 069d4b8 as version 0.2.0.8 to AMO's unlisted channel.",
          nextVersion: "0.2.0.8",
          channel: "unlisted",
          retires: [],
          untouched: ["0.2.0.7"],
          landing: LANDING,
        },
      },
    }),
  ]);

  world.routes.push([
    SUBMIT,
    () => ({ body: { ok: true, dryRun: true, buildId: "069d4b8", message: "Preflight OK for firefox." } }),
  ]);
}

describe("a dry-run submit names the saved mode and the version the next upload carries", () => {
  const world = usePlatformWorld("extdev-dry-run-mode-version-");

  it("reads the mode and the next version from the preflight an owner's token reads, never calling the mode unreadable", async () => {
    if (process.platform === "win32") return;

    world.login();
    firefoxPreflight(world);

    const out = await world.call("extension_submit", DRY_RUN);
    const said = JSON.stringify(out);

    expect(out.ok, said).toBe(true);
    expect(out.value.preflight[0]).toMatchObject({ browser: "firefox", publishMode: "unlisted", nextVersion: "0.2.0.8", landing: LANDING });
    expect(out.value.nextVersions).toEqual({ firefox: "0.2.0.8" });
    expect(out.hint).toContain("Saved submission mode: firefox unlisted.");
    expect(out.hint).toContain(`firefox: ${LANDING}`);
    expect(said).not.toContain("not readable with this token");
  });

  it("names the store whose mode the preflight did not answer instead of blaming the token", async () => {
    if (process.platform === "win32") return;

    world.login();
    firefoxPreflight(world, false);

    const out = await world.call("extension_submit", DRY_RUN);
    const said = JSON.stringify(out);

    expect(out.value.preflight[0].publishMode).toBe("not checked");
    expect(said).toContain("The platform's preflight did not answer the submission mode of firefox");
    expect(said).not.toContain("not readable with this token");
  });

  it("answers the preflight with each store's next version beside its lock, and says it", async () => {
    if (process.platform === "win32") return;

    world.login();
    firefoxPreflight(world);

    const out = await world.call("extension_submit", { action: "preflight", browsers: ["firefox"], api: WORLD_API });

    expect(out.value.storePreflight.firefox).toMatchObject({ nextVersion: "0.2.0.8", channel: "unlisted", retires: [], untouched: ["0.2.0.7"], landing: LANDING });
    expect(out.hint).toContain(`firefox: ${LANDING}`);
  });
});
