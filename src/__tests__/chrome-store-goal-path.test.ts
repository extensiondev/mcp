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
import { LINK_ITEM_POINTER } from "../lib/link-item-answer";
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

describe("the Chrome Web Store goal walks from not connected to submitted with a machine-readable next step", () => {
  const world = usePlatformWorld("extdev-chrome-goal-");

  it("1. not connected: preflight answers store-not-connected and nextStep connect at the connect link", async () => {
    if (process.platform === "win32") return;

    world.login();
    answers(world, {
      kind: null,
      connectedAs: null,
      healthy: null,
      itemId: null,
      connectUrl: CONNECT,
    });

    const out = await world.call("extension_submit", PREFLIGHT_ARGS);

    walked(out, "store-not-connected", "connect");
    expect(out.value.nextStep).toEqual({
      kind: "connect",
      say: out.hint,
      url: CONNECT,
      thenCall: {
        tool: "extension_submit",
        args: { action: "preflight", browsers: ["chrome"] },
      },
    });

    expect(out.value.trackUrl).toBe(SETTINGS);
  });

  it("2. connected and unhealthy: preflight answers store-connection-failed and nextStep connect", async () => {
    if (process.platform === "win32") return;

    world.login();
    answers(world, {
      kind: "oauth",
      connectedAs: "cezar@example.com",
      healthy: false,
      itemId: null,
      reason: "Google revoked the grant.",
    });

    const out = await world.call("extension_submit", PREFLIGHT_ARGS);

    walked(out, "store-connection-failed", "connect");
    expect(out.value.nextStep.url).toBe(CONNECT);
    expect(out.value.nextStep.say).toContain("Google revoked the grant.");
  });

  it("3. connected and unlinked: preflight answers store-item-not-linked and nextStep link-item at the link page", async () => {
    if (process.platform === "win32") return;

    world.login();
    answers(world, {
      kind: "oauth",
      connectedAs: "cezar@example.com",
      healthy: true,
      itemId: null,
      itemLinked: false,
      newItemUrl: NEW_ITEM,
      packageUrl: PACKAGE,
      linkItemUrl: LINK_ITEM,
    });

    const out = await world.call("extension_submit", PREFLIGHT_ARGS);

    walked(out, "store-item-not-linked", "link-item");
    expect(out.hint).toContain(LINK_ITEM_POINTER);
    expect(out.value.sayToPerson).toContain(`at ${PACKAGE}, or let me save it with extension_builds`);
    expect(out.value.nextStep).toEqual({
      kind: "link-item",
      say: LINK_ITEM_POINTER,
      url: LINK_ITEM,
      thenCall: {
        tool: "extension_submit",
        args: { action: "preflight", browsers: ["chrome"] },
      },
    });
  });

  it("4. linked and green: preflight answers preflight-read and nextStep submit", async () => {
    if (process.platform === "win32") return;

    world.login();
    answers(world, {
      kind: "oauth",
      connectedAs: "cezar@example.com",
      healthy: true,
      itemId: "abcdefghijklmnopabcdefghijklmnop",
      itemLinked: true,
      publisherId: "pub-1",
    });

    const out = await world.call("extension_submit", PREFLIGHT_ARGS);

    walked(out, "preflight-read", "submit");
    expect(out.value.nextStep.url).toBeNull();
    expect(out.value.itemUrl).toBe(ITEM_URL);
    expect(out.value.nextStep.say).toContain(
      "nothing goes to review until you publish",
    );
  });

  it("4b. linked, with only the build and release checks open: preflight defers them to the submit call and still answers nextStep submit", async () => {
    if (process.platform === "win32") return;

    world.login();
    world.routes.push([
      PREFLIGHT,
      () => ({
        body: {
          store: "chrome",
          summary: {
            pass: 10,
            warn: 0,
            fail: 1,
            blockingFailures: 1,
            canSubmit: false,
          },
          checks: [
            {
              id: "submission.build_selected",
              label: "Build selected",
              status: "fail",
              severity: "blocking",
              message: "Choose a build before queueing this submission.",
            },
            {
              id: "submission.release_selected",
              label: "Release selected",
              status: "pass",
              severity: "blocking",
              message: "Release context detected.",
            },
          ],
          connection: {
            kind: "oauth",
            connectedAs: "cezar@example.com",
            healthy: true,
            itemId: "abcdefghijklmnopabcdefghijklmnop",
            itemLinked: true,
            publisherId: "pub-1",
          },
        },
      }),
    ]);

    const out = await world.call("extension_submit", PREFLIGHT_ARGS);

    walked(out, "preflight-read", "submit");
    expect(out.value.stores.chrome.canSubmit).toBe(true);
    expect(out.value.stores.chrome.summary).toMatchObject({
      canSubmit: true,
      blockingFailures: 0,
      fail: 0,
      pass: 1,
      namedBySubmit: ["submission.build_selected"],
    });

    expect(out.value.stores.chrome.failing).toEqual([]);
    expect(out.value.stores.chrome.namedBySubmit).toEqual(["build"]);
    expect(out.hint).toContain("The submit call names the build");
    const sent = world.calls.find((call) =>
      PREFLIGHT.test(`${call.method} ${call.path}`),
    );
    expect(sent?.body).not.toHaveProperty("channel");
  });

  it("5. submit: the real submission answers approval-required and nextStep approve at the approval page with its expiry", async () => {
    if (process.platform === "win32") return;

    world.login();
    world.routes.push([
      APPROVALS,
      () => ({
        body: {
          approvalId: "apr_goal",
          approvalUrl: `${WORLD_API}/device/approve/apr_goal`,
          expiresAt: "2026-10-19T21:00:00.000Z",
          description: LEAK,
        },
      }),
    ]);

    const out = await world.call("extension_submit", SUBMIT_ARGS);

    walked(out, "approval-required", "approve");
    expect(out.value.nextStep.url).toBe(`${WORLD_API}/device/approve/apr_goal`);
    expect(out.value.nextStep.say).toContain("2026-10-19T21:00:00.000Z");
    expect(out.value.nextStep.say).toContain(
      "Nothing goes to review until you publish.",
    );

    expect(out.value.checkUrl).toMatch(/\/acme\/widget\/submissions\/chrome$/);
    expect(
      world.calls.some((call) => SUBMIT.test(`${call.method} ${call.path}`)),
    ).toBe(false);
  });

  it("6. resume: the approved submission answers submitted and nextStep publish at the item", async () => {
    if (process.platform === "win32") return;

    world.login();
    world.routes.push([
      /^GET \/api\/cli\/approvals\/apr_goal$/,
      () => ({
        body: {
          status: "approved",
          used: false,
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          fingerprint: actionFingerprint("extension_submit", {
            browsers: ["chrome"],
            buildSha: "603fc8a",
          }),
        },
      }),
    ]);

    world.routes.push([
      SUBMIT,
      () => ({
        body: {
          ok: true,
          buildId: "603fc8a",
          submissions: [
            {
              id: "sub_1",
              store: "chrome",
              status: "pending",
              itemId: "abcdefghijklmnopabcdefghijklmnop",
              itemUrl: ITEM_URL,
            },
          ],
        },
      }),
    ]);

    world.routes.push([
      /^GET \/api\/cli\/stores\/submissions$/,
      () => ({
        body: {
          submissions: [
            {
              id: "sub_1",
              store: "chrome",
              status: "submitted",
              storeUpload: { state: "SUCCEEDED" },
            },
          ],
        },
      }),
    ]);

    const out = await world.call("extension_submit", {
      ...SUBMIT_ARGS,
      approvalId: "apr_goal",
    });

    walked(out, "submitted", "publish");
    expect(out.value.outcome).toMatchObject({
      recorded: true,
      status: "submitted",
      storeState: "SUCCEEDED",
    });

    expect(
      out.value.links.map((link: { kind: string; made: boolean }) => [
        link.kind,
        link.made,
      ]),
    ).toEqual([
      ["submission", true],
      ["item", false],
    ]);

    expect(out.hint).toContain("Made: the submission page.");
    expect(out.value.nextStep.url).toBeNull();
    expect(out.value.itemUrl).toBe(ITEM_URL);
    expect(out.value.trackUrl).toMatch(
      /\/acme\/widget\/submissions\/chrome\/sub_1$/,
    );

    expect(out.value.nextStep.say).toContain(
      "To send it to review, say publish; that is one more approval.",
    );

    expect(out.value.nextStep.say).not.toMatch(/not available yet/);
  });
});

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
      "1. Call extension_submit {action:'preflight', browsers:['chrome']} first, every time, even on a retry.",
      "2. On store-not-connected or store-connection-failed",
      "3. On store-item-not-linked",
      "4. On preflight-read whose value.stores.chrome.storeMd says the privacy policy URL is not in STORE.md, say that line as it is and stop",
      "5. On preflight-read with every check green, call extension_submit {action:'submit', browsers:['chrome']",
      "6. On submitted, or submit-dispatched while the record has not confirmed the upload yet, report the status line and value.trackUrl (value.itemUrl, the store's own page, is information, never a next step), and say value.nextStep.say: To send it to review, say publish; that is one more approval. When the person says publish or send it to review, call extension_submit {action:'publish', browsers:['chrome']}",
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
