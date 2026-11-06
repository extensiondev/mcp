// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { actionFingerprint } from "../lib/approval-gate";
import { runAskingOnly } from "../lib/ask-only";
import { projectApiSend, type ProjectApi } from "../lib/project-api";
import { listingDigest } from "../lib/store-listing-media";
import { behindSentence, digestMismatchOf } from "../lib/store-listing-digest";
import { handler as check } from "../tools/submit-check";
import { handler as submit } from "../tools/submit";
import { solidPng } from "./fixtures/png";
import { API, PROJECT_ID, PROJECT_ROUTE, useProjectRoutes, type Call } from "./fixtures/project-routes";

const ACTION = "extension_store.listing";
const LISTING = `${PROJECT_ROUTE}/stores/safari/listing`;
const IMAGES = `${LISTING}/images`;
const APPROVALS = "/api/cli/approvals";

const WWW_STORE_LISTING_DIGEST = "783d70fce0de1670e8c8aa98caf7052f78d6df1931b364688db07d67e8781324";

const FIXTURE = {
  listing: {
    categories: ["Privacy & Security"],
    shortDescription: "Hide personal information on every open tab with one click.",
    title: "PII Shield",
    permissionJustifications: [{ permission: "activeTab", justification: "Reads the open tab to blur it." }],
    supportEmail: "hello@extension.dev",
  },
  icons: [{ sha256: "a".repeat(64), width: 128, height: 128 }],
  screenshots: [
    { sha256: "b".repeat(64), width: 2560, height: 1600 },
    { sha256: "c".repeat(64), width: 1280, height: 800 },
  ],
};

const WWW_FIELD_ORDER = [
  "title",
  "appStoreName",
  "subtitle",
  "shortDescription",
  "fullDescription",
  "supportEmail",
  "privacyPolicyUrl",
  "homepageUrl",
  "license",
  "singlePurpose",
  "reviewerNotes",
  "releaseNotes",
  "certificationNotes",
  "reviewContactName",
  "reviewContactEmail",
  "reviewContactPhone",
  "supportUrl",
  "visibility",
  "releaseMode",
  "privacySection",
  "categories",
  "searchTerms",
  "permissionJustifications",
  "privacyPolicyAttested",
];

type ImageRow = { sha256?: string; width?: number; height?: number; dataBase64?: string };
type Body = { listing: Record<string, unknown>; media?: { icons?: ImageRow[]; screenshots?: ImageRow[] } };

const sha = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");

