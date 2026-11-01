// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { describe, expect, it } from "vitest";

import { usePlatformWorld, WORLD_API, WORLD_PROJECT_ID } from "./fixtures/platform-world";

const world = usePlatformWorld("extdev-listing-push-");
const api = { api: WORLD_API };
const STEP = "Push the listing to App Store Connect";
const ERROR = "App Store Connect answered 409 ENTITY_ERROR.ATTRIBUTE.INVALID: keywords is longer than 100 characters";
const LISTING = new RegExp(`^GET /api/projects/${WORLD_PROJECT_ID}/stores/safari/listing$`);

function listingAnswers(appStoreConnect: Record<string, unknown>): void {
  world.routes.push([LISTING, () => ({ body: { store: "safari", listing: {}, media: {}, appStoreConnect } })]);
}

const FAILED = {
  status: "failed",
  runState: "failed",
  dispatched: false,
  dispatchedAt: "2026-11-01T00:32:21.570Z",
  failedStep: STEP,
  failedReason: ERROR,
  message: `The push dispatched at 2026-11-01T00:32:21Z failed at step "${STEP}" (${ERROR}), so nothing reached App Store Connect.`,
  retryHint: 'extension_submit (action: "sync-listing", browsers: ["safari"])',
};

const safariRow = (out: any) => (out.value.stores.value.stores as Array<Record<string, any>>).find((row) => row.store === "safari");

describe("a failed Safari listing push surfaces on the next store read (ledger 363)", () => {
  it("extension_release_status carries the push, its failed step and that step's own error, and warns", async () => {
    world.login();
    listingAnswers(FAILED);
    const out = await world.call("extension_release_status", { include: ["stores"], ...api });
    const push = safariRow(out)?.listingPush;

    expect(push).toMatchObject({ state: "failed", failedStep: STEP, failedReason: ERROR, dispatchedAt: "2026-11-01T00:32:21.570Z" });
    expect(out.value.stores.hint).toContain(`failed at step "${STEP}": ${ERROR}`);
    expect(out.warnings.join(" ")).toContain(`failed at step "${STEP}": ${ERROR}`);
    expect(out.warnings.join(" ")).toContain("Nothing reached App Store Connect");
    expect(world.calls.find((call) => LISTING.test(`${call.method} ${call.path}`))?.url).toContain("push=1");
  });

  it("the submit status action reads the same push from the same source", async () => {
    world.login();
    listingAnswers(FAILED);
    const out = await world.call("extension_submit_check", { action: "status", browsers: ["safari"], ...api });
    const safari = (out.value.stores as Array<Record<string, any>>)[0];

    expect(safari.listingPush).toMatchObject({ state: "failed", failedStep: STEP, failedReason: ERROR });
    expect(out.hint).toContain(ERROR);
    expect(out.warnings.join(" ")).toContain(STEP);
  });

  it("a landed push is told as landed and raises no warning", async () => {
    world.login();
    listingAnswers({ status: "landed", runState: "landed", dispatchedAt: "2026-11-01T00:32:21.570Z", landedAt: "2026-11-01T00:40:00.000Z", message: "landed", retryHint: "" });
    const out = await world.call("extension_release_status", { include: ["stores"], ...api });

    expect(safariRow(out)?.listingPush).toMatchObject({ state: "landed" });
    expect(out.value.stores.hint).toContain("landed on App Store Connect");
    expect(JSON.stringify(out.warnings ?? [])).not.toContain("Safari listing push");
  });
});
