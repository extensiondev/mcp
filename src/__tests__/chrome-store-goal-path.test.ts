// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { describe, expect, it } from "vitest";

import { serverInstructions } from "../index";
import { actionFingerprint } from "../lib/approval-gate";
import {
  WORLD_API,
  WORLD_PROJECT_ID,
  usePlatformWorld,
  type World,
} from "./fixtures/platform-world";

type Row = Record<string, unknown>;

const PREFLIGHT = new RegExp(
  `^POST /api/projects/${WORLD_PROJECT_ID}/stores/chrome/submissions/preflight$`,
);
const SUBMIT = /^POST \/api\/cli\/stores\/submit$/;
const APPROVALS = /^POST \/api\/cli\/approvals$/;
const SETTINGS =
  "http://console.extension.localhost/acme/widget/project-settings/stores";
const CONNECT = `${SETTINGS}?connect=chrome`;
const LINK_ITEM = `${SETTINGS}?connect=chrome&link=item`;
const NEW_ITEM = "https://chrome.google.com/webstore/devconsole";
const PACKAGE = `${WORLD_API}/api/projects/${WORLD_PROJECT_ID}/builds/603fc8a/chrome.zip`;
const ITEM_URL =
  "https://chrome.google.com/webstore/devconsole/pub-1/abcdefghijklmnopabcdefghijklmnop/edit";
const LEAK =
  "STORE_CHROME_CLIENT_ID, STORE_CHROME_CLIENT_SECRET and STORE_CHROME_REFRESH_TOKEN are missing.";
const SECRET_NAMES =
  /STORE_(CHROME|EDGE|FIREFOX|SAFARI)_|CHROME_CLIENT|CLIENT_SECRET|CLIENT_ID|REFRESH_TOKEN|SERVICE_ACCOUNT|API_SECRET/;
const PREFLIGHT_ARGS = {
  action: "preflight",
  browsers: ["chrome"],
  api: WORLD_API,
};
const SUBMIT_ARGS = {
  action: "submit",
  browsers: ["chrome"],
  buildSha: "603fc8a",
  dryRun: false,
  api: WORLD_API,
};

function readiness(connection: Row): Row {
  const green =
    Boolean(connection.kind) &&
    connection.healthy === true &&
    connection.itemLinked !== false;

  return {
    store: "chrome",
    summary: { pass: 8, warn: 0, fail: green ? 0 : 1, canSubmit: green },
    checks: [
      {
        id: "credentials",
        label: "Store credentials",
        status: green ? "pass" : "fail",
        severity: "blocking",
        message: green ? "" : LEAK,
      },
    ],
    connection,
  };
}

function answers(world: World, connection: Row): void {
  world.routes.push([PREFLIGHT, () => ({ body: readiness(connection) })]);
}

function walked(out: any, status: string, kind: string): void {
  const context = JSON.stringify(out).slice(0, 3000);

  expect(out.status, context).toBe(status);
  expect(out.value?.nextStep?.kind, context).toBe(kind);
  expect(typeof out.value.nextStep.say, context).toBe("string");
  expect(out.value.nextStep.say.length, context).toBeGreaterThan(0);
  expect(out.value.trackUrl, context).toMatch(/^https?:\/\//);
  expect(JSON.stringify(out), context).not.toMatch(SECRET_NAMES);
}

describe("the server instructions carry the Chrome Web Store goal playbook in order", () => {
  it("names the seven steps in order, under fifteen lines, beside the extension.dev-first rule", () => {
    const text = serverInstructions({
      features: ["local", "platform"],
      noShip: false,
    });
    const lines = text.split("\n");
    const start = lines.findIndex((line) =>
      line.startsWith("Chrome Web Store goal:"),
    );
    const playbook = lines.slice(start, start + 8);
    const steps = [
      "1. Call extension_submit_check {action:'preflight', browsers:['chrome']} first, every time, even on a retry.",
      "2. On store-not-connected or store-connection-failed",
      "3. On store-item-not-linked",
      "4. On preflight-read whose value.stores.chrome.storeMd says the privacy policy URL is not in STORE.md, say that line as it is and stop",
      "5. On preflight-read with every check green, call extension_submit_check {action:'submit', browsers:['chrome']",
      "6. On submitted, or submit-dispatched while the record has not confirmed the upload yet, report the status line and value.trackUrl (value.itemUrl, the store's own page, is information, never a next step), and say value.nextStep.say: To send it to review, say publish; that is one more approval. When the person says publish or send it to review, call extension_submit_check {action:'publish', browsers:['chrome']}, which only asks for the approval",
      "7. Never recommend a release on a code host, an unlisted AMO version, a TestFlight upload or any other do-it-yourself route first, and never name a secret.",
    ];

    expect(start).toBeGreaterThan(-1);
    expect(playbook.length).toBeLessThan(15);

    let at = text.indexOf("Chrome Web Store goal:");

    for (const step of steps) {
      const next = text.indexOf(step, at);

      expect(next, step).toBeGreaterThan(at);
      at = next;
    }

    expect(playbook.join("\n")).toContain("value.nextStep");
    expect(playbook[6]).toContain(
      "To send it to review, say publish; that is one more approval.",
    );

    expect(playbook[6]).toMatch(
      /action:'publish'.*approvalId.*in-review.*value\.trackUrl/,
    );

    expect(playbook[6]).toContain(
      "value.itemUrl, the store's own page, is information, never a next step",
    );

    expect(playbook[6]).not.toMatch(/report value\.trackUrl, value\.itemUrl/);
    expect(playbook[6]).toContain(
      "value.outcome {recorded, status, storeState, checkedAt, source}",
    );

    expect(playbook[6]).toContain(
      "value.links [{kind, url, audience, expiresAt, made}]",
    );

    expect(playbook[6]).toContain(
      "on publish-dispatched (recorded false) say the platform accepted the publish and its record has not confirmed Chrome's answer yet",
    );

    expect(playbook[5]).toMatch(
      /approval-required.*value\.approvalUrl.*value\.expiresAt.*approvalId/,
    );

    expect(playbook[4]).toContain(
      "the privacy policy URL is the developer's own public address, written in STORE.md as - Privacy policy URL: <address>",
    );

    expect(playbook[4]).toContain("never say a store accepts it");

    expect(playbook[4]).not.toMatch(/accepted/);
    expect(text).toMatch(
      /extension\.dev comes first: never offer a release on a code host/,
    );

    expect(playbook.join("\n")).not.toMatch(SECRET_NAMES);
    expect(serverInstructions()).not.toContain("Chrome Web Store goal:");
  });
});
