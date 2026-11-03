import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { actionFingerprint } from "../lib/approval-gate";
import { handler as publish } from "../tools/publish";
import { solidPng } from "./fixtures/png";
import { rgbaPng } from "./fixtures/png-alpha";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";

const ACTION = "extension_browsers.captures";
const APPROVALS = "/api/cli/approvals";
const CAPTURES = (browser: string) => `${PROJECT_ROUTE}/browsers/${browser}/captures`;
const TRACK_URL = "https://console.extension.dev/acme/widget/project-settings/browser-captures";
const PUBLIC_URL = "https://acme.extension.dev/widget";
const CAPTURED_IN = { name: "Chrome", version: "142.0.7444.59" };

type Row = Record<string, unknown>;

interface SentCapture {
  sha256: string;
  dataBase64?: string;
  surface?: string;
  caption?: string;
}

const sha = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");

function digestOf(body: { captures: SentCapture[]; capturedIn?: { name: string; version: string } }): string {
  const canonical = {
    capturedIn: body.capturedIn ? { name: body.capturedIn.name, version: body.capturedIn.version } : null,
    captures: body.captures.map((row) => ({ sha256: row.sha256, surface: row.surface ?? null, caption: row.caption ?? null })),
  };

  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function project(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "extdev-sync-captures-"));
}

function folder(root: string, browser: string, files: Record<string, Buffer>, index?: Row): void {
  const dir = path.join(root, "captures", browser);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), bytes);
  if (index) fs.writeFileSync(path.join(dir, "captures.json"), JSON.stringify(index));
}

const PAGE = solidPng(1280, 800);
const POPUP = solidPng(800, 600);

function chromeSet(root: string): void {
  folder(root, "chrome", { "page-01.png": PAGE, "popup-01.png": POPUP }, {
    browser: "chrome",
    capturedIn: CAPTURED_IN,
    captures: [
      { file: "page-01.png", surface: "page", width: 1280, height: 800, capturedAt: "2026-11-03T18:00:00.000Z" },
      { file: "popup-01.png", surface: "popup", width: 800, height: 600, capturedAt: "2026-11-03T18:01:00.000Z", caption: "The popup after one click" },
    ],
  });
}

const sync = (extra: Record<string, unknown> = {}) => publish({ action: "sync-captures", browsers: ["chrome"], api: API, ...extra }).then((out) => JSON.parse(out));

