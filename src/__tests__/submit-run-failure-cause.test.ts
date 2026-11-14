// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { envelope } from "../lib/envelope";
import { FIREFOX_LISTING_CHECK, SAFARI_DESCRIPTION_CHECK, SAFARI_DESCRIPTION_MAX } from "../lib/store-preflight-local";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

import type * as StoreStatus from "../tools/store-status";

type StoreStatusModule = typeof StoreStatus;

type Row = Record<string, any>;

const storeRows = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));

vi.mock("../tools/store-status", async (importOriginal) => {
  const actual = await importOriginal<StoreStatusModule>();

  return {
    ...actual,
    readStores: async () =>
      envelope({ ok: true, command: "extension_release_status", status: "read", value: { workspace: "acme", project: "widget", stores: storeRows.rows } }),
  };
});

const { handler: submit } = await import("../tools/submit-local");

const APPLE_90849 =
  "App Store Connect rejected the build: 90849: Invalid manifest file. The description field must be present, of string type, and 112 or fewer characters long.";
const GENERIC = "the submit job ended as failure before the store answered, so no submission result was ever read";
const WALK: Record<string, Row> = JSON.parse(fs.readFileSync(fileURLToPath(new URL("./fixtures/preflight-four-stores.json", import.meta.url)), "utf8"));

async function status(rows: Array<Record<string, unknown>>, browsers: string[]): Promise<Row> {
  storeRows.rows = rows;

  return JSON.parse(await submit({ action: "status", browsers, api: API }));
}

function safariFailed(lastSubmission: Row, run: Row): Row {
  return { store: "safari", configured: true, lastSubmission: { id: "sub_s", version: "0.1.0", ...lastSubmission }, submissionRun: run };
}

describe("status reads a failed store run's own cause into failureReason with a next step that fits it", () => {
  it("answers Apple's 90849 text as failureReason and a shorten nextStep for a failed Safari run", async () => {
    const out = await status([safariFailed({ status: "failed", failureReason: APPLE_90849 }, { status: "completed", conclusion: "failure" })], ["safari"]);
    const entry = out.value.stores[0];

    expect(entry.status).toBe("failed");
    expect(entry.failureReason).toBe(APPLE_90849);
    expect(entry.nextStep.kind).toBe("resubmit");
    expect(entry.nextStep.say).toContain(`Shorten the manifest description to ${SAFARI_DESCRIPTION_MAX} characters or fewer`);
    expect(out.value.nextStep.kind).toBe("resubmit");
    expect(out.hint).toContain("90849");
  });

  it("answers the sync-listing nextStep for a Firefox run that died on the listing step with only the generic reason", async () => {
    const out = await status(
      [
        {
          store: "firefox",
          configured: true,
          lastSubmission: { id: "sub_f", version: "0.1.0.2", status: "failed", failureReason: GENERIC, failure: { step: "Read the Firefox listing from the registry" } },
          submissionRun: { status: "completed", conclusion: "failure" },
        },
      ],
      ["firefox"],
    );
    const entry = out.value.stores[0];

    expect(entry.status).toBe("failed");
    expect(entry.failureReason).toContain('step "Read the Firefox listing from the registry"');
    expect(entry.failureReason).not.toContain("no submission result was ever read");
    expect(entry.nextStep.kind).toBe("sync-listing");
    expect(entry.nextStep.say).toContain('extension_submit {action: "sync-listing", store: "firefox"');
  });

  it("answers the sync-listing nextStep when the run's own message names the missing listing document", async () => {
    const out = await status(
      [
        {
          store: "firefox",
          configured: true,
          lastSubmission: { id: "sub_f", status: "failed", failureReason: "_extension-dev/stores/firefox/details.json does not exist" },
          submissionRun: { status: "completed", conclusion: "failure" },
        },
      ],
      ["firefox"],
    );

    expect(out.value.stores[0].nextStep.kind).toBe("sync-listing");
  });

  it("answers the connect step that replaces the key for a Firefox run AMO refused 401", async () => {
    const AMO_401 = 'HTTP 401 Unauthorized, POST https://addons.mozilla.org/api/v5/addons/upload/ {"detail":"Unknown JWT iss (issuer)."}';
    const out = await status(
      [
        {
          store: "firefox",
          configured: true,
          lastSubmission: {
            id: "sub_f",
            version: "0.1.0.2",
            status: "failed",
            failureReason: AMO_401,
            failureCause: { kind: "store-connection-failed", store: "firefox", credential: "issuer-unknown", keyOnFile: "refused", source: "workspace" },
          },
          submissionRun: { status: "completed", conclusion: "failure" },
        },
      ],
      ["firefox"],
    );
    const entry = out.value.stores[0];

    expect(entry.status).toBe("failed");
    expect(entry.failureReason).toBe(AMO_401);
    expect(entry.nextStep).toMatchObject({ kind: "connect", replace: true });
    expect(entry.nextStep.url).toMatch(/\/settings\/store-accounts$/);
    expect(entry.nextStep.say).toContain("The key on file is at fault");
  });

  it("names the failing step beside the generic reason and grounds no next step when the cause is not known", async () => {
    const out = await status(
      [
        {
          store: "chrome",
          configured: true,
          lastSubmission: { id: "sub_c", status: "failed", failureReason: GENERIC },
          submissionRun: { status: "completed", conclusion: "failure", failedStep: "Upload the package" },
        },
      ],
      ["chrome"],
    );
    const entry = out.value.stores[0];

    expect(entry.failureReason).toMatch(/^The chrome submit run failed at step "Upload the package"; the submit job ended as failure/);
    expect(entry.nextStep).toBeNull();
  });
});

