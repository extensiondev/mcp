
import { describe, it, expect } from "vitest";

import { schema as authSchema } from "../tools/auth";
import { schema as createSchema } from "../tools/project-create";
import { createRateLimitNote } from "../lib/project-batch";
import { laneClosedFacts, laneClosedHint, platformHoldMessage } from "../lib/platform-hold";
import { pollDeviceGrant } from "../lib/device-flow";

describe("the auth and create tools describe what the platform does", () => {
  it("auth status names the statuses it emits, and create names who approves", () => {
    expect(authSchema.description).toMatch(/value\.tokenCheck\.verdict is confirmed, refused or unavailable/);
    expect(createSchema.description).toMatch(/a signed-in workspace member approves/);
  });

  it("create says the platform runs the stored build command as it is, and reads it from the project when it is left out", () => {
    const buildCommand = createSchema.inputSchema.properties.buildCommand;
    expect(buildCommand).not.toHaveProperty("default");
    expect(buildCommand.description).toMatch(/Left out, the platform reads it from the project/);
    expect(buildCommand.description).toMatch(/as it is/);
    expect(buildCommand.description).toMatch(/does not add --browser/);
    expect(createSchema.description).toMatch(/exactly as stored/);
  });

  it("the lane hint defers to the platform's message and names the hold's console state", () => {
    const open = laneClosedHint({ subject: "project", message: "Headless project creation is not open on this host yet." });
    expect(open).toMatch(/its own message above says why/);
    expect(open).toMatch(/Create the project in the console/);

    const held = laneClosedHint({ subject: "project", message: "extension.dev is not open to the public yet." });
    expect(held).not.toMatch(/this workspace is not on it, so the console is the route/);
    expect(held).toMatch(/console answers its gate page/);
  });

  it("a lane closed for this account names who can create instead and never the console", () => {
    const prefill = { project: "acme/ghost-app" };
    const message =
      "Creating projects from a terminal is open only to invited accounts for now, and stranger is not one of them. An invited member of acme can create projects there instead.";
    const hint = laneClosedHint({ subject: "project", message, prefill });

    expect(hint).toMatch(/closed headless project creation for this account/);
    expect(hint).toMatch(/an invited member of acme/);
    expect(hint).not.toMatch(/a workspace this account may create in/);
    expect(hint).not.toMatch(/console/i);
    expect(laneClosedFacts({ message, prefill })).not.toHaveProperty("consoleUrl");
    expect(laneClosedFacts({ message, prefill })).not.toHaveProperty("createUrl");

    const reviewer = laneClosedHint({
      subject: "projects",
      message: "walk-reviewer is the review account, which creates projects only in its own workspace, walk-reviewer. Start again from your terminal with walk-reviewer as the workspace.",
    });
    expect(reviewer).not.toMatch(/console/i);

    const workspace = laneClosedHint({
      subject: "workspace",
      message: "Creating workspaces from a terminal is open only to invited accounts for now, and stranger is not one of them. An invited account can create the workspace instead.",
    });
    expect(workspace).toMatch(/an invited account/);
    expect(workspace).not.toMatch(/console/i);
  });

  it("1042: the platform's closedFor field names an account refusal whatever its sentence says", () => {
    const prefill = { project: "acme/ghost-app" };
    const reworded = "This login may not create projects from a terminal yet.";
    const hint = laneClosedHint({ subject: "project", message: reworded, closedFor: "account", prefill });

    expect(hint).toMatch(/closed headless project creation for this account/);
    expect(hint).not.toMatch(/console/i);
    expect(laneClosedFacts({ message: reworded, closedFor: "account", prefill })).not.toHaveProperty("consoleUrl");
    expect(laneClosedHint({ subject: "project", message: reworded, prefill })).toMatch(/Create the project in the console/);
  });

  it("1049: the review account is sent back to its own workspace, by closedFor or by the sentence", () => {
    const project = "walk-reviewer is the review account, which creates projects only in its own workspace, walk-reviewer. Start again from your terminal with walk-reviewer as the workspace.";
    const workspace = "walk-reviewer is the review account, which cannot create workspaces. It creates projects only in its own workspace, walk-reviewer.";

    for (const closedFor of ["review-account", undefined]) {
      const single = laneClosedHint({ subject: "project", message: project, closedFor, prefill: { project: "acme/ghost-app" } });
      expect(single, String(closedFor)).toMatch(/extension_project_create again with project "walk-reviewer\/ghost-app"/);
      expect(single).not.toMatch(/invited member|console/i);

      const list = laneClosedHint({ subject: "projects", message: project, closedFor, workspace: "acme" });
      expect(list).toMatch(/every project under walk-reviewer\//);
      expect(list).not.toMatch(/invited member/);

      const team = laneClosedHint({ subject: "workspace", message: workspace, closedFor });
      expect(team).toMatch(/extension_project_create with a project under walk-reviewer\//);
      expect(team).not.toMatch(/invited account/);
    }

    expect(laneClosedFacts({ message: "reworded", closedFor: "review-account" })).not.toHaveProperty("consoleUrl");

    const reworded = "This login is for directory review and creates projects only in its own workspace, walk-reviewer.";
    expect(laneClosedHint({ subject: "project", message: reworded, closedFor: "review-account", prefill: { project: "acme/ghost-app" } }))
      .toMatch(/extension_project_create again with project "walk-reviewer\/ghost-app"/);
  });

  it("1046: an account refusal for a list names its workspace and gives one next step", () => {
    const hint = laneClosedHint({ subject: "projects", message: "closed", closedFor: "account", workspace: "acme" });

    expect(hint).toMatch(/Only an invited member of acme can create them there/);
    expect(hint).not.toMatch(/the workspace\b/);
    expect(hint).not.toMatch(/, or run the create again/);
  });

  it("the rate note says what the platform counts", () => {
    const note = createRateLimitNote();
    expect(note).toMatch(/counted before the existence check/);
  });

  it("the hold sentence lists approvals and workspace create among what is closed, and claims no 'free forever'", () => {
    const text = platformHoldMessage({});
    expect(text).toMatch(/requesting an approval/);
    expect(text).toMatch(/project or workspace/);
    expect(text).not.toMatch(/free forever/);
  });

  it("an expired_token answer carries the platform's own sentence", async () => {
    const result = await pollDeviceGrant({
      apiBase: "https://api.test",
      path: "/api/cli/device/token",
      project: "acme/widget",
      deviceCode: "d",
      interval: 1,
      budgetMs: 500,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: "expired_token", error_description: "The device code has expired or is unknown. Start login again." }), { status: 400, headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect((result as { reason: string; message?: string }).reason).toBe("expired");
    expect((result as { message?: string }).message).toMatch(/expired or is unknown/);
  });
});
