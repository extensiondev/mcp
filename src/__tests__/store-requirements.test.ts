import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { configuredRequirementsNote, missingRequiredSentence, requirementsView } from "../lib/store-requirements";
import { handler as submit } from "../tools/submit";
import { solidPng } from "./fixtures/png";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const PREFLIGHT = (store: string) => `${PROJECT_ROUTE}/stores/${store}/submissions/preflight`;
const CONFIG = `${PROJECT_ROUTE}/stores/config`;

const SCREENSHOT_FORMAT =
  "1 to 10 macOS screenshots at exactly 1280x800, 1440x900, 2560x1600, 2880x1800 px, RGB with no alpha channel, showing the extension running in Safari.";

function requirement(over: Record<string, unknown>) {
  return {
    id: "safari.name",
    label: "Name",
    required: true,
    format: "Up to 30 characters; the app record's name.",
    docs: "https://developer.apple.com/help/app-store-connect/reference/app-information",
    satisfiedBy: "store-md: Name",
    how: "Set `- Name:` under `## Listing` in STORE.md; the Safari listing push writes it.",
    status: "have",
    ...over,
  };
}

const SAFARI_REQUIREMENTS = {
  store: "safari",
  items: [
    requirement({}),
    requirement({
      id: "safari.screenshots",
      label: "macOS screenshots",
      format: SCREENSHOT_FORMAT,
      satisfiedBy: "store-md: Screenshots",
      how: "List the files on `- Screenshots:` under `## Listing` in STORE.md; the Safari listing push uploads them.",
      status: "missing",
      actual: "0 screenshots",
    }),
    requirement({
      id: "safari.primary_category",
      label: "Primary category",
      format: "One App Store category on the app record; an upload without it is rejected with error 90242.",
      satisfiedBy: "store-md: Category",
      how: "Set `- Category:` under `## Listing` in STORE.md; the Safari listing push writes it.",
      status: "missing",
    }),
    requirement({ id: "safari.app_privacy", label: "App Privacy answers", satisfiedBy: "store-dashboard", how: "Answer the App Privacy sheet once in App Store Connect; it has no API.", status: "unknown" }),
    requirement({ id: "safari.subtitle", label: "Subtitle", required: false, format: "Up to 30 characters.", satisfiedBy: "store-md: Summary", status: "missing" }),
  ],
  missingRequired: 2,
  missingOptional: 1,
};

const WALK_STORE_MD = `# Store metadata

## Listing

- Name: Rebeccat
- Summary: Blur names on every open tab with one click.
- Description:

  Sharing your screen? Click Rebeccat and names are blurred on every open tab.

- Category: Productivity
- Screenshots (1280x800, in this order):
  1. store/screenshot-1.png
  2. store/screenshot-2.png

## Privacy and data use

- Privacy policy URL: https://rebeccat.example/privacy

## Chrome Web Store

### Single purpose

Blur personal information on the pages the user has open, on demand.

### Permissions justification

- storage: Remembers whether the blur is on.
- scripting: Adds the blur script to tabs that were open before install.

## Safari

- Review contact name: Cezar Augusto
- Review contact email: review@rebeccat.example
- Review contact phone: +5511999999999

### Reviewer notes

Turn Rebeccat on in Safari Settings, Extensions, then click the toolbar button.
`;

function walkProject(storeMd = WALK_STORE_MD): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-walk-"));
  fs.writeFileSync(path.join(root, "STORE.md"), storeMd);
  fs.mkdirSync(path.join(root, "store"));
  fs.writeFileSync(path.join(root, "store", "screenshot-1.png"), solidPng(1280, 800));
  fs.writeFileSync(path.join(root, "store", "screenshot-2.png"), solidPng(1280, 800));

  return root;
}

const walkMissing = (store: string, id: string, label: string, satisfiedBy: string, over: Record<string, unknown> = {}) =>
  requirement({ id, label, format: `${label} as the store asks.`, satisfiedBy, status: "missing", ...over });

const CHROME_WALK = {
  store: "chrome",
  items: [
    walkMissing("chrome", "chrome.title", "Title", "store-md: Name"),
    walkMissing("chrome", "chrome.summary", "Summary", "store-md: Summary"),
    walkMissing("chrome", "chrome.description", "Description", "store-md: Description"),
    walkMissing("chrome", "chrome.category", "Category", "store-md: Category", { actual: "0 categories" }),
    walkMissing("chrome", "chrome.screenshots", "Screenshots", "store-md: Screenshots", { actual: "0 screenshots" }),
    walkMissing("chrome", "chrome.single_purpose", "Single purpose description", "store-md: Single purpose"),
    walkMissing("chrome", "chrome.permission_justifications", "Permission justification", "store-md: Permissions justification", { actual: "0 justifications" }),
    walkMissing("chrome", "chrome.store_connection", "Chrome Web Store developer account connected", "console-only"),
    walkMissing("chrome", "chrome.promo_video", "Promo video", "store-dashboard", { required: false }),
  ],
  missingRequired: 8,
  missingOptional: 1,
};

