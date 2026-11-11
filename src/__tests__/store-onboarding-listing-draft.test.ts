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

import { describe, expect, it } from "vitest";

import { NEVER_PREFILLED } from "../lib/store-bring-list";
import { listingForStore, parseStoreMdListing } from "../lib/store-md-listing";
import { handler as submit } from "../tools/submit";
import { API, PROJECT_ROUTE, useProjectRoutes } from "./fixtures/project-routes";
import { solidPng } from "./fixtures/png";
import { rgbaPng } from "./fixtures/png-alpha";

type Row = Record<string, any>;

const PREFLIGHT = (store: string) => `${PROJECT_ROUTE}/stores/${store}/submissions/preflight`;
const STORES = ["chrome", "edge", "firefox", "safari"] as const;
const WALK: Record<string, Row> = JSON.parse(fs.readFileSync(fileURLToPath(new URL("./fixtures/preflight-four-stores.json", import.meta.url)), "utf8"));

function freshReports(): Record<string, Row> {
  const reports: Record<string, Row> = structuredClone(WALK);

  for (const store of STORES) {
    const report = reports[store]!;
    delete report.connection;
    report.requirements.items = report.requirements.items.map((row: Row) => (row.status === "have" ? { ...row, status: "missing", actual: "not on file" } : row));
  }

  return reports;
}

function project(files: Record<string, string | Buffer>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "extdev-draft-"));

  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), body);
  }

  return root;
}

const MANIFEST = JSON.stringify({
  manifest_version: 3,
  name: "__MSG_appName__",
  description: "Counts the words on any page you open.",
  default_locale: "en",
  permissions: ["storage", "activeTab"],
  host_permissions: ["https://api.wordcount.example/*"],
  background: { service_worker: "background.js" },
  action: { default_popup: "popup.html" },
  content_scripts: [{ matches: ["<all_urls>"], js: ["content.js"] }],
  "firefox:browser_specific_settings": { gecko: { id: "wc@example.org", data_collection_permissions: { required: ["websiteContent"] } } },
});

const FILES = {
  "package.json": JSON.stringify({ name: "word-count", version: "1.2.0" }),
  "src/manifest.json": MANIFEST,
  "src/_locales/en/messages.json": JSON.stringify({ appName: { message: "Word Count" } }),
  "src/background.js": 'chrome.runtime.onMessage.addListener(async (message) => {\n  // fetch("https://ignored.example.org") is a comment\n  const reply = await fetch("https://api.wordcount.example/v1/count", { method: "POST" });\n  return reply.json();\n});\n',
  "src/content.js": "const words = document.body.innerText.split(/\\s+/).length;\nchrome.runtime.sendMessage({ words });\n",
  "src/background.test.js": 'fetch("https://tests.example.net")\n',
  "tools/record-demo.mjs": 'await fetch("https://recorder.example.net/upload");\n',
  "pages/welcome.html": '<script src="https://cdn.welcome.example/widget.js"></script>\n',
};

const DECLARATION_WORDS = /data usage|collects|does not collect|no data|remote code:|privacy practices|age rating:|content rights:/i;

const CHROMEWEBSTORE_MD = `# Chrome Web Store Listing - Word Count

> Last Updated: 2026-11-10

## Store Listing

**Extension Name** [REQUIRED]
<!-- Must match manifest.json "name". Max 75 characters. -->
Word Count

**Short Description** [REQUIRED]
Counts the words on any page you open.

**Detailed Description** [REQUIRED]
Word Count shows how many words are on the page you are reading.

Open any page, click the toolbar button, and the count appears.

Nothing leaves your computer.

**Category** [REQUIRED]
Productivity

**Single Purpose** [REQUIRED]
Counts the words on the page the user has open.

**Primary Language** [REQUIRED]
English

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|-------|-----------|--------|----------|
| Store Icon [REQUIRED] | 128×128 PNG | ⬜ Not created | |

## Permissions Justification

| Permission | Type | Justification |
|------------|------|---------------|
| storage | permissions | Remembers whether the badge is shown. |
| activeTab | permissions | Reads the open tab when the user clicks the button. |
| https://api.wordcount.example/* | host_permissions | Sends the count to the user's own dashboard when they opt in. |

## Privacy & Data Use

### Data Collection

**Does the extension collect user data?** No

### Data Use Certification
- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

## Privacy Policy

**Privacy Policy URL** [REQUIRED]
https://wordcount.example/privacy

## Distribution

**Visibility**: Unlisted
**Regions**: All regions / [List specific regions]

## Developer Info

**Publisher Name** [REQUIRED]
Acme

**Contact Email** [REQUIRED]
hello@wordcount.example

**Support URL / Email** [RECOMMENDED]
https://github.com/acme/word-count/issues

**Homepage URL** [RECOMMENDED]
https://wordcount.example

## Version History

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| | | | Draft |

## Review Notes

### Known Issues / Limitations

### Rejection History
`;

