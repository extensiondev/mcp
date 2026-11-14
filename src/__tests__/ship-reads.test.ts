import { describe, expect, it } from "vitest";

import { tokenRefusal } from "../lib/project-api";
import { handler as status, schema } from "../tools/release-status";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

describe("extension_release_status reads the latest release runs, the Chrome rollout and whether a cut could build", () => {
  const platform = useProjectRoutes("extdev-ship-reads-");

  it("offers runs, rollout and cut as sections", () => {
    expect(schema.inputSchema.properties.include.items.enum).toEqual(["releases", "stores", "history", "runs", "rollout", "cut", "listing"]);
  });
});

describe("a route closed to logins names the one that is open, or the person who can act", () => {
  it.each([
    ["PROMOTE_THROUGH_CLI_ROUTE", "extension_release_promote"],
    ["SUBMIT_THROUGH_CLI_ROUTE", "extension_submit"],
    ["RELEASE_DELETE_NEEDS_A_PERSON", "console"],
    ["CONNECTED_APP_SCOPE", "console"],
  ])("%s", (code, next) => {
    const known = tokenRefusal(code);

    expect(known?.status).toBe("refused");
    expect(known?.hint).toContain(next);
  });
});
