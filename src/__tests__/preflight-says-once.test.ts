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

import { packageBuildLine, type PackageBuildView } from "../lib/package-checks-build";
import { handler as submit } from "../tools/submit-local";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

type Row = Record<string, any>;

const PREFLIGHT = (store: string) => `${PROJECT_ROUTE}/stores/${store}/submissions/preflight`;
const STORES = ["chrome", "firefox", "edge", "safari"] as const;
const WALK: Record<string, Row> = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/preflight-four-stores.json", import.meta.url)), "utf8"));
const TAIL = "the package checks read build c2b67f5; HEAD 9bf4db4 changes docs only and c2b67f5, the newest build, carries the same package; call preflight again with buildSha: \"c2b67f5\".";

function view(store: string, say = `${store}: ${TAIL}`): PackageBuildView {
  return { read: ["c2b67f5"], head: "9bf4db4", say };
}

function edgeMissingTwo(): Record<string, Row> {
  const reports: Record<string, Row> = structuredClone(WALK);
  const edge = reports.edge!;
  const rows = edge.requirements.items as Row[];
  const required = rows.filter((row) => row.required && row.status === "have" && !/credentials|product/.test(row.id)).slice(0, 2);

  for (const row of required) Object.assign(row, { status: "missing", actual: "not on file" });

  edge.requirements.missingRequired = required.length;

  return reports;
}

describe("407: the four-store preflight says each sentence once and hint carries only the next call", () => {
  const platform = useProjectRoutes("extdev-preflight-says-once-");

  it("groups the package sentence by the stores that share it instead of saying it once per store", () => {
    expect(packageBuildLine(STORES.map((store) => view(store)))).toBe(`chrome, firefox, edge and safari: ${TAIL}`);
    expect(packageBuildLine([view("chrome"), null, view("edge", "edge: the package checks read build 1111111; HEAD 9bf4db4 has no platform build yet; push it so the package checks read it.")])).toBe(
      `chrome: ${TAIL} edge: the package checks read build 1111111; HEAD 9bf4db4 has no platform build yet; push it so the package checks read it.`,
    );

    expect(packageBuildLine([null, null])).toBe("");
  });

  it("lists a store's missing inputs once, with the bring list's format and supplier, never a second count sentence", async () => {
    if (process.platform === "win32") return;

    platform.login();
    const reports = edgeMissingTwo();

    for (const store of STORES) platform.routes[`POST ${PREFLIGHT(store)}`] = () => ({ body: reports[store] });

    const out = JSON.parse(await submit({ action: "preflight", browsers: [...STORES], api: API }));
    const said = out.value.sayToPerson as string;
    const missing = (reports.edge!.requirements.items as Row[]).filter((row) => row.status === "missing");

    expect(out.status).toBe("preflight-read");
    expect(missing).toHaveLength(2);
    expect(said.split("Before Edge Add-ons reviews it, bring 2 required inputs.")).toHaveLength(2);
    expect(said).not.toContain("Edge Add-ons asks for 2 required inputs the project does not have yet");

    for (const row of missing) expect(said.split(`${row.label} (`)).toHaveLength(2);
  });

  it("points hint at sayToPerson and names the next call, so the paragraph is in the answer once", async () => {
    if (process.platform === "win32") return;

    platform.login();

    for (const store of STORES) platform.routes[`POST ${PREFLIGHT(store)}`] = () => ({ body: WALK[store] });

    const out = JSON.parse(await submit({ action: "preflight", browsers: [...STORES], buildSha: "c2b67f5", api: API }));
    const said = out.value.sayToPerson as string;

    expect(out.status).toBe("preflight-read");
    expect(out.hint).toBe(
      'Say value.sayToPerson to the person as it is. Next: extension_submit_check {action: "submit", browsers: ["chrome", "firefox", "edge", "safari"], buildSha: "c2b67f5", dryRun: false} asks for the owner\'s approval and executes nothing; extension_submit with the same arguments and that approvalId submits.',
    );

    expect(out.hint.length).toBeLessThan(400);
    expect(said.length).toBeGreaterThan(out.hint.length);
    expect(JSON.stringify(out).split("Every store read here")).toHaveLength(2);

    const sentences = said.split(/(?<=\.)\s+/).filter((sentence) => sentence.length > 40);

    expect(new Set(sentences).size).toBe(sentences.length);
  });

  it("names the failing stores in the hint when nothing can go, and the ready ones when some can", async () => {
    if (process.platform === "win32") return;

    platform.login();
    const reports: Record<string, Row> = structuredClone(WALK);

    for (const store of STORES) {
      const report = reports[store]!;

      report.summary = { ...report.summary, fail: 1, blockingFailures: 1, canSubmit: false };
      report.checks.push({ id: "listing.privacy_policy_url", label: "Privacy policy URL answers", status: "fail", severity: "blocking", stage: "review", message: "https://example.com/privacy answered 404." });
      platform.routes[`POST ${PREFLIGHT(store)}`] = () => ({ body: report });
    }

    const out = JSON.parse(await submit({ action: "preflight", browsers: [...STORES], api: API }));

    expect(out.value.nextStep).toBeNull();
    expect(out.hint).toBe("Say value.sayToPerson to the person as it is. chrome, firefox, edge, safari cannot be submitted until the failing checks pass; fix what they name and call preflight again.");
  });
});
