// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { describe, expect, it } from "vitest";

import {
  GUEST_ID,
  STATIC_MANIFEST,
  assertOnce,
  live,
  liveSession,
  usePageWorldProject,
  writeManifest,
} from "./assert-page-world-harness";

const { schema } = await import("../tools/assert");
const { SESSION_PROJECT_PATH } = await import("../lib/common-schema");
const { schema: doctorSchema } = await import("../tools/doctor");

usePageWorldProject();

describe("the extension_assert description names both session kinds and which checks each one serves", () => {
  it("runs on extension_dev and extension_start sessions, never only a live dev session", () => {
    expect(schema.description).toMatch(/^Run a test stage on an extension_dev or extension_start session/);
    expect(schema.description).not.toMatch(/live dev session/);
    expect(schema.description).not.toMatch(/Start the session with extension_dev/);
  });

  it("names the debug-port checks as meant for the production build, the control-channel check, and the dev-only log readers", () => {
    expect(schema.description).toMatch(
      /page-world-clean, no-outside-requests and background-worker-booted read the debug port: meant for the production build \(extension_start, allowControl:true\)/,
    );

    expect(schema.description).toMatch(/storage-key-present needs the control channel/);
    expect(schema.description).toMatch(/content-script-injected and console-errors-empty read the dev log stream: extension_dev only/);
  });

  it("names not ready beside inconclusive, as a precondition rather than a platform limit", () => {
    expect(schema.description).toMatch(/not ready \(a precondition; see settledBy\) or inconclusive \(a platform limit\)/);
    expect(schema.description).not.toMatch(/cannot cover the question today/);
  });

  it("keeps the shared projectPath and doctor wording off a dev-only session", () => {
    expect(SESSION_PROJECT_PATH.description).toBe("Extension project root (needs a running session: extension_dev or extension_start)");
    expect(JSON.stringify(doctorSchema)).not.toMatch(/live dev session/);
  });

  it("settles a missing session with either session kind, naming extension_start with allowControl for the production build", async () => {
    writeManifest(STATIC_MANIFEST);
    liveSession("start");
    live.port = null;
    live.targets = [{ id: "sw", type: "service_worker", url: `chrome-extension://${GUEST_ID}/sw.js` }];

    const { check } = await assertOnce({ assert: "no-outside-requests" });

    expect(check.outcome).toBe("inconclusive");
    expect(check.detail).toMatch(/^No session with a debugging port was found for chrome/);
    expect(check.detail).not.toMatch(/dev session/);
    expect(check.settledBy).toBe(
      "Start the session with extension_dev, or extension_start with allowControl: true for the production build, then assert again.",
    );
  });
});
