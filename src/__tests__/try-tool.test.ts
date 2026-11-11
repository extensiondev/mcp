import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { namesRegistryOrToken } from "../lib/package-address";
import { readTryPermissions } from "../lib/try-permissions";
import { openTryRun } from "../lib/try-runs";
import { handler } from "../tools/try";
import { storedZip } from "./fixtures/stored-zip";

const PROJECT = "acme/notes";

function build(sha: string, version: string, timestamp: string, overrides: Record<string, unknown> = {}) {
  return { id: sha, buildId: sha, sha, shortSha: sha, commit: `${sha}${"0".repeat(33)}`, status: "success", summaryStatus: "success", version, timestamp, browsers: ["chrome", "firefox", "edge"], ...overrides };
}

const BUILDS = {
  schemaVersion: 3,
  items: [
    build("aaaaaaa", "0.3.0", "2026-11-03T10:00:00Z", { browsers: ["firefox"] }),
    build("bbbbbbb", "0.3.0", "2026-11-02T10:00:00Z"),
    build("ccccccc", "0.4.0", "2026-11-04T10:00:00Z", { status: "failure", summaryStatus: "failure" }),
    build("ddddddd", "0.2.0", "2026-10-30T10:00:00Z"),
    build("dddd111", "0.1.0", "2026-10-01T10:00:00Z"),
  ],
};

function integrityReport(file: string, bytes: Buffer) {
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  return { schemaVersion: 2, ok: true, browser: "chrome", sha256, runId: "39297182150", artifacts: [{ name: file, expected: { bytes: bytes.length, sha256 }, received: { bytes: bytes.length, sha256 } }] };
}

