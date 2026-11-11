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
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { handler as submit } from "../tools/submit";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

type Row = Record<string, any>;

const PREFLIGHT = (store: string) => `${PROJECT_ROUTE}/stores/${store}/submissions/preflight`;
const STORES = ["chrome", "edge", "firefox", "safari"] as const;
const WALK: Record<string, Row> = JSON.parse(fs.readFileSync(fileURLToPath(new URL("./fixtures/preflight-four-stores.json", import.meta.url)), "utf8"));
const CREDENTIALS = ["chrome.store_connection", "edge.partner_center_credentials", "firefox.api_credentials", "safari.api_key"];
const DECISIONS = ["support-email", "homepage", "privacy-policy", "category", "distribution", "license"];

function freshReports(connected: string[] = []): Record<string, Row> {
  const reports: Record<string, Row> = structuredClone(WALK);

  for (const store of STORES) {
    const report = reports[store]!;
    const keep = connected.includes(store);

    if (!keep) delete report.connection;

    report.requirements.items = report.requirements.items.map((row: Row) => {
      if (keep && CREDENTIALS.includes(row.id)) return row;

      return row.status === "have" ? { ...row, status: "missing", actual: "not on file" } : row;
    });
  }

  return reports;
}

function project(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-onboarding-"));

  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(root, name), body);

  return root;
}

const TEMPLATE_STORE_MD = `# Store metadata

Starter file generated from this template's manifest.

## Listing

- Name: Widget
- Summary: Reads the page.
- Subtitle: TODO a 30 character App Store subtitle
- Description:

  TODO two or three short paragraphs of user benefits.

- Category: TODO one per store
- Language: en
- License: MIT
- Support email: TODO the address users and reviewers write to
- Homepage: TODO the project or company site URL
- Screenshots:
  1. TODO screenshots/01.png

## Privacy and data use

- Privacy policy URL: TODO (Apple requires one on every app)
- Data collected: none

## Chrome Web Store

### Single purpose

Reads the page.
`;

const CHECK_ID = /\b[a-z]+\.[a-z_]+_(present|set|ok|missing)\b/;
const FILE_LINE = /set `- [^`]+` under `## [^`]+`/;
const FIVE_QUESTIONS =
  "Five answers are only needed before a public listing, not for this unlisted upload: which support email, which homepage, where your privacy policy lives, which category (default Other), and who can find it and at what price (default Firefox unlisted). Tell me and I write them down.";

const PACKAGE = JSON.stringify({ name: "widget", homepage: "https://widget.example", license: "MIT", bugs: { email: "help@widget.example" } });

