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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { writeCredentials } from "../lib/credentials";
import { handUploadHow, handUploadOf, handUploadSentence } from "../lib/hand-upload";
import { namesRegistryOrToken } from "../lib/package-address";
import { handler as submit } from "../tools/submit";

type Row = Record<string, unknown>;

const PROD = "https://www.extension.dev";
const PROJECT_ID = "prj_307";
const SHA = "82c26be";
const REF = { workspace: "acme", project: "widget" };
const JWT = `eyJ${"a".repeat(220)}.sig`;
const REGISTRY = (browser: string) => `https://registry.extension.land/acme/widget/builds/${SHA}/${browser}.zip?t=${JWT}`;
const ADDRESS = (browser: string) => `https://acme.extension.dev/widget/builds/${SHA}/${browser}.zip`;
const SENTENCE = (browser: string) =>
  `Download ${browser}.zip of build ${SHA} at ${ADDRESS(browser)}, or let me save it with extension_builds (action: "download", buildId: "${SHA}", browser: "${browser}"); upload it once as the item's first package.`;
const VERSION_NOTE = "Every later platform upload carries the store version <manifest version>.<n>, numbered by the platform";

function requirement(id: string, how: string): Row {
  return { id, label: id, required: true, format: "the store's own record", status: "missing", satisfiedBy: "console-only", how };
}

function report(store: string, rows: Row[], extra: Row = {}): Row {
  return {
    store,
    summary: { pass: 9, warn: 0, fail: 0, canSubmit: true },
    checks: [{ id: `${store}.package`, label: "Package", status: "pass", severity: "blocking", message: `The ${store} package of build ${SHA} is in order.` }],
    connection: { kind: "api-key", connectedAs: "cezar@example.com", healthy: true, itemId: "x", itemLinked: true },
    requirements: { store, missingRequired: rows.length, missingOptional: 0, items: rows },
    ...extra,
  };
}

describe("the hand-upload sentence is one helper for every store that takes a first package by hand", () => {
  it("names the browser package, the build and the subdomain address, then the download call, for chrome and edge alike", () => {
    const scope = { ref: REF, sha: SHA, api: PROD };

    expect(handUploadSentence(handUploadOf({ ...scope, browser: "chrome" }))).toBe(SENTENCE("chrome"));
    expect(handUploadSentence(handUploadOf({ ...scope, browser: "edge" }, REGISTRY("edge")))).toBe(SENTENCE("edge"));
    expect(handUploadSentence(handUploadOf({ ref: REF, api: PROD, browser: "edge" }))).toBe(
      'Download edge.zip of a completed build from its extension.dev build page, or let me save it with extension_builds (action: "download", buildId, browser: "edge"); upload it once as the item\'s first package.',
    );
  });

  it("keeps what each store needs beyond the sentence and names the platform's later versions in both", () => {
    const chrome = handUploadHow("chrome.item", handUploadOf({ ref: REF, sha: SHA, api: PROD, browser: "chrome" }));
    const edge = handUploadHow("edge.product", handUploadOf({ ref: REF, sha: SHA, api: PROD, browser: "edge" }), "0.1.0.1");

    expect(chrome).toContain(SENTENCE("chrome"));
    expect(chrome).toContain(`${VERSION_NOTE}.`);
    expect(chrome).toContain("paste the item's dashboard address");
    expect(edge).toContain(SENTENCE("edge"));
    expect(edge).toContain(`${VERSION_NOTE}; the next one is 0.1.0.1.`);
    expect(edge).toContain("Product ID");
    expect(handUploadHow("firefox.add_on_id", handUploadOf({ ref: REF, sha: SHA, api: PROD, browser: "firefox" }))).toBe("");
  });
});

