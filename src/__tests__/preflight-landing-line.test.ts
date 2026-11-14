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

import { serverInstructions } from "../index";
import { reviewPromiseOf } from "../lib/review-promise";
import { submissionLandingClause, submissionLandingLine } from "../lib/submission-landing";
import { handler as submit, schema } from "../tools/submit-local";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

type Row = Record<string, any>;

const PREFLIGHT = (store: string) => `${PROJECT_ROUTE}/stores/${store}/submissions/preflight`;
const STORES = ["chrome", "firefox", "edge", "safari"] as const;
const WALK: Record<string, Row> = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/preflight-four-stores.json", import.meta.url)), "utf8"));

const MODES: Record<string, Row> = {
  chrome: { id: "public", label: "Public publish", description: "Chrome submissions can go public after approval.", setBy: { by: "owner", at: "2026-11-01T10:00:00.000Z" } },
  edge: { id: "review", label: "Send to certification", description: "Certification publishes the extension to everyone when it passes." },
  firefox: { id: "listed", label: "Listed", description: "AMO lists the add-on once Mozilla approves it." },
  safari: { id: "draft", label: "TestFlight draft", description: "The upload stops at TestFlight." },
};

function withModes(blockSafari: boolean): Record<string, Row> {
  const reports: Record<string, Row> = structuredClone(WALK);

  for (const store of STORES) reports[store]!.submissionMode = MODES[store];

  if (blockSafari) {
    const safari = reports.safari!;

    safari.summary = { ...safari.summary, fail: 1, blockingFailures: 1, canSubmit: false };
    safari.checks.push({ id: "listing.safari_app_store_declarations", label: "App Store declarations", status: "fail", severity: "blocking", stage: "review", message: "The listing is locked while Apple reviews 0.3.0." });
  }

  return reports;
}

function serve(platform: ReturnType<typeof useProjectRoutes>, reports: Record<string, Row>): void {
  platform.login();

  for (const store of STORES) platform.routes[`POST ${PREFLIGHT(store)}`] = () => ({ body: reports[store] });
}

describe("415: the preflight leads with where an approved submit lands under each saved mode, blocked store or not", () => {
  const platform = useProjectRoutes("extdev-preflight-landing-");

  it("says one clause per store from the saved mode, and the least public default when none is saved", () => {
    expect(submissionLandingClause("chrome", { id: "public" })).toBe("chrome: public once Google's review passes (saved mode public)");
    expect(submissionLandingClause("chrome", { id: "public", setBy: { by: "owner", at: "2026-11-01T10:00:00.000Z" } })).toBe("chrome: public once Google's review passes (saved mode public, set by the owner on 2026-11-01)");
    expect(submissionLandingClause("edge", { id: "review" })).toBe("edge: public once Microsoft's certification passes (saved mode review)");
    expect(submissionLandingClause("firefox", { id: "listed" })).toBe("firefox: listed on AMO, public once Mozilla's review passes (saved channel listed)");
    expect(submissionLandingClause("safari", { id: "review" })).toContain("safari: Apple's App Review, on sale when Apple approves it only if STORE.md says release after approval (saved mode review)");
    expect(submissionLandingClause("chrome", null)).toBe("chrome: a draft Google does not review until you publish (no saved mode, the least public default)");
    expect(submissionLandingClause("firefox", null)).toBe("firefox: unlisted on AMO, signed for self distribution with no review (no saved channel, the least public default)");
    expect(submissionLandingClause("opera", { id: "public" })).toBe("");
    expect(submissionLandingLine({ chrome: { submissionMode: { id: "public" } }, edge: {} })).toBe(
      "Where an approved submit lands: chrome: public once Google's review passes (saved mode public); edge: a Partner Center draft Microsoft does not certify until you publish (no saved mode, the least public default).",
    );
  });

  it("leads sayToPerson with the landing line while one store is blocked, which dropped every mode before", async () => {
    if (process.platform === "win32") return;

    serve(platform, withModes(true));

    const out = JSON.parse(await submit({ action: "preflight", browsers: [...STORES], api: API }));
    const said = out.value.sayToPerson as string;

    expect(out.status).toBe("preflight-read");
    expect(said.startsWith("Where an approved submit lands: chrome: public once Google's review passes (saved mode public, set by the owner on 2026-11-01); firefox: listed on AMO, public once Mozilla's review passes (saved channel listed); edge: public once Microsoft's certification passes (saved mode review); safari: a TestFlight draft Apple does not review until you publish (saved mode draft).")).toBe(true);
    expect(said).toContain("safari cannot be submitted yet");
    expect(said.split("Where an approved submit lands")).toHaveLength(2);
  });

  it("leads with the same line when every store is green, in place of the mode paragraph", async () => {
    if (process.platform === "win32") return;

    serve(platform, withModes(false));

    const out = JSON.parse(await submit({ action: "preflight", browsers: [...STORES], api: API }));
    const said = out.value.sayToPerson as string;

    expect(said).toContain("Tell me and I write them down. Where an approved submit lands: chrome: public once Google's review passes");
    expect(said.indexOf("Where an approved submit lands")).toBeLessThan(said.indexOf("Every store read here"));
    expect(said).not.toContain("submission mode: Public publish");
    expect(out.value.stores.chrome.submissionMode).toMatchObject({ id: "public", label: "Public publish" });
  });

  it("the submit approval's reviewPromise covers Firefox's listed channel beside the Chrome and Edge modes", () => {
    const promise = reviewPromiseOf(["chrome", "edge", "firefox"], [], { chrome: "public", edge: "review", firefox: "listed" });

    expect(promise).toContain("Chrome, Edge and Firefox go to review on approval.");
    expect(promise).toContain(`Under the Chrome Web Store's saved mode "public" this upload goes on to review after it lands`);
    expect(promise).toContain(`Under Edge Add-ons's saved mode "review" this upload goes on to review after it lands`);
    expect(promise).toContain(`Under Firefox AMO's saved channel "listed" this upload goes to Mozilla's review after it lands and is listed publicly when it passes`);
    expect(reviewPromiseOf(["firefox"], [], { firefox: "unlisted" })).toBe("");
  });

  it("the action description and the server instructions say the draft default holds only with no saved mode and point at the line", () => {
    const action = (schema.inputSchema.properties as Record<string, { description?: string }>).action?.description ?? "";
    const instructions = serverInstructions({ features: ["local", "platform"], noShip: false });

    expect(action).toContain("preflight: readiness checks");
    expect(schema.description).toContain("unless a saved store mode says otherwise");
    expect(instructions).toContain("unless the project's store settings say otherwise (a saved submission mode or channel sends the upload where it says, and the preflight's sayToPerson leads with one line per store saying where an approved submit lands)");
  });
});