describe("extension_submit preflight answers one readiness list and one decisions step across four stores", () => {
  const platform = useProjectRoutes("extdev-onboarding-");

  function serve(reports: Record<string, Row>): void {
    platform.login();

    for (const store of STORES) platform.routes[`POST ${PREFLIGHT(store)}`] = () => ({ body: reports[store] });
  }

  it("tags every row not on file in all four stores by who supplies it, and leads with a four-line summary when no store is connected", async () => {
    const reports = freshReports();
    serve(reports);

    const root = project({ "package.json": PACKAGE });
    const out = JSON.parse(await submit({ action: "preflight", browsers: [...STORES], projectPath: root, api: API }));
    const readiness = out.value.readiness;
    const open = STORES.flatMap((store) => (reports[store]!.requirements.items as Row[]).filter((row) => row.status !== "have").map((row) => row.id));
    const tagged = ["build", "agentDrafts", "personDecides"].flatMap((group) => [...(readiness[group]?.required ?? []), ...(readiness[group]?.optional ?? [])]);

    expect(readiness.stores).toEqual([...STORES]);
    expect([...tagged].sort()).toEqual([...open].sort());
    expect(new Set(tagged).size).toBe(tagged.length);
    expect(readiness.notOnFile).toBe(open.length);
    expect(readiness.personDecides.required).toEqual(expect.arrayContaining(CREDENTIALS));
    expect(readiness.personDecides.required).toEqual(expect.arrayContaining(["firefox.data_collection_permissions", "chrome.data_usage", "safari.app_privacy", "safari.content_rights"]));
    expect(readiness.build.required).toEqual(expect.arrayContaining(["chrome.screenshots", "firefox.icon", "safari.app_icon", "edge.package_contents"]));
    expect(readiness.agentDrafts.required).toEqual(expect.arrayContaining(["chrome.description", "chrome.single_purpose", "safari.reviewer_notes"]));
    expect(readiness.noStoreConnected).toBe(true);
    expect(readiness.notConnected).toEqual([...STORES]);

    expect(readiness.decisions.map((decision: Row) => decision.id)).toEqual(DECISIONS);

    const byId = Object.fromEntries(readiness.decisions.map((decision: Row) => [decision.id, decision]));

    expect(byId["support-email"]).toMatchObject({ default: "help@widget.example", defaultFrom: "package.json", writes: [{ line: "- Support email:", section: "## Listing" }] });
    expect(byId.homepage).toMatchObject({ default: "https://widget.example", writes: expect.arrayContaining([expect.objectContaining({ line: "- Support URL:", stores: ["safari"] })]) });
    expect(byId["privacy-policy"]).toMatchObject({ default: null, writes: [{ line: "- Privacy policy URL:", section: "## Privacy and data use" }] });
    expect(byId["privacy-policy"].defaultFrom).toBe("no policy on file: you write it and pick where it is hosted; the agent quotes the code facts in listingDraft.ownerAnswers and drafts none of it");
    expect(byId["privacy-policy"].ask).toContain("you write it");
    expect(`${byId["privacy-policy"].ask} ${byId["privacy-policy"].defaultFrom}`).not.toMatch(/agent drafts|drafts (one|it|the policy|PRIVACY)/i);
    expect(byId.category.default).toBe("Tools (Chrome), Productivity (Edge), Other (Firefox), Utilities (Safari)");
    expect(byId.distribution.default).toContain("Chrome unlisted");
    expect(byId.distribution.writes).toEqual([{ line: "- Visibility:", section: "## Chrome Web Store", stores: ["chrome"] }]);
    expect(byId.license).toMatchObject({ default: "MIT", defaultFrom: "package.json license", writes: [{ line: "- License:", section: "## Firefox Add-ons", stores: ["firefox"] }] });

    expect(readiness.summary).toHaveLength(4);
    expect(readiness.summary[0]).toBe(`Readiness for the Chrome Web Store, Edge Add-ons, Firefox AMO and the App Store: ${open.length} inputs are not on file yet and 0 are.`);
    expect(readiness.summary[2]).toBe("6 decisions need your answer, each with a default: support email, homepage, privacy policy URL, category per store, distribution (visibility, regions, price) and Firefox license.");
    expect(readiness.summary[3]).toContain("No store is connected yet");
    expect(out.value.sayToPerson.split("\n").slice(0, 4)).toEqual(readiness.summary);
  });

  it("counts a decision STORE.md already answers as on file and asks only the rest", async () => {
    serve(freshReports());

    const root = project({ "package.json": PACKAGE, "STORE.md": "# Store\n\n## Listing\n\n- Name: Widget\n- Support email: owner@widget.example\n- License: MIT\n" });
    const out = JSON.parse(await submit({ action: "preflight", browsers: [...STORES], projectPath: root, api: API }));
    const readiness = out.value.readiness;

    expect(readiness.decisionsOnFile).toEqual(["support-email", "license"]);
    expect(readiness.decisions.map((decision: Row) => decision.id)).toEqual(["homepage", "privacy-policy", "category", "distribution"]);
    expect(readiness.summary[2]).toMatch(/^4 decisions need your answer/);
  });

  it("asks no license when the platform answers no firefox.license row, which is every channel but listed", async () => {
    const reports = freshReports();
    reports.firefox!.requirements.items = (reports.firefox!.requirements.items as Row[]).filter((row) => row.id !== "firefox.license");
    serve(reports);

    const out = JSON.parse(await submit({ action: "preflight", browsers: [...STORES], projectPath: project({ "package.json": PACKAGE }), api: API }));
    const readiness = out.value.readiness;

    expect(readiness.decisions.map((decision: Row) => decision.id)).toEqual(DECISIONS.filter((id) => id !== "license"));
    expect(readiness.summary[2]).not.toContain("license");
    expect(JSON.stringify(readiness)).not.toContain("- License:");
  });

  it("never picks a license for the owner when package.json names none AMO takes", async () => {
    serve(freshReports());

    for (const files of [{ "package.json": JSON.stringify({ name: "widget" }) }, { "package.json": JSON.stringify({ name: "widget", license: "SEE LICENSE IN LICENSE" }), LICENSE: "Custom terms" }] as Array<Record<string, string>>) {
      const out = JSON.parse(await submit({ action: "preflight", browsers: ["firefox"], projectPath: project(files), api: API }));
      const license = (out.value.readiness.decisions as Row[]).find((decision) => decision.id === "license");

      expect(license?.default).toBeNull();
      expect(license?.defaultFrom).toContain("the agent asks");
    }
  });

  it("names only the decisions of the stores read, and keeps the answer's own lead once a store is connected", async () => {
    serve(freshReports(["chrome"]));

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["chrome"], api: API }));
    const readiness = out.value.readiness;

    expect(readiness.noStoreConnected).toBe(false);
    expect(readiness.connected).toEqual(["chrome"]);
    expect(readiness.decisions.map((decision: Row) => decision.id)).toEqual(["homepage", "privacy-policy", "category", "distribution"]);
    expect(readiness.summary[3]).toBe("Connected: the Chrome Web Store.");
    expect(out.value.sayToPerson.startsWith(readiness.summary[0])).toBe(false);
  });

  it("leads with the open decisions as questions, each with its default and whether it blocks now, on a template STORE.md with no listing answers (ledger 533)", async () => {
    serve(freshReports(["firefox"]));

    const root = project({ "package.json": JSON.stringify({ name: "widget" }), "STORE.md": TEMPLATE_STORE_MD });
    const out = JSON.parse(await submit({ action: "preflight", browsers: ["firefox"], projectPath: root, api: API }));
    const decisions: Row[] = out.value.readiness.decisions;

    expect(out.value.sayToPerson.startsWith(FIVE_QUESTIONS)).toBe(true);
    expect(decisions.map((decision) => [decision.id, decision.blocksNow])).toEqual([["support-email", false], ["homepage", false], ["privacy-policy", false], ["category", false], ["distribution", false]]);
    expect(decisions.filter((decision) => decision.writes.length).map((decision) => decision.writes[0].line)).toEqual(["- Support email:", "- Homepage:", "- Privacy policy URL:", "- Category:"]);
    expect(FIVE_QUESTIONS).not.toMatch(/`|##|STORE\.md/);
  });

  it("says which answers this upload needs when a blocking check names one, and lets the blocker lead (ledger 533)", async () => {
    const reports = freshReports(["firefox"]);
    const firefox = reports.firefox!;

    firefox.checks = [...firefox.checks, { id: "listing.firefox_privacy_policy_present", status: "fail", severity: "blocking", stage: "integration", message: "privacy policy URL: not set; add `- Privacy policy URL: <address>` under `## Privacy and data use` in STORE.md." }];
    firefox.summary = { ...firefox.summary, fail: 1, blockingFailures: 1, canSubmit: false, integration: { ...firefox.summary.integration, fail: 1, blockingFailures: 1, canQueue: false } };
    serve(reports);

    const root = project({ "package.json": JSON.stringify({ name: "widget" }), "STORE.md": TEMPLATE_STORE_MD });
    const out = JSON.parse(await submit({ action: "preflight", browsers: ["firefox"], projectPath: root, api: API }));
    const byId = Object.fromEntries((out.value.readiness.decisions as Row[]).map((decision) => [decision.id, decision]));

    expect(byId["privacy-policy"].blocksNow).toBe(true);
    expect(byId["support-email"].blocksNow).toBe(false);
    expect(out.value.sayToPerson.startsWith("One answer")).toBe(false);
    expect(out.value.sayToPerson).toContain(
      "One answer is needed before this upload: where your privacy policy lives. Four more are only needed before a public listing: which support email, which homepage, which category (default Other), and who can find it and at what price (default Firefox unlisted). Tell me and I write them down.",
    );

    expect(out.value.sayToPerson).not.toMatch(CHECK_ID);
    expect(out.hint).not.toMatch(CHECK_ID);
  });

  it("calls the file your store listing (STORE.md) on its first mention to the person, and keeps check ids and file lines out of sayToPerson and hint (ledger 533)", async () => {
    for (const browsers of [["chrome"], ["firefox"], [...STORES]]) {
      serve(freshReports(browsers));

      const root = project({ "package.json": JSON.stringify({ name: "widget" }), "STORE.md": TEMPLATE_STORE_MD });
      const out = JSON.parse(await submit({ action: "preflight", browsers, projectPath: root, api: API }));
      const say: string = out.value.sayToPerson;
      const first = say.indexOf("STORE.md");

      if (first >= 0) expect(say.slice(0, first + "STORE.md".length)).toMatch(/store listing \(STORE\.md$/);

      expect(say).not.toMatch(CHECK_ID);
      expect(say).not.toMatch(FILE_LINE);
      expect(out.hint).not.toMatch(CHECK_ID);
      expect(out.hint).not.toMatch(FILE_LINE);
      expect(out.value.nextStep.say).not.toMatch(CHECK_ID);
    }
  });
});
