// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { describe, expect, it } from "vitest";

import { handler as submit } from "../tools/submit";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const SAFARI_PUBLISH = `${PROJECT_ROUTE}/stores/safari/publish`;
const APPROVALS = "/api/cli/approvals";
const ID = `apr_${"V".repeat(32)}`;

describe("a Safari publish covered by the version approval's own line (ledger 324)", () => {
  const platform = useProjectRoutes("extdev-safari-publish-covered-");

  it("sends the version approvalId, asks no second approval and names the line that covered it", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${SAFARI_PUBLISH}`] = () => ({
      body: {
        ok: true,
        dispatched: true,
        status: "publishing",
        store: "safari",
        submissionId: "sub_s",
        version: "1.4.0",
        buildId: "abc1234",
        dispatchedAt: "2026-10-31T16:00:00.000Z",
        trackUrl: `${API}/acme/widget/submissions/safari/sub_s`,
        approvalId: ID,
        lines: [{ id: "safari:publish", store: "safari", act: "publish", state: "spent" }],
      },
    });

    const out = JSON.parse(await submit({ action: "publish", browsers: ["safari"], approvalId: ID, waitSeconds: 0, api: API }));
    const [sent] = platform.sent("POST", SAFARI_PUBLISH);

    expect(sent.body).toEqual({ approvalId: ID });
    expect(platform.sent("POST", APPROVALS)).toHaveLength(0);
    expect(out.ok).toBe(true);
    expect(out.status).toBe("publish-dispatched");
    expect(out.value.approvalCovered).toEqual({ approvalId: ID, line: "safari:publish" });
    expect(out.value.lines).toEqual([{ id: "safari:publish", store: "safari", act: "publish", state: "spent" }]);
    expect(out.hint).toContain(`The publish line of version approval ${ID} covered this send, so no second approval was asked.`);
  });

  it("says nothing about a covering line when the platform answers no lines", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`POST ${SAFARI_PUBLISH}`] = () => ({
      body: { ok: true, dispatched: true, status: "publishing", store: "safari", submissionId: "sub_s", dispatchedAt: "2026-10-31T16:00:00.000Z" },
    });

    const out = JSON.parse(await submit({ action: "publish", browsers: ["safari"], approvalId: "apr_single", waitSeconds: 0, api: API }));

    expect(out.value.approvalCovered).toBeUndefined();
    expect(out.value.lines).toBeUndefined();
    expect(out.hint).not.toContain("covered this send");
  });
});