describe("extension_publish sync-captures sends captures/<browser>/ once, after an owner approves the set the platform computed", () => {
  const platform = useProjectRoutes("extdev-sync-captures-api-");
  let root = "";

  beforeEach(() => {
    root = project();
    chromeSet(root);
    platform.login();

    platform.routes[`PUT ${CAPTURES("chrome")}`] = (call) => {
      const body = call.body as { captures: SentCapture[]; capturedIn?: { name: string; version: string }; approvalId?: string };

      if (body.approvalId) {
        return {
          body: {
            ok: true,
            browser: "chrome",
            changes: ["captures: none -> 2"],
            record: {
              browser: "chrome",
              capturedIn: body.capturedIn,
              captures: body.captures.map((row, at) => ({ url: `/api/registry/acme/widget/_extension-dev/browsers/chrome/captures/${row.sha256}.png`, path: `_extension-dev/browsers/chrome/captures/${row.sha256}.png`, sha256: row.sha256, width: at === 0 ? 1280 : 800, height: at === 0 ? 800 : 600, bytes: 100, alpha: false, ...(row.surface ? { surface: row.surface } : {}), ...(row.caption ? { caption: row.caption } : {}) })),
              updatedAt: "2026-11-03T18:05:00.000Z",
              updatedBy: "owner",
            },
            trackUrl: TRACK_URL,
            publicUrl: PUBLIC_URL,
            approvalId: body.approvalId,
          },
        };
      }

      const scope = { browser: "chrome", capturesDigest: digestOf(body) };

      return {
        status: 403,
        body: { code: "APPROVAL_REQUIRED", message: "Needs approval.", approvalRequest: { action: ACTION, scope, fingerprint: actionFingerprint(ACTION, scope) }, changes: ["captures: none -> 2"] },
      };
    };

    platform.routes[`POST ${APPROVALS}`] = () => ({
      status: 201,
      body: { approvalId: "apr_c", approvalUrl: `${API}/device/approve/apr_c`, description: "Show 2 Chrome captures of acme/widget on its public build pages.", changes: ["captures: none -> 2"] },
    });
  });

  it("first answers approval-required with the approval URL, having PUT the set and minted with the same rows", async () => {
    if (process.platform === "win32") return;

    const asked = await sync({ projectPath: root });

    expect(asked.ok).toBe(false);
    expect(asked.status).toBe("approval-required");
    expect(asked.error.code).toBe("E_APPROVAL_REQUIRED");
    expect(asked.value.approvalId).toBe("apr_c");
    expect(asked.value.approvalUrl).toBe(`${API}/device/approve/apr_c`);
    expect(asked.value.browsers.chrome).toMatchObject({ browser: "chrome", status: "approval-required", approvalId: "apr_c", changes: ["captures: none -> 2"], capturedIn: CAPTURED_IN });
    expect(asked.value.browsers.chrome.captures).toEqual([
      { file: "captures/chrome/page-01.png", sha256: sha(PAGE), width: 1280, height: 800, surface: "page" },
      { file: "captures/chrome/popup-01.png", sha256: sha(POPUP), width: 800, height: 600, surface: "popup", caption: "The popup after one click" },
    ]);

    expect(asked.hint).toBe(
      `Approve at ${API}/device/approve/apr_c: the page lists the 2 Chrome captures as the platform computed the change. Then call extension_publish action:"sync-captures" again with browsers:["chrome"], the same projectPath and approvalId apr_c.`,
    );

    const put = platform.sent("PUT", CAPTURES("chrome"));

    expect(put).toHaveLength(1);
    expect(put[0]!.body).toEqual({
      captures: [
        { sha256: sha(PAGE), dataBase64: PAGE.toString("base64"), surface: "page" },
        { sha256: sha(POPUP), dataBase64: POPUP.toString("base64"), surface: "popup", caption: "The popup after one click" },
      ],
      capturedIn: CAPTURED_IN,
    });

    const minted = platform.sent("POST", APPROVALS);

    expect(minted).toHaveLength(1);
    expect(minted[0]!.body).toMatchObject({
      action: ACTION,
      scope: { browser: "chrome", capturesDigest: digestOf(put[0]!.body) },
      fingerprint: actionFingerprint(ACTION, { browser: "chrome", capturesDigest: digestOf(put[0]!.body) }),
      browser: "chrome",
      captures: put[0]!.body.captures,
      capturedIn: CAPTURED_IN,
    });

    expect(minted[0]!.body.description).toBe("Show 2 Chrome captures of acme/widget on its public build pages, captured in Chrome 142.");
  });

  it("then writes once with the approvalId and answers captures-synced with trackUrl and publicUrl from the platform", async () => {
    if (process.platform === "win32") return;

    const written = await sync({ projectPath: root, approvalId: "apr_c" });

    expect(written.ok).toBe(true);
    expect(written.status).toBe("captures-synced");
    expect(written.value.trackUrl).toBe(TRACK_URL);
    expect(written.value.publicUrl).toBe(PUBLIC_URL);
    expect(written.value.outcome).toMatchObject({ recorded: true, status: "synced" });
    expect(written.value.links).toEqual([
      { kind: "track", url: TRACK_URL, audience: "workspace members", expiresAt: null, made: false },
      { kind: "project", url: PUBLIC_URL, audience: "anyone with the link", expiresAt: null, made: false },
    ]);

    expect(written.value.browsers.chrome).toMatchObject({
      status: "synced",
      changes: ["captures: none -> 2"],
      capturedIn: CAPTURED_IN,
      updatedAt: "2026-11-03T18:05:00.000Z",
      from: { folder: "captures/chrome", files: ["page-01.png", "popup-01.png"] },
    });

    expect(written.value.browsers.chrome.captures.map((row: { sha256: string; surface?: string }) => [row.sha256, row.surface])).toEqual([[sha(PAGE), "page"], [sha(POPUP), "popup"]]);
    expect(written.hint).toBe(
      `2 Chrome captures from captures/chrome/ now show on the public build pages of acme/widget as captured in Chrome 142: ${PUBLIC_URL}. Track the set at ${TRACK_URL}, the project settings' Browser captures section. Made: no new links.`,
    );

    const put = platform.sent("PUT", CAPTURES("chrome"));

    expect(put).toHaveLength(1);
    expect(put[0]!.body.approvalId).toBe("apr_c");
    expect(platform.sent("POST", APPROVALS)).toHaveLength(0);
  });

  it("answers captures-unchanged when the platform replays NO_CHANGE", async () => {
    if (process.platform === "win32") return;

    platform.routes[`PUT ${CAPTURES("chrome")}`] = () => ({ status: 409, body: { code: "NO_CHANGE", message: "The record already holds this set." } });

    const out = await sync({ projectPath: root, approvalId: "apr_c" });

    expect(out.ok).toBe(true);
    expect(out.status).toBe("captures-unchanged");
    expect(out.value.browsers.chrome.status).toBe("unchanged");
    expect(out.hint).toContain("captures/chrome/ already matches the Chrome captures on record");
  });

  it("relays a per-row platform refusal with its row and code", async () => {
    if (process.platform === "win32") return;

    platform.routes[`PUT ${CAPTURES("chrome")}`] = () => ({ status: 400, body: { code: "INVALID_CAPTURES", message: "captures[1] duplicates captures[0]", row: 1, refusedBeforeApproval: true } });

    const out = await sync({ projectPath: root });

    expect(out.ok).toBe(false);
    expect(out.error.platformCode).toBe("INVALID_CAPTURES");
    expect(out.error.message).toContain("captures[1] duplicates captures[0]");
    expect(out.value).toMatchObject({ action: "sync-captures", browser: "chrome", row: 1, refusedBeforeApproval: true });
    expect(platform.sent("POST", APPROVALS)).toHaveLength(0);
  });
});

