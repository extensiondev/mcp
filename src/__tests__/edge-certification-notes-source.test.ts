import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { handler as submit } from "../tools/submit";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const PREFLIGHT = `${PROJECT_ROUTE}/stores/edge/submissions/preflight`;

const STORE_MD = `# Store metadata

## Listing

- Name: Leon
- Summary: Reads the page aloud.

## Edge Add-ons

### Certification notes

Everything runs on the device; open the popup and press Read.
`;

const NO_NOTES = "No notes for certification; Microsoft asks for test accounts, steps to hidden features and what changed, and an extension the testers cannot exercise might not pass certification.";

const REPORT = {
  store: "edge",
  summary: { pass: 3, warn: 1, fail: 0, blockingFailures: 0, canSubmit: true },
  checks: [{ id: "build.edge_package", label: "Package", status: "pass", severity: "blocking", stage: "integration", message: "The edge package is in order." }],
  connection: { kind: "api-key", connectedAs: "cezar@example.com", healthy: true, itemId: "903d21e4-0e5b-4507-95f2-4620fcf06f1c", itemLinked: true },
  requirements: {
    store: "edge",
    items: [
      {
        id: "edge.certification_notes",
        label: "Notes for certification",
        required: false,
        format: "Test steps and any test credentials the certification team needs; recommended for every submission.",
        status: "missing",
        satisfiedBy: "store-md: Certification notes",
        how: "Write them under `### Certification notes` in the `## Edge Add-ons` section of STORE.md; the submission sends them as the Edge notes.",
      },
    ],
    missingRequired: 0,
    missingOptional: 1,
  },
  edgePreflight: {
    act: "upload",
    blocking: [],
    warnings: ["edge.certification_notes"],
    checks: [{ id: "edge.certification_notes", severity: "warn", status: "fail", label: "Notes for certification", message: NO_NOTES, docs: "https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension" }],
  },
};

describe("the Edge certification notes read one source in the requirement row and the upload check (ledger 170)", () => {
  const platform = useProjectRoutes("extdev-edge-notes-");

  it("says the notes are in STORE.md and not yet synced on the upload check when the row reads them from the file", async () => {
    if (process.platform === "win32") return;

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-leon-notes-"));
    fs.writeFileSync(path.join(root, "STORE.md"), STORE_MD);
    platform.login();
    platform.routes[`POST ${PREFLIGHT}`] = () => ({ body: REPORT });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["edge"], projectPath: root, detail: true, api: API }));
    const row = out.value.stores.edge.requirements.items.find((item: { id: string }) => item.id === "edge.certification_notes");
    const check = out.value.storePreflight.edge.checks.find((item: { id: string }) => item.id === "edge.certification_notes");

    expect(row).toMatchObject({ status: "have", actual: "in STORE.md; sync-listing writes it" });
    expect(check).toMatchObject({ id: "edge.certification_notes", status: "fail", message: "certification notes found in STORE.md, not yet in the console listing; sync-listing writes it." });
    expect(JSON.stringify(out)).not.toContain(NO_NOTES);
  });

  it("keeps the platform's words when STORE.md carries no notes, so the row and the check agree on missing", async () => {
    if (process.platform === "win32") return;

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-leon-no-notes-"));
    fs.writeFileSync(path.join(root, "STORE.md"), "# Store metadata\n\n## Listing\n\n- Name: Leon\n");
    platform.login();
    platform.routes[`POST ${PREFLIGHT}`] = () => ({ body: REPORT });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["edge"], projectPath: root, detail: true, api: API }));
    const row = out.value.stores.edge.requirements.items.find((item: { id: string }) => item.id === "edge.certification_notes");
    const check = out.value.storePreflight.edge.checks.find((item: { id: string }) => item.id === "edge.certification_notes");

    expect(row.status).toBe("missing");
    expect(check.message).toBe(NO_NOTES);
  });
});
