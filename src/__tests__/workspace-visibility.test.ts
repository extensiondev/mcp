import { describe, expect, it } from "vitest";

import { actionFingerprint } from "../lib/approval-gate";
import { handler as workspace, schema } from "../tools/workspace";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const VISIBILITY = `${PROJECT_ROUTE}/visibility`;
const APPROVALS = "/api/cli/approvals";

const PUBLISHED = { indexPublished: true, metaRepublished: true, channelsRewritten: true, exposurePublished: true };


describe("extension_workspace set-visibility makes a project private as a plain call and keeps public on the approve page", () => {
  const platform = useProjectRoutes("extdev-workspace-visibility-");

  it("names set-visibility with its visibility and approvalId inputs", () => {
    const properties = schema.inputSchema.properties as Record<string, any>;

    expect(schema.inputSchema.properties.action.enum).toContain("set-visibility");
    expect(properties.visibility.enum).toEqual(["private", "public"]);
    expect(properties.visibility.description).toMatch(/plain call under the owner's own token/);
    expect(properties.visibility.description).toMatch(/approve page/);
    expect(properties.approvalId.description).toContain("set-visibility public");
    expect(schema.description).toContain("set-visibility");
    expect(schema.description).not.toContain("This is read-only");
  });
});