describe("extension_submit preflight drafts STORE.md from the code and leaves every data-use answer to the owner", () => {
  const platform = useProjectRoutes("extdev-draft-");

  async function preflight(root: string, browsers: readonly string[] = STORES, have: string[] = []): Promise<Row> {
    const reports = freshReports();

    for (const store of STORES) {
      reports[store]!.requirements.items = reports[store]!.requirements.items.map((row: Row) => (have.includes(row.id) ? { ...row, status: "have" } : row));
    }

    platform.login();

    for (const store of STORES) platform.routes[`POST ${PREFLIGHT(store)}`] = () => ({ body: reports[store] });

    const out = JSON.parse(await submit({ action: "preflight", browsers: [...browsers], projectPath: root, api: API }));

    return out.value.readiness;
  }

  it("drafts a STORE.md holding only the manifest's own name and summary, which the reader takes back for every store", async () => {
    const draft = (await preflight(project(FILES))).listingDraft;

    expect(draft.exists).toBe(false);
    expect(draft.fromCode.map((line: Row) => [line.line, line.value, line.from])).toEqual([
      ["- Name:", "Word Count", "src/_locales/en/messages.json appName"],
      ["- Summary:", "Counts the words on any page you open.", "src/manifest.json description"],
    ]);

    const parsed = parseStoreMdListing(draft.storeMd);

    for (const store of STORES) {
      expect(listingForStore(parsed, store).listing).toEqual({ title: "Word Count", shortDescription: "Counts the words on any page you open." });
    }

    expect(draft.storeMd).not.toMatch(/## Privacy/);
    expect(draft.storeMd).not.toMatch(DECLARATION_WORDS);
  });

  it("hands the prose fields to the agent with the code facts and limits to write them from", async () => {
    const draft = (await preflight(project(FILES))).listingDraft;
    const byField = (field: string): Row[] => draft.agentWrites.filter((line: Row) => line.field === field);

    expect(byField("fullDescription")).toEqual([expect.objectContaining({ line: "- Description:", section: "## Listing", stores: ["chrome", "firefox", "edge", "safari"] })]);
    expect(byField("fullDescription")[0].limit).toContain("16,000 characters");
    expect(byField("fullDescription")[0].facts[0]).toBe('The manifest description reads "Counts the words on any page you open."');
    expect(byField("permissionJustifications")).toHaveLength(1);
    expect(byField("permissionJustifications")[0]).toMatchObject({ section: "## Chrome Web Store", stores: ["chrome", "edge"] });
    expect(byField("singlePurpose").map((line: Row) => [line.section, line.stores])).toEqual([["## Chrome Web Store", ["chrome", "edge"]]]);
    expect(byField("permissionJustifications")[0].facts[0]).toBe("Write one bullet per entry, keyed as the manifest spells it: storage, activeTab, https://api.wordcount.example/*.");
    expect(byField("singlePurpose")[0].facts).toEqual(expect.arrayContaining(["The manifest declares a background script, a toolbar button, content scripts."]));
    expect(byField("reviewerNotes").map((line: Row) => [line.section, line.stores])).toEqual([["## Firefox Add-ons", ["firefox"]], ["## Safari", ["safari"]]]);
    expect(byField("releaseNotes")[0].facts).toEqual(["package.json reads version 1.2.0.", "The repository has no CHANGELOG.md."]);
    expect(byField("appStoreName")).toEqual([]);
  });

  it("answers each open data-use and privacy declaration with code facts alone, never a proposed answer", async () => {
    const readiness = await preflight(project(FILES));
    const answers: Row[] = readiness.listingDraft.ownerAnswers;
    const open = [...NEVER_PREFILLED].filter((id) => [...readiness.personDecides.required, ...(readiness.personDecides.optional ?? [])].includes(id));

    expect(answers.map((answer) => answer.id).sort()).toEqual([...open].sort());
    expect(answers.length).toBeGreaterThan(0);

    for (const answer of answers) expect(Object.keys(answer).sort()).toEqual(["asks", "codeFacts", "id"]);

    const chrome = answers.find((answer) => answer.id === "chrome.data_usage")!;

    expect(chrome.codeFacts).toEqual(expect.arrayContaining([
      "The manifest asks for these permissions: storage, activeTab.",
      "Content scripts run on: <all_urls>.",
      "The source has 1 network call site: src/background.js:3 (fetch).",
      "URLs in the source name these hosts: api.wordcount.example, cdn.welcome.example.",
      "3 source files under src/, pages/ were read, what the build ships; tests, dist and node_modules were not.",
    ]));

    const firefox = answers.find((answer) => answer.id === "firefox.data_collection_permissions")!;

    expect(firefox.codeFacts[0]).toBe('The manifest declares browser_specific_settings.gecko.data_collection_permissions as {"required":["websiteContent"]}.');
    expect(answers.find((answer) => answer.id === "chrome.remote_code")!.codeFacts[0]).toBe("The source has 1 eval, new Function or remote script site: pages/welcome.html:1 (a remote <script src>).");
    expect(readiness.listingDraft.say).toContain("propose no answer");

    const declared = await preflight(project(FILES), STORES, ["firefox.data_collection_permissions"]);
    const ids = (declared.listingDraft.ownerAnswers as Row[]).map((answer) => answer.id);

    expect(ids).not.toContain("firefox.data_collection_permissions");
    expect(ids).toContain("chrome.data_usage");
  });

  it("drafts no line STORE.md already carries", async () => {
    const root = project({ ...FILES, "STORE.md": "# Word Count\n\n## Listing\n\n- Name: Word Count Pro\n- Description:\n\n  Counts words.\n" });
    const draft = (await preflight(root)).listingDraft;

    expect(draft.exists).toBe(true);
    expect(draft.storeMd).toBeUndefined();
    expect(draft.fromCode.map((line: Row) => line.field)).toEqual(["shortDescription"]);
    expect(draft.agentWrites.map((line: Row) => line.field)).not.toContain("fullDescription");
    expect(draft.say).toMatch(/^Add "- Summary:" under "## Listing", read from the manifest;/);
  });

  it("asks for a shorter App Store name only when the manifest name is over 30 characters", async () => {
    const long = { ...FILES, "src/_locales/en/messages.json": JSON.stringify({ appName: { message: "Word Count for Every Page You Read" } }) };
    const draft = (await preflight(project(long), ["safari"])).listingDraft;

    expect(draft.agentWrites.map((line: Row) => line.field)).toContain("appStoreName");
  });

  it("asks Edge alone for its single purpose under its own section", async () => {
    const draft = (await preflight(project(FILES), ["edge"])).listingDraft;

    expect(draft.agentWrites.filter((line: Row) => line.field === "singlePurpose").map((line: Row) => [line.section, line.stores])).toEqual([["## Edge Add-ons", ["edge"]]]);
  });

  it("judges each store's screenshot folder by the store's own size and alpha rule, and names the capture for an empty one", async () => {
    const root = project({
      ...FILES,
      "store/screenshots/chrome/01.png": solidPng(1280, 800),
      "store/screenshots/edge/01.png": solidPng(1440, 900),
      "store/screenshots/firefox/01.png": rgbaPng(1280, 800),
    });
    const gallery: Row[] = (await preflight(root)).listingDraft.gallery;
    const of = (store: string): Row => gallery.find((entry) => entry.store === store)!;

    expect(gallery.map((entry) => entry.store)).toEqual(["chrome", "firefox", "edge", "safari"]);
    expect(of("chrome")).toMatchObject({ ready: true, shots: [{ file: "store/screenshots/chrome/01.png", size: "1280x800", clears: true }] });
    expect(of("edge")).toMatchObject({ ready: false, shots: [{ size: "1440x900", clears: false }] });
    expect(of("edge").say).toContain('extension_screenshot store:"edge"');
    expect(of("firefox")).toMatchObject({ ready: true, shots: [{ clears: true }] });
    expect(of("safari").ready).toBe(false);
    expect(of("safari")).toMatchObject({ source: "none", say: expect.stringContaining('extension_screenshot store:"safari"') });

    const alpha = project({ ...FILES, "store/screenshots/chrome/01.png": rgbaPng(1280, 800) });
    const chromeAlpha = ((await preflight(alpha, ["chrome"])).listingDraft.gallery as Row[])[0]!;

    expect(chromeAlpha).toMatchObject({ ready: false, shots: [{ clears: false, reason: "the Chrome Web Store refuses an alpha channel" }] });
  });

  it("measures the files STORE.md's Screenshots line names when a store's folder is empty, and offers no capture", async () => {
    const storeMd = "# Word Count\n\n## Listing\n\n- Screenshots: store/shot-1.png, store/shot-2.png\n";
    const gallery: Row[] = (await preflight(project({ ...FILES, "STORE.md": storeMd, "store/shot-1.png": solidPng(1280, 800), "store/shot-2.png": solidPng(1280, 800) }))).listingDraft.gallery;

    for (const entry of gallery) {
      expect(entry).toMatchObject({ source: "store-md", shots: [{ file: "store/shot-1.png", size: "1280x800" }, { file: "store/shot-2.png", size: "1280x800" }] });
      expect(entry.say).not.toContain("extension_screenshot");
    }

    expect(gallery.filter((entry) => entry.ready).map((entry) => entry.store)).toEqual(["chrome", "firefox", "edge", "safari"]);
  });

  it("names a STORE.md screenshot that is not on disk in say and does not count it", async () => {
    const storeMd = "# Word Count\n\n## Listing\n\n- Screenshots: store/shot-1.png, store/gone.png\n";
    const chrome: Row = ((await preflight(project({ ...FILES, "STORE.md": storeMd, "store/shot-1.png": solidPng(1280, 800) }), ["chrome"])).listingDraft.gallery as Row[])[0]!;

    expect(chrome).toMatchObject({ source: "store-md", ready: true, shots: [{ file: "store/shot-1.png" }] });
    expect(chrome.say).toContain("Not found: store/gone.png");
  });

  it("keeps the store's own folder ahead of the files STORE.md names", async () => {
    const storeMd = "# Word Count\n\n## Listing\n\n- Screenshots: store/shot-1.png\n";
    const chrome: Row = ((await preflight(project({ ...FILES, "STORE.md": storeMd, "store/shot-1.png": solidPng(1280, 800), "store/screenshots/chrome/01.png": solidPng(640, 400) }), ["chrome"])).listingDraft.gallery as Row[])[0]!;

    expect(chrome).toMatchObject({ source: "folder", shots: [{ file: "store/screenshots/chrome/01.png" }] });
  });

  it("prefills the lines Google's CHROMEWEBSTORE.md already holds, names them in prefilledFrom, and copies no data-use answer (ledger 512)", async () => {
    const draft = (await preflight(project({ ...FILES, "CHROMEWEBSTORE.md": CHROMEWEBSTORE_MD }))).listingDraft;

    expect(draft.exists).toBe(false);
    expect(draft.fromCode.map((line: Row) => line.field)).toEqual(["title", "shortDescription"]);
    expect(draft.prefilledFrom).toMatchObject({
      file: "CHROMEWEBSTORE.md",
      fields: ["fullDescription", "categories", "privacyPolicyUrl", "homepageUrl", "singlePurpose", "permissionJustifications", "visibility"],
      stillEmpty: ["supportEmail"],
    });

    expect((draft.prefilledFrom.lines as Row[]).map((line) => [line.line, line.section, line.from])).toEqual([
      ["- Description:", "## Listing", "CHROMEWEBSTORE.md **Detailed Description**"],
      ["- Category:", "## Listing", "CHROMEWEBSTORE.md **Category**"],
      ["- Privacy policy URL:", "## Privacy and data use", "CHROMEWEBSTORE.md **Privacy Policy URL**"],
      ["- Homepage:", "## Listing", "CHROMEWEBSTORE.md **Homepage URL**"],
      ["### Single purpose", "## Chrome Web Store", "CHROMEWEBSTORE.md **Single Purpose**"],
      ["### Permissions justification", "## Chrome Web Store", "CHROMEWEBSTORE.md ## Permissions Justification"],
      ["- Visibility:", "## Chrome Web Store", "CHROMEWEBSTORE.md **Visibility**"],
    ]);

    const parsed = parseStoreMdListing(draft.storeMd);

    expect(listingForStore(parsed, "chrome").listing).toEqual({
      title: "Word Count",
      shortDescription: "Counts the words on any page you open.",
      fullDescription: "Word Count shows how many words are on the page you are reading.\n\nOpen any page, click the toolbar button, and the count appears.\n\nNothing leaves your computer.",
      categories: ["Productivity"],
      privacyPolicyUrl: "https://wordcount.example/privacy",
      homepageUrl: "https://wordcount.example",
      singlePurpose: "Counts the words on the page the user has open.",
      permissionJustifications: [
        { permission: "storage", justification: "Remembers whether the badge is shown." },
        { permission: "activeTab", justification: "Reads the open tab when the user clicks the button." },
        { permission: "https://api.wordcount.example/*", justification: "Sends the count to the user's own dashboard when they opt in." },
      ],
      visibility: "unlisted",
    });

    expect(listingForStore(parsed, "edge").listing.singlePurpose).toBe("Counts the words on the page the user has open.");
    expect(draft.storeMd).not.toMatch(DECLARATION_WORDS);
    expect(draft.storeMd).not.toContain("Data is NOT sold");
    expect(draft.storeMd).not.toContain("English");
    expect(draft.agentWrites.map((line: Row) => line.field)).toEqual(["subtitle", "searchTerms", "reviewerNotes", "reviewerNotes", "certificationNotes", "releaseNotes"]);
    expect(draft.say).toMatch(/^StoreMd is a STORE\.md to save as it is, read from the manifest and CHROMEWEBSTORE\.md;/);
    expect(draft.prefilledFrom.say).toContain("CHROMEWEBSTORE.md filled `- Description:`, `- Category:`, `- Privacy policy URL:`, `- Homepage:`, `### Single purpose`, `### Permissions justification` and `- Visibility:`; still empty for Chrome: `- Support email:`.");
    expect(draft.prefilledFrom.say).toContain("Not taken from it: Primary Language is the dashboard's Store listing tab language");
    expect(draft.prefilledFrom.say).toContain("the Privacy & Data Use answers are yours to give on the dashboard's Privacy tab; this server never copies a data-use answer");
    expect(draft.prefilledFrom.say).toContain("Support URL / Email holds a URL");
    expect(draft.prefilledFrom.notMapped).toHaveLength(5);
    expect(draft.prefilledFrom.say).not.toContain("Regions");
    expect(draft.prefilledFrom.say).not.toContain("Version History");
  });

  it("prefills only the Chrome lines an existing STORE.md lacks from CHROMEWEBSTORE.md and says where each goes (ledger 512)", async () => {
    const storeMd = "# Word Count\n\n## Listing\n\n- Name: Word Count\n- Summary: Counts the words on any page you open.\n- Description:\n\n  Counts words.\n\n## Chrome Web Store\n";
    const draft = (await preflight(project({ ...FILES, "STORE.md": storeMd, "CHROMEWEBSTORE.md": CHROMEWEBSTORE_MD }))).listingDraft;

    expect(draft.exists).toBe(true);
    expect(draft.storeMd).toBeUndefined();
    expect(draft.fromCode).toEqual([]);
    expect(draft.prefilledFrom.fields).toEqual(["categories", "privacyPolicyUrl", "homepageUrl", "singlePurpose", "permissionJustifications", "visibility"]);
    expect(draft.agentWrites.map((line: Row) => line.field)).not.toContain("singlePurpose");
    expect(draft.agentWrites.map((line: Row) => line.field)).not.toContain("permissionJustifications");
    expect(draft.say).toMatch(
      /^Add "- Category:" and "- Homepage:" under "## Listing", "- Privacy policy URL:" under "## Privacy and data use" and "### Single purpose", "### Permissions justification" and "- Visibility:" under "## Chrome Web Store", read from CHROMEWEBSTORE\.md;/,
    );
  });

  it("answers no draft without a projectPath", async () => {
    const reports = freshReports();
    platform.login();

    for (const store of STORES) platform.routes[`POST ${PREFLIGHT(store)}`] = () => ({ body: reports[store] });

    const out = JSON.parse(await submit({ action: "preflight", browsers: [...STORES], api: API }));

    expect(out.value.readiness.listingDraft).toBeUndefined();
  });
});
