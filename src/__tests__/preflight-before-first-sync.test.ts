import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CHROME_SYNC_CALL } from "../lib/store-md-chrome-reconcile";
import { handler as submit } from "../tools/submit";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const PREFLIGHT = `${PROJECT_ROUTE}/stores/chrome/submissions/preflight`;

const STORE_MD = `# Store metadata

## Listing

- Name: Hands-free
- Summary: Browse with your head and face.
- Category: Accessibility

## Chrome Web Store

### Single purpose

Control web pages hands-free with your head and face.

### Permissions justification

- sidePanel: The side panel is the extension's only interface.
- offscreen: Holds the camera and the models.
- storage: Remembers the settings on the device.
- tabs: Finds the tab the user is looking at.
- scripting: Injects the pointer overlay.
- *://*/*: Asked for one site at a time when the user allows it; nothing at install.

### Visibility

- Visibility: unlisted
`;

const DASHBOARD = "https://chrome.google.com/webstore/devconsole/00000000-0000-4000-8000-000000000000/abcdefghijklmnopabcdefghijklmnop/edit";

const REPORT = {
  store: "chrome",
  summary: { pass: 3, warn: 2, fail: 0, blockingFailures: 0, canSubmit: true },
  checks: [
    {
      id: "distribution.chrome_visibility",
      label: "Chrome visibility matches the project's intent",
      status: "warn",
      severity: "warning",
      stage: "review",
      expected: "Unlisted",
      actual: "unknown",
      message: `A new Chrome item defaults to Public in the dashboard, and this project's intent is Unlisted (the least public default, since STORE.md has no \`- Visibility:\` line). Google's API does not answer visibility, so set and confirm it on the Distribution tab of the item's dashboard at ${DASHBOARD}.`,
    },
    {
      id: "listing.chrome_host_justifications",
      label: "Every host the package reaches is justified",
      status: "warn",
      severity: "warning",
      stage: "review",
      expected: "A reason for each of 1 host patterns",
      actual: "1 without a reason",
      message: "the production Chrome package of build 154767e reaches *://*/*, which no bullet under `### Permissions justification` in STORE.md names. Add a reason for each, then paste it on the Privacy tab.",
    },
    { id: "build.chrome_manifest_v3", label: "Manifest V3", status: "pass", severity: "blocking", stage: "integration", message: "The built manifest is version 3." },
  ],
  prefill: { fields: [] },
  requirements: {
    store: "chrome",
    items: [
      {
        id: "chrome.permission_justifications",
        label: "Permission justification",
        required: true,
        format: "One plain-English reason per permission and host permission the manifest requests.",
        status: "missing",
        satisfiedBy: "store-dashboard",
        how: "Paste it on the Privacy tab from the `- <permission>: <reason>` bullets of `### Permissions justification` in the `## Chrome Web Store` section in STORE.md.",
        actual: "STORE.md has no `### Permissions justification` bullets",
        dashboardTab: "Privacy",
      },
      {
        id: "chrome.visibility",
        label: "Visibility",
        required: true,
        format: "Public, Unlisted or Private (trusted testers), set on the Distribution tab; a new item starts Public.",
        status: "unknown",
        satisfiedBy: "store-dashboard",
        how: "Set it on the Distribution tab of the item's dashboard to the project's intent.",
        actual: "a new item starts Public on the Distribution tab; the project's intent is Unlisted (the least public default; STORE.md has no `- Visibility:` line)",
        dashboardTab: "Distribution",
        dashboardUrl: DASHBOARD,
      },
      { id: "chrome.title", label: "Title", required: true, format: "Up to 75 characters.", status: "missing", satisfiedBy: "store-md: Name", how: "Set `- Name:` under `## Listing`." },
    ],
    missingRequired: 2,
    missingOptional: 0,
  },
};

describe("a Chrome preflight before the first sync-listing reads STORE.md for what the platform's record lacks (ledger 302, 303)", () => {
  const platform = useProjectRoutes("extdev-before-first-sync-");

  it("says not synced yet with what the file carries, and never that STORE.md is empty", async () => {
    if (process.platform === "win32") return;

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-hands-free-"));
    fs.writeFileSync(path.join(root, "STORE.md"), STORE_MD);
    platform.login();
    platform.routes[`POST ${PREFLIGHT}`] = () => ({ body: REPORT });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["chrome"], projectPath: root, detail: true, api: API }));
    const chrome = out.value.stores.chrome;
    const byId = (rows: Array<Record<string, unknown>>, id: string) => rows.find((item) => item.id === id);

    expect(byId(chrome.requirements.items, "chrome.permission_justifications")).toMatchObject({
      status: "missing",
      actual: `not synced yet (STORE.md carries 6 bullets under \`### Permissions justification\`): run ${CHROME_SYNC_CALL}`,
    });

    expect(byId(chrome.requirements.items, "chrome.visibility")?.actual).toBe(
      `a new item starts Public on the Distribution tab; the project's intent is Unlisted (the least public default; STORE.md carries \`- Visibility: unlisted\`, not synced yet: run ${CHROME_SYNC_CALL})`,
    );

    expect(byId(chrome.requirements.items, "chrome.title")).toMatchObject({ status: "have", satisfiedBy: "store-md: - Name:" });

    expect(byId(chrome.warnings, "distribution.chrome_visibility")?.message).toBe(
      `A new Chrome item defaults to Public in the dashboard, and this project's intent is Unlisted (the least public default; STORE.md carries \`- Visibility: unlisted\`, not synced yet: run ${CHROME_SYNC_CALL}). Google's API does not answer visibility, so set and confirm it on the Distribution tab of the item's dashboard at ${DASHBOARD}.`,
    );

    expect(byId(chrome.warnings, "listing.chrome_host_justifications")?.message).toBe(
      "*://*/* is named by a bullet under `### Permissions justification` in STORE.md, not yet in the listing record; sync-listing writes it.",
    );

    const text = JSON.stringify(chrome);

    expect(text).not.toContain("STORE.md has no `### Permissions justification` bullets");
    expect(text).not.toContain("STORE.md has no `- Visibility:` line");
  });
});