const SAFARI_WALK = {
  store: "safari",
  items: [
    walkMissing("safari", "safari.review_contact_name", "App Review contact name", "store-md: Review contact name", { push: "not pushed yet" }),
    walkMissing("safari", "safari.review_contact_email", "App Review contact email", "store-md: Review contact email", { push: "not pushed yet" }),
    walkMissing("safari", "safari.review_contact_phone", "App Review contact phone", "store-md: Review contact phone", { push: "not pushed yet" }),
    walkMissing("safari", "safari.reviewer_notes", "App Review notes", "store-md: Reviewer notes", { push: "not pushed yet" }),
    requirement({ id: "safari.age_rating", label: "Age rating", satisfiedBy: "store-md: Age rating", status: "have", actual: "none to every question (the default)", push: "not pushed yet" }),
    requirement({ id: "safari.description", label: "Description", satisfiedBy: "listing", status: "have", push: "queued" }),
    walkMissing("safari", "safari.api_key", "App Store Connect API key", "console-only", { actual: "0 of 3 saved" }),
  ],
  missingRequired: 5,
  missingOptional: 0,
};

function report(store: string, canSubmit: boolean, requirements?: unknown) {
  return {
    store,
    summary: { pass: 9, warn: 0, fail: canSubmit ? 0 : 1, blockingFailures: canSubmit ? 0 : 1, canSubmit },
    checks: [
      { id: "listing.safari_screenshots_present", label: "Screenshots are present", status: canSubmit ? "pass" : "fail", severity: "blocking", stage: "review", ownership: "shared", message: "Every App Store version needs at least one macOS screenshot." },
    ],
    prefill: { fields: [] },
    ...(requirements ? { requirements } : {}),
  };
}

