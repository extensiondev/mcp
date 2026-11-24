import { describe, expect, it } from "vitest";

import { serverInstructions } from "../index";
import { trackFields } from "../lib/track-url";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const PREFLIGHT = `${PROJECT_ROUTE}/stores/chrome/submissions/preflight`;
const SUBMIT = "/api/cli/stores/submit";
const APPROVALS = "/api/cli/approvals";
const SETTINGS = "http://console.extension.localhost/acme/widget/project-settings/stores";
const CONNECT = `${SETTINGS}?connect=chrome`;
const SECRET_NAMES = /STORE_(CHROME|EDGE|FIREFOX|SAFARI)_|CHROME_CLIENT|CLIENT_SECRET|CLIENT_ID|REFRESH_TOKEN|SERVICE_ACCOUNT|API_SECRET/;
const SENTENCES = (url: string) =>
  `Connect your Chrome Web Store account once at ${url}; Google asks for one click. Then I upload it as a draft that is not published, and nothing goes to review until you publish; the item's visibility (public or unlisted) is set once in the Chrome Web Store dashboard, since no store API sets it.`;

const NEW_ITEM = "https://chrome.google.com/webstore/devconsole";
const PACKAGE = "http://localhost:3100/api/projects/prj_probe/builds/b418732/chrome.zip";
const LINK_ITEM = `${SETTINGS}?connect=chrome&link=item`;
const LINK_SENTENCES = `One step is yours, once: create the item in the Chrome Web Store dashboard at ${NEW_ITEM}. Download chrome.zip of build b418732 at ${PACKAGE}, or let me save it with extension_builds_download (action: "download", buildId: "b418732", browser: "chrome"); upload it once as the item's first package. Every later platform upload carries the store version <manifest version>.<n>, numbered by the platform. Then fill its Store listing and Privacy tabs there (your synced listing text is on the extension.dev store settings page to copy) and paste the item's dashboard address at ${LINK_ITEM}. After that I upload every build as a draft that is not published, and nothing goes to review until you publish; set the item's visibility (public or unlisted) once in that dashboard, since no store API sets it.`;

function readiness(connection: Record<string, unknown> | null, extra: Record<string, unknown> = {}) {
  return {
    store: "chrome",
    summary: { pass: 8, warn: 0, fail: connection?.kind ? 0 : 1, canSubmit: Boolean(connection?.kind && connection.healthy) },
    checks: [
      {
        id: "credentials",
        label: "Store credentials",
        status: connection?.kind ? "pass" : "fail",
        severity: "blocking",
        message: connection?.kind ? "" : "STORE_CHROME_CLIENT_ID, STORE_CHROME_CLIENT_SECRET and STORE_CHROME_REFRESH_TOKEN are missing.",
      },
    ],
    ...(connection ? { connection } : {}),
    ...extra,
  };
}

function sentenceCount(text: string): number {
  return text.split(/(?<=[.!?])\s+(?=[A-Z])/).filter(Boolean).length;
}

describe("the server instructions send a store ask through preflight, connect and a draft", () => {
  it("names preflight first, then the connect link, then a draft submit, with no order steering away from other routes", () => {
    const text = serverInstructions({ features: ["local", "platform"], noShip: false });
    const line = text.split("\n").find((row) => row.startsWith("When the ask is to publish to the Chrome Web Store")) ?? "";

    expect(line.indexOf("action:'preflight'")).toBeGreaterThan(-1);
    expect(line.indexOf("action:'preflight'")).toBeLessThan(line.indexOf("value.connectUrl"));
    expect(line.indexOf("value.connectUrl")).toBeLessThan(line.indexOf("as a draft"));
    expect(line).not.toMatch(/never offer/);
    expect(line).not.toMatch(SECRET_NAMES);
    expect(serverInstructions()).not.toContain("Chrome Web Store, the first call");
  });
});
