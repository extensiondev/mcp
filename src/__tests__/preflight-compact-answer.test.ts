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

import { handler as submit } from "../tools/submit";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

type Row = Record<string, any>;

const PREFLIGHT = (store: string) => `${PROJECT_ROUTE}/stores/${store}/submissions/preflight`;
const STORES = ["chrome", "firefox", "edge", "safari"] as const;
const BUDGET = 20_000;
const WALK: Record<string, Row> = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/preflight-four-stores.json", import.meta.url)), "utf8"));

function serve(platform: ReturnType<typeof useProjectRoutes>, reports: Record<string, Row>): void {
  platform.login();

  for (const store of STORES) platform.routes[`POST ${PREFLIGHT(store)}`] = () => ({ body: reports[store] });
}

function blockedChrome(): Record<string, Row> {
  const reports: Record<string, Row> = structuredClone(WALK);
  const chrome = reports.chrome!;

  chrome.summary = { ...chrome.summary, fail: 1, blockingFailures: 1, canSubmit: false };
  chrome.checks.push({ id: "listing.privacy_policy_url", label: "Privacy policy URL answers", status: "fail", severity: "blocking", stage: "review", message: "https://example.com/privacy answered 404." });
  chrome.requirements.items[2] = { ...chrome.requirements.items[2], status: "missing", actual: "no title on file" };
  chrome.requirements.missingRequired = 1;

  return reports;
}

describe("extension_submit preflight answers four stores in a few KB unless detail asks for more", () => {
  const platform = useProjectRoutes("extdev-preflight-compact-");

  it("answers an all-green four-store preflight of the walk's size under the budget, counting the rows on file", async () => {
    serve(platform, WALK);

    const raw = await submit({ action: "preflight", browsers: [...STORES], api: API });
    const out = JSON.parse(raw);

    expect(out.status).toBe("preflight-read");
    expect(raw.length).toBeLessThan(BUDGET);
    expect(out.value.detail).toContain("detail: true answers every row in full");

    for (const store of STORES) {
      const view = out.value.stores[store];
      const listed = WALK[store]!.requirements.items as Row[];
      const onFile = listed.filter((row) => row.status === "have").length;

      expect(view.canSubmit).toBe(true);
      expect(view.requirements.onFile).toBe(onFile);
      expect(view.requirements.items).toHaveLength(listed.length - onFile);
      expect(view.requirements.items.some((row: Row) => row.status === "have")).toBe(false);
      expect(view.bringList.onFile).toBe(onFile);
      expect(view.warnings).toEqual(WALK[store]!.checks.filter((check: Row) => check.status === "warn").map((check: Row) => expect.objectContaining({ id: check.id, message: check.message })));
    }

    const unknown = out.value.stores.chrome.requirements.items.find((row: Row) => row.id === "chrome.description");

    expect(unknown).toEqual({ id: "chrome.description", label: "Description", required: true, status: "unknown", dashboardTab: expect.any(String) });
    expect(out.value.stores.safari.requirements.items.find((row: Row) => row.status === "missing")).toMatchObject({ format: expect.any(String), how: expect.stringContaining("STORE.md"), docs: expect.any(String) });
    expect(out.value.sayToPerson).toContain("Every store read here");
  });

  it("keeps a blocked store's failing check and missing row whole, with its fix, and stays under the budget", async () => {
    serve(platform, blockedChrome());

    const raw = await submit({ action: "preflight", browsers: [...STORES], api: API });
    const out = JSON.parse(raw);
    const chrome = out.value.stores.chrome;

    expect(raw.length).toBeLessThan(BUDGET);
    expect(chrome.canSubmit).toBe(false);
    expect(chrome.failing).toEqual([expect.objectContaining({ id: "listing.privacy_policy_url", message: "https://example.com/privacy answered 404." })]);
    expect(chrome.requirements.items.find((row: Row) => row.id === "chrome.title")).toMatchObject({ status: "missing", format: expect.any(String), how: expect.stringContaining("`- Name:`"), actual: "no title on file" });
    expect(out.value.sayToPerson).toContain("chrome cannot be submitted yet");
  });

  it("answers every row with detail: true, and only the stores and requirement ids a detail list names", async () => {
    serve(platform, WALK);

    const full = JSON.parse(await submit({ action: "preflight", browsers: [...STORES], detail: true, api: API }));

    expect(full.value.detail).toBeUndefined();

    for (const store of STORES) expect(full.value.stores[store].requirements.items).toHaveLength(WALK[store]!.requirements.items.length);

    const some = JSON.parse(await submit({ action: "preflight", browsers: [...STORES], detail: ["firefox", "chrome.title", "chrome.description"], api: API }));
    const chromeIds = some.value.stores.chrome.requirements.items.map((row: Row) => row.id);

    expect(some.value.stores.firefox.requirements.items).toHaveLength(WALK.firefox!.requirements.items.length);
    expect(some.value.stores.edge.requirements.items.length).toBeLessThan(WALK.edge!.requirements.items.length);
    expect(chromeIds).toContain("chrome.title");
    expect(chromeIds).not.toContain("chrome.summary");
    expect(some.value.stores.chrome.requirements.items.find((row: Row) => row.id === "chrome.description")).toHaveProperty("how");
  });

  it("refuses a detail that is neither true nor a list of names before anything is sent", async () => {
    serve(platform, WALK);

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["chrome"], detail: 3, api: API }));

    expect(out.ok).toBe(false);
    expect(out.error.name).toBe("PreflightInputError");
    expect(platform.calls.some((call) => call.path.includes("/submissions/preflight"))).toBe(false);
  });
});