describe("a submit whose store run concluded failure never reads pending", () => {
  it("answers failed, read from the run, for a pending inferred Safari record whose run failed", async () => {
    const out = await status(
      [
        safariFailed(
          { status: "pending", statusRead: { word: "pending", source: "inferred", readAt: "2026-11-06T20:07:02Z" } },
          { status: "completed", conclusion: "failure", failedStep: "Submit to App Store Connect" },
        ),
      ],
      ["safari"],
    );
    const entry = out.value.stores[0];

    expect(entry.status).toBe("failed");
    expect(entry.source).toBe("run");
    expect(entry.readAt).toBeNull();
    expect(entry.failureReason).toContain('step "Submit to App Store Connect"');
    expect(out.hint).not.toMatch(/safari 0\.1\.0: pending/);
    expect(out.hint).not.toContain("inferred");
  });

  it("keeps pending while the run is still in progress", async () => {
    const out = await status(
      [safariFailed({ status: "pending", statusRead: { word: "pending", source: "inferred" } }, { status: "in_progress" })],
      ["safari"],
    );

    expect(out.value.stores[0].status).toBe("pending");
    expect(out.value.stores[0].failureReason).toBeUndefined();
  });

  it("keeps a submitted word a store check read even when a later step of its run failed", async () => {
    const out = await status(
      [safariFailed({ status: "submitted", statusRead: { word: "submitted", source: "poll", storeWord: "WAITING_FOR_REVIEW" } }, { status: "completed", conclusion: "failure" })],
      ["safari"],
    );

    expect(out.value.stores[0].status).toBe("submitted");
  });
});

const PREFLIGHT = (store: string) => `${PROJECT_ROUTE}/stores/${store}/submissions/preflight`;
const LISTING = (store: string) => `${PROJECT_ROUTE}/stores/${store}/listing`;

function project(description: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-463-"));

  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "widget" }));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Widget", version: "0.1.0", description }));

  return root;
}

describe("the submit preflight refuses the causes that would kill the store run", () => {
  const platform = useProjectRoutes("extdev-463-preflight-");

  async function preflight(store: string, extra: Row = {}): Promise<Row> {
    platform.login();
    platform.routes[`POST ${PREFLIGHT(store)}`] = () => ({ body: structuredClone(WALK[store]) });

    return JSON.parse(await submit({ action: "preflight", browsers: [store], buildSha: "6fb8b3e", api: API, ...extra }));
  }

  const failingIds = (out: Row, store: string): string[] => (out.value.stores[store].failing as Row[]).map((check) => check.id);

  it(`refuses Safari when the manifest description is ${SAFARI_DESCRIPTION_MAX + 1} characters, naming the limit`, async () => {
    const out = await preflight("safari", { projectPath: project("d".repeat(SAFARI_DESCRIPTION_MAX + 1)) });
    const check = (out.value.stores.safari.failing as Row[]).find((row) => row.id === SAFARI_DESCRIPTION_CHECK)!;

    expect(out.value.stores.safari.canSubmit).toBe(false);
    expect(check.message).toContain(`over ${SAFARI_DESCRIPTION_MAX}`);
    expect(check.message).toContain("90849");
    expect(check.actual).toContain(`${SAFARI_DESCRIPTION_MAX + 1} characters`);
  });

  it(`passes Safari when the manifest description is exactly ${SAFARI_DESCRIPTION_MAX} characters`, async () => {
    const out = await preflight("safari", { projectPath: project("d".repeat(SAFARI_DESCRIPTION_MAX)) });

    expect(failingIds(out, "safari")).not.toContain(SAFARI_DESCRIPTION_CHECK);
    expect(out.value.stores.safari.canSubmit).toBe(true);
  });

  it("refuses Firefox when no Firefox listing document is on file, naming the sync-listing route", async () => {
    platform.routes[`GET ${LISTING("firefox")}`] = () => ({ body: { store: "firefox", listing: {}, media: {}, updatedAt: null } });

    const out = await preflight("firefox");
    const check = (out.value.stores.firefox.failing as Row[]).find((row) => row.id === FIREFOX_LISTING_CHECK)!;

    expect(out.value.stores.firefox.canSubmit).toBe(false);
    expect(check.message).toContain('extension_submit {action: "sync-listing", store: "firefox"');
  });

  it("passes Firefox when the listing document is on file", async () => {
    platform.routes[`GET ${LISTING("firefox")}`] = () => ({
      body: { store: "firefox", listing: { title: "Widget" }, media: {}, updatedAt: "2026-11-06T23:19:00.000Z" },
    });

    const out = await preflight("firefox");

    expect(failingIds(out, "firefox")).not.toContain(FIREFOX_LISTING_CHECK);
    expect(out.value.stores.firefox.canSubmit).toBe(true);
  });
});
