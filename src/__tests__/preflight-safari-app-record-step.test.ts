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

import { LANGUAGE_FROM, MINT_CALL, SKU_FROM } from "../lib/safari-app-record-step";
import { handler as submit } from "../tools/submit-local";
import { storeMdNamedForPerson } from "../lib/store-md-words";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

type Row = Record<string, any>;

const PREFLIGHT = `${PROJECT_ROUTE}/stores/safari/submissions/preflight`;
const WALK: Record<string, Row> = JSON.parse(fs.readFileSync(fileURLToPath(new URL("./fixtures/preflight-four-stores.json", import.meta.url)), "utf8"));
const BUNDLE_CHECK = "store.safari_bundle_identifiers";

function safariReport(edit: (report: Row) => void = () => {}): Row {
  const report: Row = structuredClone(WALK.safari);
  const rows = report.requirements.items as Row[];
  const record = rows.find((row) => row.id === "safari.app_record")!;

  record.status = "missing";
  record.actual = "not on file";
  report.requirements.missingRequired = 1;
  edit(report);

  return report;
}

function project(storeMd: string | null): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-app-record-"));

  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "widget" }));
  if (storeMd !== null) fs.writeFileSync(path.join(root, "STORE.md"), storeMd);

  return root;
}

const STORE_MD = "# Store\n\n## Listing\n\n- Name: Widget\n";

describe("the Safari preflight's app record step names the registration and the mint before App Store Connect", () => {
  const platform = useProjectRoutes("extdev-app-record-");

  async function preflight(report: Row, storeMd: string | null = STORE_MD): Promise<Row> {
    platform.login();
    platform.routes[`POST ${PREFLIGHT}`] = () => ({ body: report });

    return JSON.parse(await submit({ action: "preflight", browsers: ["safari"], projectPath: project(storeMd), api: API }));
  }

  const appRecordRow = (out: Row): Row => (out.value.stores.safari.bringList.rows as Row[]).find((row) => row.id === "safari.app_record")!;

  it("says the saved bundle id is not confirmed registered, names Mint signing assets and its route as what registers both ids, and only then sends the person to New App", async () => {
    const out = await preflight(safariReport());
    const row = appRecordRow(out);

    expect(row.clearedBy).toMatch(/^App record: com\.acme\.widget is not confirmed registered with Apple/);
    expect(row.clearedBy).toContain("New App form lists only registered bundle ids, so register it first");
    expect(row.clearedBy).toContain("registers both com.acme.widget and com.acme.widget.extension with your Apple team");
    expect(row.clearedBy).toContain(`${MINT_CALL} runs the same mint under one owner approval`);

    const register = row.clearedBy.indexOf("register it first");
    const mint = row.clearedBy.indexOf("Mint signing assets");
    const connect = row.clearedBy.indexOf("https://appstoreconnect.apple.com/apps");

    expect(register).toBeGreaterThan(-1);
    expect(mint).toBeGreaterThan(register);
    expect(connect).toBeGreaterThan(mint);
    expect(out.value.sayToPerson).toContain(storeMdNamedForPerson(row.clearedBy));
    expect(out.value.sayToPerson.split("App record:")).toHaveLength(2);
  });

  it("carries the exact values to type from STORE.md and names the SKU and primary language rows STORE.md lacks with what the platform uses instead", async () => {
    const out = await preflight(safariReport());
    const row = appRecordRow(out);

    expect(row.clearedBy).toContain("platform macOS, name Widget (from `- Name:` under `## Listing` in STORE.md), bundle ID com.acme.widget, SKU com.acme.widget");
    expect(row.clearedBy).toContain(SKU_FROM);
    expect(row.clearedBy).toContain(`primary language: ${LANGUAGE_FROM}`);
    expect(SKU_FROM).toContain("STORE.md has no SKU row");
    expect(LANGUAGE_FROM).toContain("STORE.md has no primary language row");
  });

  it("reads `- App Store name:` under `## Safari` over the listing Name, and names the App Store name row when the Name is over Apple's limit", async () => {
    const named = await preflight(safariReport(), "# Store\n\n## Listing\n\n- Name: Widget\n\n## Safari\n\n- App Store name: Widget for Safari\n");

    expect(appRecordRow(named).clearedBy).toContain("name Widget for Safari (from `- App Store name:` under `## Safari` in STORE.md)");

    const long = await preflight(safariReport(), "# Store\n\n## Listing\n\n- Name: A Widget Whose Name Runs Past Thirty Characters\n");

    expect(appRecordRow(long).clearedBy).toMatch(/name: STORE\.md's `- Name:` is \d+ characters, over the 30 the App Store takes; add `- App Store name:` under `## Safari`/);

    const none = await preflight(safariReport(), "# Store\n\n## Listing\n\n- Summary: A widget\n");

    expect(appRecordRow(none).clearedBy).toContain("name: STORE.md has no `- App Store name:` under `## Safari` and no `- Name:` under `## Listing`; add one");
  });

  it("says both ids are registered when the platform's check passes, and sends the person straight to New App with the values", async () => {
    const out = await preflight(
      safariReport((report) => {
        const check = (report.checks as Row[]).find((row) => row.id === BUNDLE_CHECK)!;

        check.status = "pass";
        check.severity = "info";
        check.message = "Both bundle identifiers are registered with your Apple team: com.acme.widget and com.acme.widget.extension, minted by extension.dev on 2026-11-06.";
      }),
    );
    const row = appRecordRow(out);

    expect(row.clearedBy).toMatch(/^App record: both bundle ids are registered with your Apple team \(com\.acme\.widget and com\.acme\.widget\.extension, by Mint signing assets\), so App Store Connect lists the bundle id; create the app record once at https:\/\/appstoreconnect\.apple\.com\/apps/);
    expect(row.clearedBy).not.toContain("not confirmed");
    expect(row.clearedBy).toContain("bundle ID com.acme.widget, SKU com.acme.widget");
  });

  it("names configure-store as the first step when no bundle id is saved, before the mint and App Store Connect", async () => {
    const out = await preflight(
      safariReport((report) => {
        const bundle = (report.requirements.items as Row[]).find((row) => row.id === "safari.bundle_identifiers")!;

        bundle.status = "missing";
        bundle.actual = "not on file";
        report.requirements.missingRequired = 2;
      }),
    );
    const row = appRecordRow(out);

    expect(row.clearedBy).toMatch(/^App record: no bundle id is saved yet, so nothing is registered with Apple; save one with extension_submit \{action: "configure-store", store: "safari", storeSettings: \{bundleId: "<id>"\}\} first\./);
    expect(row.clearedBy.indexOf("configure-store")).toBeLessThan(row.clearedBy.indexOf("Mint signing assets"));
    expect(row.clearedBy).toContain("registers both the app id and its .extension id");
    expect(row.clearedBy).toContain("bundle ID: the one saved on the store settings");
  });

  it("leaves the bring list alone when the app record is already on file", async () => {
    platform.login();
    platform.routes[`POST ${PREFLIGHT}`] = () => ({ body: structuredClone(WALK.safari) });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["safari"], projectPath: project(STORE_MD), api: API }));
    const list = out.value.stores.safari.bringList;

    expect(list.rows.find((row: Row) => row.id === "safari.app_record")).toBeUndefined();
    expect(list.onFile).toBeGreaterThan(0);
    expect(out.value.sayToPerson).not.toContain("App record:");
    expect(out.value.sayToPerson).not.toContain("Mint signing assets");
  });
});
