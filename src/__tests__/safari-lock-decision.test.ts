// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { lockSentences, nextVersionSentences, safariLockSentences } from "../tools/store-acts";
import { handler as submit } from "../tools/submit";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

type Row = Record<string, any>;

const PREFLIGHT = (store: string) => `${PROJECT_ROUTE}/stores/${store}/submissions/preflight`;
const STORES = ["chrome", "firefox", "edge", "safari"] as const;
const WALK: Record<string, Row> = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/preflight-four-stores.json", import.meta.url)), "utf8"));
const NOW = Date.parse("2026-11-05T22:00:45.000Z");
const READ_AT = "2026-11-05T18:00:45.000Z";

function safariBlock(releaseType: string, readAt = READ_AT): Row {
  return {
    act: "upload",
    blocking: ["store.safari_app_review_lock"],
    warnings: [],
    checks: [],
    approval: "Send App Store version 0.3.0 with TestFlight build 18 to Apple's App Review.",
    lock: { kind: "review-in-progress", storeWord: "WAITING_FOR_REVIEW", clearsWhen: "Apple finishes reviewing 0.3.0 (build 18)", readAt },
    release: { type: releaseType, readAt },
    nextVersion: "0.3.0",
  };
}

const EDGE_LOCKED: Row = {
  act: "publish",
  lock: { kind: "review-in-progress", storeWord: "InProgressSubmission", clearsWhen: "Microsoft finishes certifying 0.2.0.7", readAt: READ_AT },
};

