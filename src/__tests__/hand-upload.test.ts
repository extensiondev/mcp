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
