import { describe, expect, it } from "vitest";

import { schema as createSchema } from "../tools/project-create";
import { handler as workspace, schema } from "../tools/workspace";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const GENERAL = `${PROJECT_ROUTE}/settings/general`;
const APPROVALS = "/api/cli/approvals";
const STORED = { displayName: "Widget", displayNameSource: { kind: "build", sha: "0c7471e" }, description: "Does things", url: "", supportUrl: "", visibility: "private", liveChannel: null };

describe("an existing project is renamed through extension_workspace configure-project, keeping its slug", () => {
  const platform = useProjectRoutes("extdev-project-rename-");

  it("names the rename path where a tool search for a rename lands, and the create tool points there instead of a second create", () => {
    const props = schema.inputSchema.properties as unknown as Record<string, { description?: string }>;
    const createProps = createSchema.inputSchema.properties as unknown as Record<string, { description?: string }>;

    expect(schema.description).toContain("renames a project (displayName; slug and URLs stay)");
    expect(props.settings.description).toContain("displayName renames the project");
    expect(createProps.displayName.description).toContain("extension_workspace_configure configure-project");
  });
});