describe("sync-captures refuses the set on this machine before anything is sent", () => {
  const platform = useProjectRoutes("extdev-sync-captures-local-");
  let root = "";

  beforeEach(() => {
    root = project();
    platform.login();
  });

  const refused = async (): Promise<Row> => {
    const out = await sync({ projectPath: root });

    expect(out.ok).toBe(false);
    expect(out.status).toBe("bad-request");
    expect(out.error.name).toBe("CapturesInputError");
    expect(out.error.message).toMatch(/Nothing was sent\.$/);
    expect(out.hint).toContain("extension_screenshot browserCapture:true on a Chrome dev session");
    expect(platform.calls).toHaveLength(0);

    return out;
  };

  it("an alpha channel", async () => {
    if (process.platform === "win32") return;

    folder(root, "chrome", { "page-01.png": solidPng(1280, 800), "popup-01.png": rgbaPng(1280, 800) });

    const out = await refused();

    expect(out.error).toMatchObject({ message: "captures/chrome/popup-01.png carries an alpha channel; a browser capture is a 24-bit PNG with no transparency. Nothing was sent." });
    expect(out.value).toMatchObject({ browser: "chrome", file: "captures/chrome/popup-01.png" });
  });

  it("a count over ten, and an empty folder", async () => {
    if (process.platform === "win32") return;

    folder(root, "chrome", Object.fromEntries(Array.from({ length: 11 }, (_, at) => [`page-${String(at + 1).padStart(2, "0")}.png`, solidPng(640, 400)])));

    const over = await refused();

    expect(over.error).toMatchObject({ message: "captures/chrome/ holds 11 .png files; a browser takes at most 10 captures. Nothing was sent." });

    fs.rmSync(path.join(root, "captures", "chrome"), { recursive: true, force: true });
    fs.mkdirSync(path.join(root, "captures", "chrome"), { recursive: true });

    const none = await refused();

    expect(none.error).toMatchObject({ message: "captures/chrome/ holds no .png file. Nothing was sent." });
  });

  it("a width under 640", async () => {
    if (process.platform === "win32") return;

    folder(root, "chrome", { "page-01.png": solidPng(639, 400) });

    const out = await refused();

    expect(out.error).toMatchObject({ message: "captures/chrome/page-01.png is 639x400; a browser capture is at least 640 pixels wide. Nothing was sent." });
  });

  it("a browser the build pages do not show, a missing projectPath, and an approvalId with several browsers", async () => {
    if (process.platform === "win32") return;

    const brave = await sync({ projectPath: root, browsers: ["brave"] });

    expect(brave.error.message).toContain("brave is not a browser the public build page shows captures for; use chrome, firefox, edge, safari");

    const noPath = await sync({});

    expect(noPath.error.message).toContain("sync-captures needs projectPath");

    const two = await sync({ projectPath: root, browsers: ["chrome", "firefox"], approvalId: "apr_c" });

    expect(two.error.message).toContain("pass one browser with its approvalId");

    const other = JSON.parse(await publish({ action: "nope", api: API }));

    expect(other.error.message).toContain("action must be publish or sync-captures");
    expect(platform.calls).toHaveLength(0);
  });
});
