// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { describe, expect, it } from "vitest";

import { listingPushOpen, listingPushView } from "../lib/safari-listing-push-read";
import { pushSentence, readPushState, sendListing } from "../lib/store-listing-push";
import { usePlatformWorld, WORLD_API, WORLD_PROJECT_ID } from "./fixtures/platform-world";

const LOCKED_MESSAGE =
  "The App Store listing is locked while Apple reviews 0.3.0 (WAITING_FOR_REVIEW); push the listing again once that version is editable.";
const LOCKED = {
  status: "locked",
  runState: "locked",
  dispatched: false,
  dispatchedAt: "2026-11-02T12:00:00.000Z",
  lockedVersion: "0.3.0",
  lockedState: "WAITING_FOR_REVIEW",
  outcome: "locked",
  message: LOCKED_MESSAGE,
};
const RETRY = /sync-listing|sends it again|again\.$/;
const UNANSWERED = {
  status: "unchanged",
  runState: "unanswered",
  dispatched: false,
  dispatchedAt: "2026-11-13T12:00:00.000Z",
  message: "The push dispatched at 12:00 could not be read because the build lane did not answer.",
};
const UNANSWERED_LINE =
  "The build lane did not answer for the recorded App Store Connect push, so nothing was sent again; say preflight in a minute and I read it again.";

describe("a locked App Store listing reads as locked, never as a push to retry", () => {
  it("reads the lock, its version and state, and says the platform's own sentence with no resend", () => {
    const state = readPushState(LOCKED)!;

    expect(state).toMatchObject({ status: "locked", runState: "locked", lockedVersion: "0.3.0", lockedState: "WAITING_FOR_REVIEW" });
    expect(pushSentence(state, "none")).toBe(LOCKED_MESSAGE);
    expect(pushSentence(state, "none")).not.toContain("sync-listing");
  });

  it("builds the sentence from the version and state when the platform gives no message", () => {
    const { message: _message, ...bare } = LOCKED;
    const said = pushSentence(readPushState(bare)!, "none");
    const view = listingPushView(readPushState({ ...bare, landedAt: "2026-10-30T10:00:00.000Z" })!);

    expect(said).toContain("0.3.0 (WAITING_FOR_REVIEW)");
    expect(said).not.toContain("sync-listing");
    expect(view).toMatchObject({ state: "locked", lockedVersion: "0.3.0", lockedState: "WAITING_FOR_REVIEW" });
    expect(view.say).toContain("Apple still holds the listing that landed October 30, 2026");
    expect(view.say).not.toMatch(RETRY);
    expect(listingPushOpen(view)).toBe(false);
  });

  it("a failed attempt over a landed listing says the landing Apple still holds", () => {
    const raw = {
      status: "failed",
      runState: "failed",
      dispatchedAt: "2026-11-02T12:00:00.000Z",
      landedAt: "2026-10-30T10:00:00.000Z",
      failedReason: "App Store Connect took none of the listing: subtitle (The subtitle is too long)",
      owed: [{ field: "subtitle", reason: "The subtitle is too long" }],
      retryHint: 'extension_submit (action: "sync-listing", browsers: ["safari"])',
    };
    const state = readPushState(raw)!;
    const view = listingPushView(state);

    expect(pushSentence(state, "none")).toContain("Apple still holds the listing that landed October 30, 2026");
    expect(view.say).toContain("Apple still holds the listing that landed October 30, 2026");
    expect(view.say).toContain("Apple refused subtitle (The subtitle is too long)");
    expect(view.say).not.toContain("Nothing reached App Store Connect");
    expect(view.owed).toEqual([{ field: "subtitle", reason: "The subtitle is too long" }]);
  });

  it("a push Apple refused field by field never says nothing reached App Store Connect", () => {
    const view = listingPushView(
      readPushState({ status: "failed", runState: "failed", owed: [{ field: "keywords", reason: "Keywords are longer than 100 characters." }] })!,
    );

    expect(view.say).toContain("Apple refused keywords (Keywords are longer than 100 characters)");
    expect(view.say).not.toContain("Nothing reached App Store Connect");
  });
});

const world = usePlatformWorld("extdev-listing-locked-");
const LISTING = new RegExp(`^GET /api/projects/${WORLD_PROJECT_ID}/stores/safari/listing$`);
const LISTING_PUT = new RegExp(`^PUT /api/projects/${WORLD_PROJECT_ID}/stores/safari/listing$`);

describe("a listing push the build lane did not answer for is named, never read as unchanged", () => {
  it("keeps the unanswered run state and says nothing was sent again", () => {
    const state = readPushState(UNANSWERED)!;

    expect(state).toMatchObject({ status: "unchanged", runState: "unanswered" });
    expect(pushSentence(state, "none")).toBe(UNANSWERED_LINE);
  });

  it("the release status read names the lane and offers no resend", () => {
    const view = listingPushView(readPushState(UNANSWERED)!);

    expect(view.state).toBe("unanswered");
    expect(view.say).toContain("the build lane did not answer");
    expect(view.say).toContain("nothing was sent again");
    expect(view.say).not.toMatch(RETRY);
    expect(listingPushOpen(view)).toBe(false);
  });

  it("sync-listing sends the unchanged listing once and never forces it again", async () => {
    world.routes.push([LISTING_PUT, () => ({ body: { store: "safari", appStoreConnect: UNANSWERED } })]);
    const api = { base: WORLD_API, token: "t", projectId: WORLD_PROJECT_ID, ref: { workspace: "w", project: "p" }, command: "extension_submit" } as any;
    const { resend } = await sendListing(api, "safari", { title: "Cat" });

    expect(resend).toBe("none");
    expect(world.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  });
});

const safariRow = (out: any) => (out.value.stores.value.stores as Array<Record<string, any>>).find((row) => row.store === "safari");

describe("the store reads tell a locked listing push without a warning or a retry", () => {
  it("extension_release_status carries the lock and says the platform's sentence, with no warning", async () => {
    world.login();
    world.routes.push([LISTING, () => ({ body: { store: "safari", listing: {}, media: {}, appStoreConnect: LOCKED } })]);
    const out = await world.call("extension_release_status", { include: ["stores"], api: WORLD_API });

    expect(safariRow(out)?.listingPush).toMatchObject({ state: "locked", lockedVersion: "0.3.0", lockedState: "WAITING_FOR_REVIEW" });
    expect(out.value.stores.hint).toContain(LOCKED_MESSAGE.slice(1, -1));
    expect(out.value.stores.hint).not.toContain("sends it again");
    expect(JSON.stringify(out.warnings ?? [])).not.toContain("listing");
  });

  it("the submit status action reads the same lock", async () => {
    world.login();
    world.routes.push([LISTING, () => ({ body: { store: "safari", listing: {}, media: {}, appStoreConnect: LOCKED } })]);
    const out = await world.call("extension_submit_check", { action: "status", browsers: ["safari"], api: WORLD_API });
    const safari = (out.value.stores as Array<Record<string, any>>)[0];

    expect(safari.listingPush).toMatchObject({ state: "locked", lockedVersion: "0.3.0" });
    expect(out.hint).toContain(LOCKED_MESSAGE.slice(1, -1));
    expect(JSON.stringify(out.warnings ?? [])).not.toContain("listing");
  });
});
