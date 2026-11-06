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
    expect(createProps.displayName.description).toContain("extension_workspace configure-project");
  });

  it("sends only the new name as a plain call and says what the rename changes and what it keeps", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`GET ${GENERAL}`] = () => ({ body: STORED });
    platform.routes[`PUT ${GENERAL}`] = () => ({ body: { ok: true } });

    const out = JSON.parse(await workspace({ action: "configure-project", settings: { displayName: "Lance" }, api: API }));

    expect(out.ok).toBe(true);
    expect(out.status).toBe("project-configured");
    expect(platform.sent("PUT", GENERAL).map((call) => call.body)).toEqual([{ displayName: "Lance" }]);
    expect(platform.sent("POST", APPROVALS)).toHaveLength(0);
    expect(out.value.rename).toMatchObject({ from: "Widget", to: "Lance", slug: "acme/widget" });
    expect(out.value.rename.changes.join(" ")).toContain("a later build's manifest name no longer replaces it");
    expect(out.value.rename.unchanged.join(" ")).toContain("the slug acme/widget");
    expect(out.hint).toContain('Renamed "Widget" to "Lance" on extension.dev');
    expect(out.hint).toContain("It does not change the slug acme/widget");
    expect(out.value.trackUrl).toMatch(/\/acme\/widget\/project-settings\/general$/);
  });

  it("carries no rename when only the description changes or the write is refused", async () => {
    if (process.platform === "win32") return;

    platform.login();
    platform.routes[`GET ${GENERAL}`] = () => ({ body: STORED });
    platform.routes[`PUT ${GENERAL}`] = () => ({ body: { ok: true } });

    const described = JSON.parse(await workspace({ action: "configure-project", settings: { description: "Does more" }, api: API }));

    expect(described.ok).toBe(true);
    expect(described.value.rename).toBeUndefined();
    expect(described.hint).not.toContain("Renamed");

    platform.routes[`PUT ${GENERAL}`] = () => ({ status: 403, body: { code: "OWNER_REQUIRED", message: "This is a workspace owner action." } });

    const refused = JSON.parse(await workspace({ action: "configure-project", settings: { displayName: "Lance" }, api: API }));

    expect(refused.ok).toBe(false);
    expect(refused.error.platformCode).toBe("OWNER_REQUIRED");
    expect(JSON.stringify(refused)).not.toContain("Renamed");
  });
});