describe("extension_try runs only the published build the person asked for, and refuses before anything stays on the machine", () => {
  let tmp: string;
  let saved: Record<string, string | undefined>;
  let prevFetch: typeof fetch;
  let routes: Record<string, () => Response>;
  let fetched: string[];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-try-"));
    saved = {};

    for (const key of ["XDG_CONFIG_HOME", "EXTENSION_DEV_API_URL", "EXTENSION_DEV_REGISTRY_URL", "EXTENSION_DEV_TOKEN", "EXTENSION_DEV_PROJECT", "EXTENSION_TRY_DIR"]) {
      saved[key] = process.env[key];
      delete process.env[key];
    }

    process.env.XDG_CONFIG_HOME = path.join(tmp, "config");
    process.env.EXTENSION_TRY_DIR = path.join(tmp, "tries");
    prevFetch = global.fetch;
    fetched = [];
    routes = { "/acme/notes/_extension-dev/builds/index.json": () => Response.json(BUILDS) };

    global.fetch = (async (url: string) => {
      const pathname = new URL(String(url)).pathname;
      fetched.push(pathname);
      const route = routes[pathname];

      return route ? route() : Response.json({ error: "not found" }, { status: 404 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = prevFetch;

    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const triesLeft = () => (fs.existsSync(path.join(tmp, "tries")) ? fs.readdirSync(path.join(tmp, "tries")) : []);

  it.each([
    [undefined, "chrome", "bbbbbbb", "0.3.0"],
    [undefined, "firefox", "aaaaaaa", "0.3.0"],
    ["0.2.0", "chrome", "ddddddd", "0.2.0"],
    ["v0.2.0", "chrome", "ddddddd", "0.2.0"],
    ["ddddddd", "chrome", "ddddddd", "0.2.0"],
  ])("version %s on %s downloads build %s, skipping failed builds and builds with no package for the browser", async (version, browser, sha, expected) => {
    const bytes = storedZip({ "background.js": "chrome.runtime.id" });
    routes[`/acme/notes/builds/${sha}/${browser}.zip`] = () => new Response(bytes);
    routes[`/acme/notes/builds/${sha}/artifact-integrity/${browser}.json`] = () => Response.json(integrityReport(`${browser}.zip`, Buffer.from("another file")));

    const answer = JSON.parse(await handler({ project: PROJECT, version, browser }));

    expect(answer.status).toBe("integrity-mismatch");
    expect(answer.value).toMatchObject({ buildId: sha, version: expected, browser, integrity: "mismatch", packageBytes: bytes.length });
    expect(fetched).toContain(`/acme/notes/builds/${sha}/${browser}.zip`);
    expect(triesLeft()).toEqual([]);
  });

  it.each([
    ["0.9.0", "not-found", "has no build matching"],
    ["ddd", "not-found", "has no build matching"],
    ["dddd", "not-found", "matches more than one build"],
    ["aaaaaaa", "no-package", "has no chrome package"],
  ])("version %s answers %s before any download", async (version, status, words) => {
    const answer = JSON.parse(await handler({ project: PROJECT, version }));

    expect(answer.status).toBe(status);
    expect(answer.error.message).toContain(words);
    expect(fetched.filter((p) => p.endsWith(".zip"))).toEqual([]);
  });

  it("refuses a private project's build list as not public and never prints a registry address, a token or a run id", async () => {
    routes["/acme/notes/_extension-dev/builds/index.json"] = () => Response.json({ error: "unauthorized", reason: "missing-token" }, { status: 401 });

    const raw = await handler({ project: PROJECT });
    const answer = JSON.parse(raw);

    expect(answer).toMatchObject({ ok: false, status: "not-public", error: { code: "E_AUTH_REQUIRED" } });
    expect(namesRegistryOrToken(raw)).toEqual([]);
    expect(raw).not.toMatch(/actions\/runs|runId/);
  });

  it("unpacks a verified package into the try folder and removes the folder when the package has no manifest", async () => {
    const bytes = storedZip({ "background.js": "chrome.runtime.id" });
    routes["/acme/notes/builds/bbbbbbb/chrome.zip"] = () => new Response(bytes);
    routes["/acme/notes/builds/bbbbbbb/artifact-integrity/chrome.json"] = () => Response.json(integrityReport("chrome.zip", bytes));

    const raw = await handler({ project: PROJECT });
    const answer = JSON.parse(raw);

    expect(answer).toMatchObject({ status: "package-refused", value: { integrity: "verified", buildId: "bbbbbbb" } });
    expect(answer.error.message).toContain("no readable manifest.json");
    expect(triesLeft()).toEqual([]);
    expect(raw).not.toContain("39297182150");
  });

  it.each([
    ["safari", "needs signing"],
    ["brave", "brave is not a browser extension_try launches"],
  ])("refuses %s by name without reading the registry", async (browser, words) => {
    const answer = JSON.parse(await handler({ project: PROJECT, browser }));

    expect(answer).toMatchObject({ ok: false, status: "unsupported-browser", error: { code: "E_UNSUPPORTED_BROWSER" } });
    expect(answer.error.message).toContain(words);
    expect(fetched).toEqual([]);
  });

  it("tells a safari caller that no Mac is needed to reach the App Store, and what the lane does", async () => {
    const answer = JSON.parse(await handler({ project: PROJECT, browser: "safari" }));
    const words = `${answer.error.message} ${answer.hint}`;

    expect(words).toContain("No Mac is needed to reach the App Store");
    expect(words).toContain("one approval");
    expect(words).toContain("encrypted at rest");
    expect(words).toContain("no hand upload");
    expect(words).not.toContain("macOS app");
    expect(fetched).toEqual([]);
  });

  it("refuses a url that is not a web page", async () => {
    const answer = JSON.parse(await handler({ project: PROJECT, url: "chrome://settings" }));

    expect(answer.status).toBe("bad-request");
    expect(fetched).toEqual([]);
  });

  it("close removes every try folder of the project, and only that project's", async () => {
    const mine = openTryRun({ project: PROJECT, browser: "chrome", buildId: "bbbbbbb", version: "0.3.0" });
    const theirs = openTryRun({ project: "acme/other", browser: "chrome", buildId: "eeeeeee", version: "1.0.0" });
    fs.mkdirSync(path.join(mine.dir, "profile"));

    const answer = JSON.parse(await handler({ project: PROJECT, action: "close" }));

    expect(answer).toMatchObject({ ok: true, status: "closed", value: { closed: [{ buildId: "bbbbbbb", browser: "chrome", removed: true }] } });
    expect(fs.existsSync(mine.dir)).toBe(false);
    expect(fs.existsSync(theirs.dir)).toBe(true);

    const again = JSON.parse(await handler({ project: PROJECT, action: "close" }));
    expect(again.status).toBe("nothing-to-close");
  });
});

describe("extension_try says in plain words what the extension can reach, from its manifest", () => {
  it.each([
    [{ host_permissions: ["<all_urls>"] }, true, "every website you visit"],
    [{ content_scripts: [{ matches: ["*://*/*"], js: ["c.js"] }] }, true, "every website you visit"],
    [{ manifest_version: 2, permissions: ["https://mail.example.com/*", "storage"] }, false, "https://mail.example.com/*"],
    [{ permissions: ["storage"] }, false, "no website access up front"],
  ])("%j reads every site %s", (manifest, everySite, words) => {
    const facts = readTryPermissions({ manifest_version: 3, name: "N", ...manifest });

    expect(facts.everySite).toBe(everySite);
    expect(facts.plainWords[0]).toContain(words);
  });

  it("names a permission it has no words for instead of dropping it, and says optional ones are asked for later", () => {
    const facts = readTryPermissions({ permissions: ["tabs", "fancyNewApi"], optional_host_permissions: ["https://*/*"] });

    expect(facts.plainWords).toEqual(expect.arrayContaining([
      "tabs: it can see the address and title of every tab you open.",
      expect.stringContaining("fancyNewApi: a permission this tool has no plain words for"),
      "It can ask later for https://*/*, and the browser asks you first.",
    ]));

    expect(facts.everySite).toBe(false);
  });
});
