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
const SHA = "abc1234";
const ID = `apr_${"L".repeat(32)}`;

const mode = (id: string) => ({ id, label: id, description: `${id} mode` });

function project(storeMd?: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-loop-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "widget" }));
  if (storeMd !== undefined) fs.writeFileSync(path.join(root, "STORE.md"), storeMd);

  return root;
}

const AFTER_APPROVAL = "# Widget\n\n## Listing\n\n- Name: Widget\n\n## Safari\n\n- Release: after approval\n";

describe("extension_submit preflight answers what the next release costs in approvals, store by store", () => {
  const platform = useProjectRoutes("extdev-loop-");

  function serve(modes: Partial<Record<string, string>>): void {
    platform.login();

    for (const store of STORES) {
      const report = structuredClone(WALK[store]!);
      if (modes[store]) report.submissionMode = mode(modes[store]!);

      platform.routes[`POST ${PREFLIGHT(store)}`] = () => ({ body: report });
    }
  }

  async function loopOf(root: string | undefined, browsers: readonly string[] = STORES): Promise<Row> {
    const out = JSON.parse(await submit({ action: "preflight", browsers: [...browsers], ...(root ? { projectPath: root } : {}), api: API }));

    return out.value.releaseLoop;
  }

  it("counts three approvals under the least public defaults and names the owner's settings that would fold them, without proposing them", async () => {
    serve({});

    const loop = await loopOf(project());
    const byStore = Object.fromEntries((loop.stores as Row[]).map((entry) => [entry.store, entry]));

    expect(loop.approvals).toBe(3);
    expect(loop.oneApproval).toBe(false);
    expect(byStore.chrome).toEqual({ store: "chrome", mode: "draft-until-public", defaultMode: true, lands: "draft", then: ["publish"], fold: { submissionMode: "public" } });
    expect(byStore.edge).toMatchObject({ mode: "draft", lands: "draft", then: ["publish"], fold: { submissionMode: "review" } });
    expect(byStore.firefox).toEqual({ store: "firefox", mode: "unlisted", defaultMode: true, lands: "signed-unlisted" });
    expect(byStore.safari).toMatchObject({ lands: "testflight", then: ["publish", "release"], fold: { submissionMode: "review", storeMd: "- Release: after approval" } });
    expect(loop.foldCall).toContain('extension_submit_check {action: "configure-store"');
    expect(loop.say).toMatch(/^Under the saved settings the next release costs 3 owner approvals: Chrome stops at a draft, then publish;/);
    expect(loop.say).toContain("so it is the owner's choice and never made for them");
    expect(loop.watch).toContain('extension_release_status {include: ["stores"]}');
    expect(loop.say).not.toContain("configure-store");
  });

  it("reads one approval when every store's saved mode reaches review and STORE.md lets Apple's approval release, and the real submit asks exactly that one", async () => {
    serve({ chrome: "public", edge: "review", firefox: "listed", safari: "review" });

    const loop = await loopOf(project(AFTER_APPROVAL));

    expect(loop.approvals).toBe(1);
    expect(loop.oneApproval).toBe(true);
    expect((loop.stores as Row[]).every((entry) => !entry.then && !entry.fold && !entry.defaultMode)).toBe(true);
    expect(loop.foldCall).toBeUndefined();
    expect(loop.say).toContain("Every store's act is on that one approval, one line per store.");

    platform.routes["POST /api/cli/approvals"] = () => ({
      status: 201,
      body: { approvalId: ID, approvalUrl: `${API}/device/approve/${ID}`, expiresAt: new Date(Date.now() + 3600_000).toISOString(), lines: [] },
    });

    await submit({ browsers: [...STORES], buildSha: SHA, dryRun: false, version: "2.0.0", api: API });

    const minted = platform.sent("POST", "/api/cli/approvals");

    expect(minted).toHaveLength(1);
    expect(minted[0].body.scope.acts).toEqual(["chrome:upload", "edge:upload", "firefox:upload", "safari:publish", "safari:upload"]);
    expect(platform.sent("POST", "/api/cli/stores/submit").map((call) => call.body.dryRun)).toEqual([true]);
  });

  it("keeps the release act when Safari reaches review but STORE.md holds the release", async () => {
    serve({ chrome: "public", edge: "review", firefox: "listed", safari: "review" });

    const loop = await loopOf(project("# Widget\n\n## Safari\n\n- Release: manual\n"));
    const safari = (loop.stores as Row[]).find((entry) => entry.store === "safari")!;

    expect(loop.approvals).toBe(2);
    expect(safari).toEqual({ store: "safari", mode: "review", lands: "review", then: ["release"], fold: { storeMd: "- Release: after approval" } });
  });

  it("counts one publish approval for every draft store together, and nothing for a dry-run store", async () => {
    serve({ chrome: "draft-until-public", edge: "draft", firefox: "dry-run" });

    const loop = await loopOf(project(), ["chrome", "edge", "firefox"]);

    expect(loop.approvals).toBe(2);
    expect((loop.stores as Row[]).find((entry) => entry.store === "firefox")).toMatchObject({ lands: "nothing-sent" });

    serve({ chrome: "dry-run" });

    const none = await loopOf(project(), ["chrome"]);

    expect(none.approvals).toBe(0);
    expect(none.oneApproval).toBe(false);
    expect(none.say).toMatch(/^Under the saved settings the next release sends nothing:/);
  });

  it("answers the loop for the stores that can submit and names the locked store and its reason, in the loop's say line", async () => {
    serve({});

    const locked = structuredClone(WALK.safari!);
    locked.summary = { ...locked.summary, blockingFailures: 1, canSubmit: false };
    locked.checks = [...(locked.checks ?? []), { id: "store.safari_app_review_lock", label: "App Review lock", status: "locked", severity: "blocking", stage: "review", message: "Apple is reviewing 0.3.0 (build 18)." }];
    platform.routes[`POST ${PREFLIGHT("safari")}`] = () => ({ body: locked });

    const loop = await loopOf(project());

    expect((loop.stores as Row[]).map((entry) => entry.store)).toEqual(["chrome", "edge", "firefox"]);
    expect(loop.excluded).toEqual([{ store: "safari", reason: "Apple is reviewing 0.3.0 (build 18)" }]);
    expect(loop.approvals).toBe(2);
    expect(loop.say).toMatch(/^Under the saved settings the next release costs 2 owner approvals: Chrome stops at a draft, then publish;/);
    expect(loop.say).toContain("Safari is left out of this count until it can submit: Apple is reviewing 0.3.0 (build 18).");
    expect(loop.say).not.toContain("Safari stops");

    const blocked = structuredClone(WALK.chrome!);
    blocked.summary = { ...blocked.summary, fail: 1, blockingFailures: 1, canSubmit: false };
    for (const store of ["chrome", "edge", "firefox", "safari"]) platform.routes[`POST ${PREFLIGHT(store)}`] = () => ({ body: store === "safari" ? locked : blocked });

    expect(await loopOf(project())).toBeUndefined();
  });
});