describe("extension_submit preflight: the chrome.item and edge.product rows say one sentence, with no registry address and no token", () => {
  let tmp: string;
  let routes: Record<string, () => { status?: number; body: unknown }>;
  const saved: Record<string, string | undefined> = {};
  const envKeys = ["XDG_CONFIG_HOME", "EXTENSION_DEV_API_URL", "EXTENSION_DEV_APPROVAL_GATE", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_REGISTRY_URL"];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-hand-upload-"));
    for (const key of envKeys) saved[key] = process.env[key];
    for (const key of envKeys) delete process.env[key];

    process.env.XDG_CONFIG_HOME = tmp;
    process.env.EXTENSION_DEV_API_URL = PROD;
    process.env.EXTENSION_DEV_APPROVAL_GATE = "0";
    writeCredentials({ version: 1, token: "claims.sig", workspaceSlug: "acme", projectSlug: "widget", expiresAt: Math.floor(Date.now() / 1000) + 3600, api: PROD });
    routes = {
      "GET /api/cli/whoami": () => ({ body: { login: "acme/widget", live: true, projectId: PROJECT_ID, workspaceSlug: "acme", projectSlug: "widget" } }),
      [`POST /api/projects/${PROJECT_ID}/stores/chrome/submissions/preflight`]: () => ({
        body: report("chrome", [requirement("chrome.item", "Create the item on the Chrome Web Store dashboard and paste its dashboard address on the project's store settings page.")]),
      }),
      [`POST /api/projects/${PROJECT_ID}/stores/edge/submissions/preflight`]: () => ({
        body: report(
          "edge",
          [
            requirement(
              "edge.product",
              `extension_builds (action: 'download', buildId: '${SHA}', browser: 'edge') saves it from the build, byte-identical to what the integrity report describes, or take ${REGISTRY("edge")}; then paste the Product ID. The product will list the hand upload (0.1.0) and the platform's 0.1.0.1.`,
            ),
          ],
          { edgePreflight: { act: "upload", checks: [], blocking: [], warnings: [], lock: null, nextVersion: "0.1.0.1" } },
        ),
      }),
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input instanceof Request ? input.url : input));
        const method = String(init?.method ?? "GET").toUpperCase();
        const route = routes[`${method} ${url.pathname}`];
        const answer = route ? route() : { status: 404, body: { message: "not found" } };

        return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { "content-type": "application/json" } });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();

    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("both rows carry the hand-upload sentence for their own package, the version note, and their store's paste step", async () => {
    const out = JSON.parse(await submit({ action: "preflight", browsers: ["chrome", "edge"], api: PROD }));
    const rowOf = (store: string, id: string) => (out.value.stores[store].requirements.items as Row[]).find((row) => row.id === id) as Row;
    const chrome = String(rowOf("chrome", "chrome.item").how);
    const edge = String(rowOf("edge", "edge.product").how);

    expect(out.status).toBe("preflight-read");
    expect(chrome).toContain(SENTENCE("chrome"));
    expect(edge).toContain(SENTENCE("edge"));
    expect(chrome).toContain(`${VERSION_NOTE}.`);
    expect(edge).toContain(`${VERSION_NOTE}; the next one is 0.1.0.1.`);
    expect(chrome).toContain("paste the item's dashboard address");
    expect(edge).toContain("Product ID");
    expect(edge).not.toContain("byte-identical");
    expect(namesRegistryOrToken(chrome)).toEqual([]);
    expect(namesRegistryOrToken(edge)).toEqual([]);
    expect(JSON.stringify(out)).not.toContain("eyJ");
  });

  it("a row the project already has keeps the platform's own words", async () => {
    routes[`POST /api/projects/${PROJECT_ID}/stores/edge/submissions/preflight`] = () => ({
      body: report("edge", [{ ...requirement("edge.product", "The product exists in Partner Center (Product ID 1111) and the platform uploads to it through the Publish API."), status: "have" }]),
    });

    const out = JSON.parse(await submit({ action: "preflight", browsers: ["edge"], detail: true, api: PROD }));
    const row = (out.value.stores.edge.requirements.items as Row[]).find((item) => item.id === "edge.product") as Row;

    expect(row.how).toBe("The product exists in Partner Center (Product ID 1111) and the platform uploads to it through the Publish API.");
  });
});
