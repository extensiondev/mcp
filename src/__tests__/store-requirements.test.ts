import { describe, expect, it } from "vitest";

import { configuredRequirementsNote, missingRequiredSentence, requirementsView } from "../lib/store-requirements";
import { handler as submit } from "../tools/submit";
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

    const counted = requirementsView({ store: "chrome", items: [requirement({ id: "chrome.title", status: "missing" }), requirement({ id: "chrome.promo_video", required: false, status: "missing" }), requirement({ id: "chrome.x", status: "odd" })] });

    expect(counted).toMatchObject({ missingRequired: 1, missingOptional: 1 });
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
