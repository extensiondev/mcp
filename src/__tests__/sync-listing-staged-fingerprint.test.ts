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
import { stagedPatch, type StagedImage } from "../lib/listing-image-stage";
import { listingDigest, type ListingPatch } from "../lib/store-listing-media";
import { handler as submit } from "../tools/submit-local";
import { solidPng } from "./fixtures/png";
import { API, PROJECT_ROUTE, useProjectRoutes, type Call } from "./fixtures/project-routes";

const ACTION = "extension_store.listing";
const LISTING = `${PROJECT_ROUTE}/stores/safari/listing`;
const IMAGES = `${LISTING}/images`;
const PREFLIGHT = `${PROJECT_ROUTE}/stores/safari/submissions/preflight`;
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

type ImageRow = { sha256: string; width: number; height: number };

function wwwRecipe(body: { listing: Record<string, unknown>; media?: { icons?: ImageRow[]; screenshots?: ImageRow[] } }): string {
  const listing: Record<string, unknown> = {};
  for (const field of WWW_FIELD_ORDER) if (body.listing[field] !== undefined) listing[field] = body.listing[field];

  const view = (image: ImageRow) => ({ sha256: image.sha256, width: image.width, height: image.height });
  const canonical: Record<string, unknown> = { listing };
  if (body.media?.icons) canonical.icons = body.media.icons.map(view);
  if (body.media?.screenshots) canonical.screenshots = body.media.screenshots.map(view);

  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

const STORE_MD = `# Store metadata

## Listing

- Name: PII Shield
- Summary: Hide personal information on every open tab with one click.
`;

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-staged-fingerprint-"));
  fs.writeFileSync(path.join(root, "STORE.md"), STORE_MD);
  fs.mkdirSync(path.join(root, "dist", "safari", "icons"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist", "safari", "manifest.json"), JSON.stringify({ icons: { "128": "icons/128.png" } }));
  fs.writeFileSync(path.join(root, "dist", "safari", "icons", "128.png"), solidPng(128, 128));
  fs.mkdirSync(path.join(root, "shots"));
  fs.writeFileSync(path.join(root, "shots", "a.png"), Buffer.concat([solidPng(2560, 1600), Buffer.alloc(1)]));
  fs.writeFileSync(path.join(root, "shots", "b.png"), Buffer.concat([solidPng(2560, 1600), Buffer.alloc(2)]));

  return root;
}

const sha = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");

function localBody(root: string, listing: Record<string, unknown>): Parameters<typeof wwwRecipe>[0] {
  const row = (file: string) => {
    const bytes = fs.readFileSync(path.join(root, file));

    return { sha256: sha(bytes), width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  };

  return { listing, media: { icons: [row("dist/safari/icons/128.png")], screenshots: [row("shots/a.png"), row("shots/b.png")] } };
}

function askFor(call: Call) {
  const scope = { store: "safari", listingDigest: wwwRecipe(call.body) };

  return {
    status: 403,
    body: { code: "APPROVAL_REQUIRED", message: "Needs approval.", approvalRequest: { action: ACTION, scope, fingerprint: actionFingerprint(ACTION, scope) } },
  };
}

async function sync(root: string): Promise<any> {
  return JSON.parse(await submit({ action: "sync-listing", browsers: ["safari"], projectPath: root, screenshots: ["shots/a.png", "shots/b.png"], api: API }));
}

describe("the listing approval fingerprint hashes the exact media the listing write carries, as www's storeListingDigest does", () => {
  const platform = useProjectRoutes("extdev-staged-fingerprint-api-");
  let root = "";
  let staged = 0;

  beforeEach(() => {
    root = project();
    staged = 0;
    platform.login();
    platform.routes[`POST ${PREFLIGHT}`] = () => ({ body: { checks: [] } });
    platform.routes[`PUT ${LISTING}`] = (call: Call) => (call.body.approvalId ? { body: { changes: ["screenshots"] } } : askFor(call));
    platform.routes[`POST ${APPROVALS}`] = () => ({
      status: 201,
      body: { approvalId: "apr_staged", approvalUrl: `${API}/device/approve/apr_staged`, changes: ["screenshots"] },
    });

    platform.routes[`PUT ${IMAGES}`] = (call: Call) => {
      staged += 1;
      const icon = call.body.kind === "icons";

      return { body: { ok: true, image: { sha256: String(staged).repeat(64), width: icon ? 128 : 2560, height: icon ? 128 : 1600, bytes: 1000 + staged } } };
    };
  });

  it("equals www's storeListingDigest on the same patch, a value computed once by running it from the monorepo", () => {
    expect(listingDigest(FIXTURE)).toBe(WWW_STORE_LISTING_DIGEST);
    expect(wwwRecipe({ listing: FIXTURE.listing, media: { icons: FIXTURE.icons, screenshots: FIXTURE.screenshots } })).toBe(WWW_STORE_LISTING_DIGEST);

    const local: ListingPatch = {
      listing: FIXTURE.listing,
      icons: [{ sha256: "local-icon", width: 1, height: 1, bytes: Buffer.alloc(1), source: "icon.png" }],
      screenshots: [
        { sha256: "local-a", width: 1, height: 1, bytes: Buffer.alloc(1), source: "a.png" },
        { sha256: "local-b", width: 1, height: 1, bytes: Buffer.alloc(1), source: "b.png" },
      ],
    };
    const answered: StagedImage[] = [
      { name: "a.png", kind: "screenshots", ...FIXTURE.screenshots[0]!, bytes: 1 },
      { name: "icon.png", kind: "icons", ...FIXTURE.icons[0]!, bytes: 1 },
      { name: "b.png", kind: "screenshots", ...FIXTURE.screenshots[1]!, bytes: 1 },
    ];

    expect(listingDigest(stagedPatch(local, answered))).toBe(WWW_STORE_LISTING_DIGEST);
    expect(listingDigest(local)).not.toBe(WWW_STORE_LISTING_DIGEST);
  });

  it("asks for approval with the fingerprint of the answered shas, in the order stage, listing write, ask", async () => {
    if (process.platform === "win32") return;

    const out = await sync(root);
    const put = platform.sent("PUT", LISTING);
    const asks = platform.sent("POST", APPROVALS);

    expect(out.value.stores.safari.status).toBe("approval-required");
    expect(put).toHaveLength(1);
    expect(asks).toHaveLength(1);

    const shots = put[0]!.body.media.screenshots.map((row: ImageRow) => row.sha256);
    expect(shots.every((value: string) => /^[1-9]{64}$/.test(value))).toBe(true);

    const expected = wwwRecipe(put[0]!.body);
    expect(asks[0]!.body.scope).toEqual({ store: "safari", listingDigest: expected });
    expect(asks[0]!.body.fingerprint).toBe(actionFingerprint(ACTION, { store: "safari", listingDigest: expected }));
    expect(asks[0]!.body.media.screenshots.map((row: ImageRow) => row.sha256)).toEqual(shots);
    expect(expected).not.toBe(wwwRecipe(localBody(root, put[0]!.body.listing)));

    const order = platform.calls.map((call) => `${call.method} ${call.path}`);
    expect(order.lastIndexOf(`PUT ${IMAGES}`)).toBeLessThan(order.indexOf(`PUT ${LISTING}`));
    expect(order.indexOf(`PUT ${LISTING}`)).toBeLessThan(order.indexOf(`POST ${APPROVALS}`));
  });

  it("keeps the local-sha fingerprint when the platform has no images door and the single body is what it hashes", async () => {
    if (process.platform === "win32") return;

    delete platform.routes[`PUT ${IMAGES}`];

    platform.routes[`PUT ${LISTING}`] = (call: Call) => {
      if (call.body.approvalId) return { body: { changes: ["screenshots"] } };

      const scope = { store: "safari", listingDigest: wwwRecipe(localBody(root, call.body.listing)) };

      return {
        status: 403,
        body: { code: "APPROVAL_REQUIRED", message: "Needs approval.", approvalRequest: { action: ACTION, scope, fingerprint: actionFingerprint(ACTION, scope) } },
      };
    };

    const out = await sync(root);
    const put = platform.sent("PUT", LISTING);
    const asks = platform.sent("POST", APPROVALS);

    expect(out.value.stores.safari.status).toBe("approval-required");
    expect(put[0]!.body.media.screenshots[0].dataBase64).toBeTruthy();
    expect(asks).toHaveLength(1);
    expect(asks[0]!.body.scope.listingDigest).toBe(wwwRecipe(localBody(root, put[0]!.body.listing)));
  });
});
