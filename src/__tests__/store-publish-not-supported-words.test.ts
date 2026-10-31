import { describe, expect, it } from "vitest";

import { PUBLISH_BROWSERS_WORDS, PUBLISH_STORES, shipRefusalHint } from "../lib/ship-act";
import { handler as submit } from "../tools/submit";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const EDGE_PUBLISH = `${PROJECT_ROUTE}/stores/edge/publish`;
const APPROVALS = "/api/cli/approvals";

describe("the publish store refusal names the stores that take publish", () => {
  it("names Chrome, Edge and Safari with their browsers values and says what Firefox does instead", () => {
    const hint = shipRefusalHint("PUBLISH_STORE_NOT_SUPPORTED") ?? "";

    expect(hint).toContain("Sending a draft to review is a Chrome, Edge or Safari act here");
    expect(hint).toContain('call publish with browsers ["chrome"], ["edge"] or ["safari"]');
    expect(hint).toContain("Firefox has no publish act; AMO reviews a Firefox version when it is submitted.");
    expect(hint).not.toContain("the other stores");
    expect(hint).not.toContain("Chrome Web Store act");
  });

  it("refuses a publish naming a store off the list with the browsers values the hint names, from the one list", async () => {
    const out = JSON.parse(await submit({ action: "publish", browsers: ["firefox"], api: API }));
    const hint = shipRefusalHint("PUBLISH_STORE_NOT_SUPPORTED") ?? "";

    expect(out.error).toMatchObject({ code: "E_BAD_REQUEST", name: "PublishInputError" });
    expect(out.error.message).toContain(`browsers must be ${PUBLISH_BROWSERS_WORDS}, or several of them with buildSha`);
    expect(hint).toContain(`call publish with browsers ${PUBLISH_BROWSERS_WORDS}.`);
    expect(out.error.message).toContain('got ["firefox"]. Firefox enters review when it is submitted. Nothing was sent.');
    expect(PUBLISH_STORES).toEqual(["chrome", "edge", "safari"]);
  });

  describe("through extension_submit publish", () => {
    const platform = useProjectRoutes("extdev-publish-store-words-");

    it("relays the platform's refusal with the new words and asks for no approval", async () => {
      if (process.platform === "win32") return;

      platform.login();
      platform.routes[`POST ${EDGE_PUBLISH}`] = () => ({
        status: 400,
        body: {
          code: "PUBLISH_STORE_NOT_SUPPORTED",
          message: "Sending a draft to review is a Chrome Web Store, Edge Add-ons or App Store action. Firefox submissions go to review when they are submitted.",
          refusedBeforeApproval: true,
        },
      });

      const out = JSON.parse(await submit({ action: "publish", browsers: ["edge"], api: API }));

      expect(platform.sent("POST", APPROVALS)).toHaveLength(0);
      expect(out.error.code).toBe("E_BAD_REQUEST");
      expect(out.hint).toContain("Chrome, Edge or Safari act here");
      expect(out.hint).toContain("AMO reviews a Firefox version when it is submitted");
      expect(out.hint).not.toContain("the other stores");
    });
  });
});