describe("414: a Safari lock is answered as the owner's decision, with what Apple's approval does and both ways out", () => {
  it("names the version and build in review, the sale on approval, both ways out, when the lock clears and the age of a stale read", () => {
    const said = safariLockSentences(safariBlock("AFTER_APPROVAL"), NOW);

    expect(said).toContain("safari: version 0.3.0 (build 18) is waiting for Apple (WAITING_FOR_REVIEW) and goes on sale the moment Apple approves it, which cannot be taken back from here.");
    expect(said).toContain("Either let Apple finish and send the new build as 0.3.1 or higher afterward, since App Store Connect takes no new build on a version it has released, or withdraw it now with extension_submit {action: \"cancel\", store: \"safari\"} and send the new build as 0.3.0.");
    expect(said).toContain("The lock clears when Apple finishes reviewing 0.3.0 (build 18).");
    expect(said).toContain(`App Store Connect answered this 4 hours ago (${READ_AT}); extension_submit_check {action: "status", browsers: ["safari"], waitSeconds: 60} reads it fresh.`);
    expect(said).not.toContain("never failed");
    expect(said).not.toContain("queued behind");
  });

  it("566: names the withdrawal with the id of the submission in review when the platform gives it", () => {
    const said = safariLockSentences({ ...safariBlock("AFTER_APPROVAL"), heldSubmissionId: "d725c641-0957-4766-bb79-8443e8a58eab" }, NOW);

    expect(said).toContain('withdraw it now with extension_submit {action: "cancel", store: "safari", submissionId: "d725c641-0957-4766-bb79-8443e8a58eab"} and send the new build as 0.3.0.');
  });

  it("567: names App Store Connect's Remove from Review, never a cancel call, while the platform cannot run the withdrawal", () => {
    const block = safariBlock("AFTER_APPROVAL");
    const said = safariLockSentences({ ...block, heldSubmissionId: "d725c641", lock: { ...block.lock, withdrawOnPlatform: false } }, NOW);

    expect(said).toContain('or withdraw it now by hand with "Remove from Review" in App Store Connect, since the platform cannot run that withdrawal yet, and send the new build as 0.3.0.');
    expect(said).toContain("The lock clears when the version leaves App Review.");
    expect(said).not.toContain('action: "cancel"');
  });

  it("says a manual release stays held and says no age for a read under an hour old", () => {
    const said = safariLockSentences(safariBlock("MANUAL", "2026-11-05T21:30:00.000Z"), NOW);

    expect(said).toContain('stays held after Apple approves it until extension_submit {action: "release"} puts it on sale');
    expect(said).not.toContain("answered this");
  });

  it("reads the version from the lock alone when the approval sentence is missing, and keeps the queued sentence for the other stores", () => {
    const bare = { lock: { kind: "review-in-progress", storeWord: "IN_REVIEW", clearsWhen: "Apple finishes reviewing 1.2.0 (build 4)", readAt: "2026-11-05T21:59:00.000Z" } };

    expect(safariLockSentences(bare, NOW)).toContain("safari: version 1.2.0 (build 4) is waiting for Apple (IN_REVIEW) and waits for Apple's verdict.");
    expect(safariLockSentences({ lock: null }, NOW)).toBe("");

    const both = lockSentences({ edge: EDGE_LOCKED, safari: safariBlock("AFTER_APPROVAL") }, NOW);

    expect(both).toContain("edge: the publish is locked until Microsoft finishes certifying 0.2.0.7 (InProgressSubmission); a submit or publish is queued behind it, never failed.");
    expect(both).toContain("safari: version 0.3.0 (build 18) is waiting for Apple");
    expect(both.split("never failed")).toHaveLength(2);
  });

  it("drops the separate Safari next-version sentence while the lock paragraph names it", () => {
    expect(nextVersionSentences({ safari: safariBlock("AFTER_APPROVAL"), chrome: { nextVersion: "0.3.0" } })).toBe("chrome: the next upload carries version 0.3.0.");
    expect(nextVersionSentences({ safari: { nextVersion: "0.3.0", lock: null } })).toBe("safari: the next upload carries version 0.3.0.");
  });

  describe("in the four-store preflight", () => {
    const platform = useProjectRoutes("extdev-safari-lock-decision-");

    it("puts the Safari paragraph in sayToPerson and keeps a submit step for the stores that can go", async () => {
      if (process.platform === "win32") return;

      const reports: Record<string, Row> = structuredClone(WALK);
      const safari = reports.safari!;

      safari.summary = { ...safari.summary, fail: 1, blockingFailures: 1, canSubmit: false };
      safari.checks.push({ id: "store.safari_app_review_lock", label: "App Review lock", status: "locked", severity: "blocking", stage: "review", message: "Apple is reviewing 0.3.0 (build 18).", lock: safariBlock("AFTER_APPROVAL").lock });
      safari.safariPreflight = { ...safariBlock("AFTER_APPROVAL", new Date(Date.now() - 4 * 3_600_000).toISOString()), inFlight: { submissionId: "d725c641", version: "0.3.0", buildNumber: "18", storeState: "WAITING_FOR_REVIEW" } };
      platform.login();

      for (const store of STORES) platform.routes[`POST ${PREFLIGHT(store)}`] = () => ({ body: reports[store] });

      const out = JSON.parse(await submit({ action: "preflight", browsers: [...STORES], api: API }));
      const said = out.value.sayToPerson as string;

      expect(out.status).toBe("preflight-read");
      expect(said).toContain("safari: version 0.3.0 (build 18) is waiting for Apple (WAITING_FOR_REVIEW) and goes on sale the moment Apple approves it");
      expect(said).toContain('withdraw it now with extension_submit {action: "cancel", store: "safari", submissionId: "d725c641"} and send the new build as 0.3.0');
      expect(out.value.storePreflight.safari.heldSubmissionId).toBe("d725c641");
      expect(said).toContain("answered this 4 hours ago");
      expect(said).not.toContain("safari: the next upload carries version 0.3.0.");
      expect(said).not.toContain("never failed");
      expect(said.split("safari: version 0.3.0 (build 18)")).toHaveLength(2);
      expect(out.value.storePreflight.safari.lock).toMatchObject({ storeWord: "WAITING_FOR_REVIEW" });
      expect(out.value.nextStep).toMatchObject({ kind: "submit" });
      expect(out.value.nextStep.say).toContain("safari stays out until the failing checks pass. Every check for the Chrome Web Store, Firefox AMO and Edge Add-ons is green.");
      expect(out.hint).toContain('extension_submit_check {action: "submit", browsers: ["chrome", "firefox", "edge"], buildSha: <a sha extension_builds lists>, dryRun: false}');
    });
  });
});