describe("extension_submit preflight carries what each store asks for and says what is missing first", () => {
  const platform = useProjectRoutes("extdev-store-requirements-");

  it("answers value.stores.<store>.requirements as the platform listed them and leads sayToPerson with the missing required inputs by name and format", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT("safari")}`] = () => ({ body: report("safari", false, SAFARI_REQUIREMENTS) });
    platform.routes[`POST ${PREFLIGHT("edge")}`] = () => ({ body: report("edge", true, { store: "edge", items: [requirement({ id: "edge.name", label: "Extension name", format: "Up to 45 characters." })], missingRequired: 0, missingOptional: 0 }) });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["safari", "edge"], buildSha: "603fc8a", api: API }));

    expect(out.status).toBe("preflight-read");
    expect(out.value.stores.safari.requirements).toEqual({
      store: "safari",
      items: SAFARI_REQUIREMENTS.items,
      missingRequired: 2,
      missingOptional: 1,
    });

    expect(out.value.stores.safari.requirements.items.map((item: { id: string }) => item.id)).toEqual([
      "safari.name",
      "safari.screenshots",
      "safari.primary_category",
      "safari.app_privacy",
      "safari.subtitle",
    ]);

    expect(out.value.stores.edge.requirements.missingRequired).toBe(0);

    const lead = `The App Store asks for 2 required inputs the project does not have yet: macOS screenshots (${SCREENSHOT_FORMAT}); Primary category (One App Store category on the app record; an upload without it is rejected with error 90242.).`;

    expect(out.value.sayToPerson.startsWith(lead)).toBe(true);
    expect(out.value.sayToPerson).toContain("safari cannot be submitted yet");
    expect(out.hint.startsWith(lead)).toBe(true);
    expect(out.value.sayToPerson).not.toContain("Edge Add-ons asks for");
    expect(out.value.sayToPerson).not.toMatch(/generat/i);
    expect(out.value.sayToPerson).not.toContain("Subtitle");
    expect(out.value.trackUrl ?? out.value.storesPageUrl).toBeTruthy();
  });

  it("answers have, from the STORE.md line sync-listing would send, for every input the walk's STORE.md carries, and counts only what is still missing", async () => {
    if (process.platform === "win32") return;

    const root = walkProject();
    platform.login();
    platform.routes[`POST ${PREFLIGHT("chrome")}`] = () => ({ body: report("chrome", false, CHROME_WALK) });
    platform.routes[`POST ${PREFLIGHT("safari")}`] = () => ({ body: report("safari", false, SAFARI_WALK) });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["chrome", "safari"], projectPath: root, api: API }));
    const chrome = out.value.stores.chrome.requirements;
    const safari = out.value.stores.safari.requirements;
    const byId = (view: { items: Array<Record<string, unknown>> }, id: string) => view.items.find((item) => item.id === id);

    expect(byId(chrome, "chrome.title")).toMatchObject({ status: "have", satisfiedBy: "store-md: - Name:", actual: "in STORE.md; sync-listing writes it" });
    expect(byId(chrome, "chrome.summary")).toMatchObject({ status: "have", satisfiedBy: "store-md: - Summary:" });
    expect(byId(chrome, "chrome.description")).toMatchObject({ status: "have", satisfiedBy: "store-md: - Description:" });
    expect(byId(chrome, "chrome.category")).toMatchObject({ status: "have", satisfiedBy: "store-md: - Category:" });
    expect(byId(chrome, "chrome.single_purpose")).toMatchObject({ status: "have", satisfiedBy: "store-md: ### Single purpose" });
    expect(byId(chrome, "chrome.permission_justifications")).toMatchObject({ status: "have", satisfiedBy: "store-md: ### Permissions justification" });
    expect(byId(chrome, "chrome.screenshots")).toMatchObject({
      status: "have",
      satisfiedBy: "store-md: - Screenshots (1280x800, in this order):",
      actual: "2 files on the `- Screenshots (1280x800, in this order):` line of STORE.md; sync-listing uploads them",
    });

    expect(byId(chrome, "chrome.store_connection")).toMatchObject({ status: "missing", satisfiedBy: "console-only" });
    expect(byId(chrome, "chrome.promo_video")).toMatchObject({ status: "missing", satisfiedBy: "store-dashboard" });
    expect(chrome.missingRequired).toBe(1);
    expect(chrome.missingOptional).toBe(1);

    for (const id of ["safari.review_contact_name", "safari.review_contact_email", "safari.review_contact_phone"]) {
      expect(byId(safari, id)).toMatchObject({ status: "have", push: "not pushed yet" });
    }

    expect(byId(safari, "safari.review_contact_phone")?.satisfiedBy).toBe("store-md: - Review contact phone:");
    expect(byId(safari, "safari.reviewer_notes")).toMatchObject({ status: "have", satisfiedBy: "store-md: ### Reviewer notes", push: "not pushed yet" });
    expect(byId(safari, "safari.age_rating")).toMatchObject({ status: "have", push: "not pushed yet" });
    expect(byId(safari, "safari.description")).toMatchObject({ status: "have", satisfiedBy: "listing", push: "queued" });
    expect(byId(safari, "safari.api_key")).toMatchObject({ status: "missing", actual: "0 of 3 saved" });
    expect(byId(safari, "safari.api_key")).not.toHaveProperty("push");
    expect(safari.missingRequired).toBe(1);

    expect(out.value.sayToPerson.startsWith("The Chrome Web Store asks for 1 required input the project does not have yet: Chrome Web Store developer account connected (")).toBe(true);
    expect(out.value.sayToPerson).toContain("The App Store asks for 1 required input the project does not have yet: App Store Connect API key (");
    expect(out.value.sayToPerson).not.toContain("Title");
    expect(out.value.sayToPerson).not.toContain("App Review contact");
    expect(out.value.sayToPerson).not.toContain("not pushed");
    expect(out.value.stores.chrome.storeMd.notCovered.some((line: string) => line.startsWith("screenshots"))).toBe(false);
    expect(out.value.trackUrl ?? out.value.storesPageUrl).toBeTruthy();
    expect(JSON.stringify(out)).not.toMatch(/github\.com|actions\/runs/);
  });

  it("keeps the Screenshots item missing when the line is there in a form the reader rejects, naming the line it wants in the item and in the storeMd block", async () => {
    if (process.platform === "win32") return;

    const root = walkProject(
      WALK_STORE_MD.replace(
        "- Screenshots (1280x800, in this order):\n  1. store/screenshot-1.png\n  2. store/screenshot-2.png",
        "- Screenshots (1280x800): see the store folder",
      ),
    );
    platform.login();
    platform.routes[`POST ${PREFLIGHT("chrome")}`] = () => ({
      body: {
        ...report("chrome", false, CHROME_WALK),
        checks: [{ id: "listing.chrome_screenshots_present", status: "fail", severity: "blocking", stage: "review", ownership: "shared", message: "Add at least one screenshot." }],
      },
    });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["chrome"], projectPath: root, api: API }));
    const shots = out.value.stores.chrome.requirements.items.find((item: { id: string }) => item.id === "chrome.screenshots");
    const wanted = "the `- Screenshots (1280x800):` line in STORE.md names no .png file; the reader takes `- Screenshots:` with one PNG path per line below it";

    expect(shots).toMatchObject({ status: "missing", satisfiedBy: "store-md: Screenshots", actual: wanted });
    expect(out.value.stores.chrome.storeMd.notCovered).toContain(
      "screenshots: the `- Screenshots (1280x800):` line in STORE.md names no .png file; the reader takes `- Screenshots:` with one PNG path per line below it (`1. store/screenshot-1.png`)",
    );

    expect(out.value.stores.chrome.failing[0].message).toBe(
      "screenshots: the `- Screenshots (1280x800):` line in STORE.md names no .png file; the reader takes `- Screenshots:` with one PNG path per line below it (`1. store/screenshot-1.png`).",
    );

    expect(out.value.sayToPerson).toContain("Screenshots (Screenshots as the store asks.)");
    expect(out.value.stores.chrome.requirements.missingRequired).toBe(2);
  });

  it("keeps the readiness answer unchanged for a platform that answers no requirements", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${PREFLIGHT("chrome")}`] = () => ({ body: report("chrome", true) });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["chrome"], buildSha: "603fc8a", api: API }));

    expect(out.status).toBe("preflight-read");
    expect(out.value.stores.chrome.requirements).toBeUndefined();
    expect(out.value.sayToPerson).toBe(out.hint);
    expect(out.value.sayToPerson.startsWith("Every store read here is ready to submit.")).toBe(true);
  });

  it("names, after a store is enabled through configure-store, how many required inputs the project still lacks when the platform answers them", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`PUT ${CONFIG}`] = () => ({
      body: { ok: true, store: "safari", changes: ["safari: enable store publishing"], requirements: SAFARI_REQUIREMENTS },
    });

    const out = JSON.parse(await submit({ action: "configure-store", store: "safari", storeSettings: { enabled: true }, api: API }));

    expect(out.status).toBe("store-configured");
    expect(out.value.nextStep.kind).toBe("preflight");
    expect(out.value.nextStep.say).toContain("Say preflight");
    expect(out.value.nextStep.say).toContain("The store asks for 2 required inputs the project does not have yet; the preflight names each with its format.");
    expect(out.value.sayToPerson).toBe(out.value.nextStep.say);
    expect(out.value.trackUrl).toBeTruthy();
  });

  it("reads the platform's rows whole, counts when the platform did not, and says nothing when nothing is missing", () => {
    expect(requirementsView(null)).toBeNull();
    expect(requirementsView({ store: "edge" })).toBeNull();

    const counted = requirementsView({ store: "chrome", items: [requirement({ id: "chrome.title", status: "missing", push: "queued" }), requirement({ id: "chrome.promo_video", required: false, status: "missing" }), requirement({ id: "chrome.x", status: "odd" })] });

    expect(counted).toMatchObject({ missingRequired: 1, missingOptional: 1 });
    expect(counted?.items[0]?.push).toBe("queued");
    expect(requirementsView({ store: "safari", items: [requirement({ status: "have", push: "not pushed yet" })], missingRequired: 0, missingOptional: 0 })).toMatchObject({ missingRequired: 0 });
    expect(counted?.items[2]?.status).toBe("unknown");
    expect(missingRequiredSentence("chrome", counted)).toBe("The Chrome Web Store asks for 1 required input the project does not have yet: Name (Up to 30 characters; the app record's name.).");
    expect(missingRequiredSentence("chrome", requirementsView({ store: "chrome", items: [requirement({})] }))).toBe("");
    expect(missingRequiredSentence("chrome", null)).toBe("");

    const many = requirementsView({ store: "firefox", items: Array.from({ length: 10 }, (_, i) => requirement({ id: `firefox.${i}`, label: `Input ${i}`, status: "missing" })) });

    expect(missingRequiredSentence("firefox", many)).toContain("; and 2 more.");
    expect(configuredRequirementsNote({ requirements: { safari: { ...SAFARI_REQUIREMENTS, missingRequired: 0 } } }, "safari")).toBe(" Every required input the store asks for is on file.");
    expect(configuredRequirementsNote({ requirements: { chrome: SAFARI_REQUIREMENTS } }, "safari")).toBe("");
    expect(configuredRequirementsNote({ ok: true }, "safari")).toBe("");
  });
});