function wwwRecipe(body: Body): string {
  const listing: Record<string, unknown> = {};
  for (const field of WWW_FIELD_ORDER) if (body.listing[field] !== undefined) listing[field] = body.listing[field];

  const view = (image: ImageRow) => {
    if (!image.dataBase64) return { sha256: image.sha256, width: image.width, height: image.height };

    const bytes = Buffer.from(image.dataBase64, "base64");

    return { sha256: sha(bytes), width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  };

  const canonical: Record<string, unknown> = { listing };
  if (body.media?.icons) canonical.icons = body.media.icons.map(view);
  if (body.media?.screenshots) canonical.screenshots = body.media.screenshots.map(view);

  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

const STORE_MD = `# Store metadata

## Listing

- Name: PII Shield
- Summary: Hide personal data
`;

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-check-stage-"));
  fs.writeFileSync(path.join(root, "STORE.md"), STORE_MD);
  fs.mkdirSync(path.join(root, "dist", "safari", "icons"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist", "safari", "manifest.json"), JSON.stringify({ icons: { "128": "icons/128.png" } }));
  fs.writeFileSync(path.join(root, "dist", "safari", "icons", "128.png"), solidPng(128, 128));
  fs.mkdirSync(path.join(root, "shots"));
  fs.writeFileSync(path.join(root, "shots", "a.png"), Buffer.concat([solidPng(2560, 1600), Buffer.alloc(1)]));
  fs.writeFileSync(path.join(root, "shots", "b.png"), Buffer.concat([solidPng(2560, 1600), Buffer.alloc(2)]));

  return root;
}

function localBody(root: string, listing: Record<string, unknown>): Body {
  const row = (file: string) => {
    const bytes = fs.readFileSync(path.join(root, file));

    return { sha256: sha(bytes), width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  };

  return { listing, media: { icons: [row("dist/safari/icons/128.png")], screenshots: [row("shots/a.png"), row("shots/b.png")] } };
}

const args = (root: string, extra: Record<string, unknown> = {}) => ({
  action: "sync-listing",
  browsers: ["safari"],
  projectPath: root,
  screenshots: ["shots/a.png", "shots/b.png"],
  api: API,
  ...extra,
});

describe("extension_submit_check approves the listing write sync-listing will send (ledger 464)", () => {
  const platform = useProjectRoutes("extdev-check-stage-api-");
  let root = "";
  let approved = "";
  let shots = 0;

  beforeEach(() => {
    root = project();
    approved = "";
    shots = 0;
    platform.login();

    platform.routes[`PUT ${IMAGES}`] = (call: Call) => {
      const row = call.body.kind === "icons" ? FIXTURE.icons[0]! : FIXTURE.screenshots[shots++]!;

      return { body: { ok: true, image: { ...row, bytes: 1000 } } };
    };

    platform.routes[`POST ${APPROVALS}`] = (call: Call) => {
      approved = call.body.scope.listingDigest;

      return { status: 201, body: { approvalId: "apr_check", approvalUrl: `${API}/device/approve/apr_check`, changes: ["screenshots"] } };
    };

    platform.routes[`PUT ${LISTING}`] = (call: Call) => {
      const digest = wwwRecipe(call.body);
      if (call.body.approvalId && digest === approved) return { body: { changes: ["screenshots"] } };

      return { status: 409, body: { code: "APPROVAL_SCOPE_MISMATCH", message: "The approval is for another change." } };
    };
  });

  it("stages the images, asks with the staged digest, and sync-listing with that approval is accepted", async () => {
    if (process.platform === "win32") return;

    const asked = JSON.parse(await check(args(root) as never));
    const order = platform.calls.map((call) => `${call.method} ${call.path}`);
    const ask = platform.sent("POST", APPROVALS)[0]!;

    expect(asked.status).toBe("approval-required");
    expect(platform.sent("PUT", IMAGES)).toHaveLength(3);
    expect(platform.sent("PUT", LISTING)).toHaveLength(0);
    expect(order.lastIndexOf(`PUT ${IMAGES}`)).toBeLessThan(order.indexOf(`POST ${APPROVALS}`));
    expect(ask.body.media).toEqual({ icons: FIXTURE.icons, screenshots: FIXTURE.screenshots });
    expect(ask.body.fingerprint).toBe(actionFingerprint(ACTION, { store: "safari", listingDigest: approved }));
    expect(approved).not.toBe(wwwRecipe(localBody(root, ask.body.listing)));
    expect(listingDigest({ listing: FIXTURE.listing, icons: FIXTURE.icons, screenshots: FIXTURE.screenshots })).toBe(WWW_STORE_LISTING_DIGEST);

    platform.calls.length = 0;
    shots = 0;

    const written = JSON.parse(await submit(args(root, { approvalId: "apr_check" }) as never));
    const put = platform.sent("PUT", LISTING);

    expect(put).toHaveLength(1);
    expect(wwwRecipe(put[0]!.body)).toBe(approved);
    expect(written.status).toBe("sync-listing-dispatched");
  });

  it("keeps the local-sha digest when the images door answers 404, as sync-listing's single body does", async () => {
    if (process.platform === "win32") return;

    delete platform.routes[`PUT ${IMAGES}`];

    const asked = JSON.parse(await check(args(root) as never));
    const ask = platform.sent("POST", APPROVALS)[0]!;

    expect(asked.status).toBe("approval-required");
    expect(platform.sent("PUT", IMAGES)).toHaveLength(1);
    expect(platform.sent("PUT", LISTING)).toHaveLength(0);
    expect(approved).toBe(wwwRecipe(localBody(root, ask.body.listing)));

    platform.calls.length = 0;

    const written = JSON.parse(await submit(args(root, { approvalId: "apr_check" }) as never));
    const put = platform.sent("PUT", LISTING);

    expect(put[0]!.body.media.screenshots[0].dataBase64).toBeTruthy();
    expect(wwwRecipe(put[0]!.body)).toBe(approved);
    expect(written.status).toBe("sync-listing-dispatched");
  });

  it("still sends no listing write, no dispatch and no approvalId during a check, staging only images", async () => {
    if (process.platform === "win32") return;

    const projectApi = { base: API, token: "claims.sig", command: "extension_submit", projectId: PROJECT_ID, ref: { workspace: "acme", project: "widget" } } as unknown as ProjectApi;
    const image = { kind: "screenshots", dataBase64: "AA==" };
    const listing = await runAskingOnly(() => projectApiSend(projectApi, "PUT", "stores/safari/listing", { listing: { title: "x" } }));
    const config = await runAskingOnly(() => projectApiSend(projectApi, "PUT", "stores/config", { chrome: { enabled: true } }));
    const spent = await runAskingOnly(() => projectApiSend(projectApi, "PUT", "stores/safari/listing/images", { ...image, approvalId: "apr_check" }));
    const publish = await runAskingOnly(() => projectApiSend(projectApi, "POST", "stores/safari/publish", { approvalId: "apr_check" }));
    const nested = await runAskingOnly(() => projectApiSend(projectApi, "PUT", "stores/safari/listing/images/extra", image));
    const staged = await runAskingOnly(() => projectApiSend(projectApi, "PUT", "stores/safari/listing/images", image));

    for (const refused of [listing, config, spent, publish, nested]) expect(refused).toMatchObject({ ok: false, code: "ASK_ONLY" });
    expect(staged.ok).toBe(true);
    expect(platform.calls.map((call) => `${call.method} ${call.path}`)).toEqual([`PUT ${IMAGES}`]);

    platform.calls.length = 0;

    const refused = JSON.parse(await check(args(root, { approvalId: "apr_check" }) as never));

    expect(refused.status).toBe("check-refused");
    expect(platform.calls).toEqual([]);
  });

  it("names only the sent fields that differ on a digest mismatch, never privacySection or privacyPolicyAttested", () => {
    const hashed = WWW_FIELD_ORDER.filter((field) => field !== "subtitle");
    const patch = { listing: { title: "PII Shield", subtitle: "Hide personal data", shortDescription: "Hide personal data" } };
    const mismatch = digestMismatchOf({ digest: { platform: hashed, client: Object.keys(patch.listing), differ: ["subtitle"] } }, patch);
    const first = behindSentence(mismatch, false);
    const same = behindSentence(digestMismatchOf({ digest: { platform: WWW_FIELD_ORDER } }, patch), false);

    expect(mismatch).toEqual({ digest: { platform: hashed, client: ["title", "subtitle", "shortDescription"], differ: ["subtitle"] }, deferred: ["subtitle"] });
    expect(first).toContain("this server sent subtitle, which the platform does not hash");
    expect(same).toContain("the platform hashes every field this server sent");

    for (const sentence of [first, same, behindSentence(mismatch, true)]) {
      expect(sentence).not.toMatch(/privacySection|privacyPolicyAttested|\btitle\b|shortDescription/);
    }
  });
});
