// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import { CALL_TIMEOUT, SESSION_BROWSER, SESSION_PROJECT_PATH } from "../lib/common-schema";
import { envelope } from "../lib/envelope";
import { noSessionEnvelope } from "../lib/production-receipt";
import { ambiguousSessionRefusal, resolveSessionBrowser } from "../lib/session-browser";
import { isChromiumFamily, isGeckoFamily, WEBKIT_FAMILY } from "../lib/browser-family";
import { CDP_PORT_MISSING_HINT, RDP_PORT_MISSING_HINT, resolveCdpPort, resolveRdpPort } from "../lib/cdp-port";
import { listDocumentTargets, listPageTargets, matchTargetsByUrl, type PageTarget } from "../lib/cdp-targets";
import { readExtensionPageTargets } from "../lib/cdp-extension-page";
import { rdpListTabs, type RdpTab } from "../lib/rdp";
import { captureGeckoSidebarPanel } from "../lib/gecko-sidebar-capture";
import { geckoDocumentTab, geckoExtensionTabsByUrl, isExtensionUrl } from "../lib/extension-surfaces";
import {
  AMBIGUOUS_TARGET_HINT,
  findGeckoTab,
  geckoRecency,
  geckoTabRef,
  identicalPickWarning,
  pickTarget,
  TARGET_ID_PROPERTY,
  targetNotFound,
  type TargetFamily,
  type TargetRef,
} from "../lib/target-pick";
import {
  navigableUrl,
  pageMatchesUrl,
  readWebDriverSession,
  readWebDriverUnavailableReason,
  WebDriverClient,
  webdriverSessionEnded,
  webdriverSessionEndedHint,
  webdriverSessionEndedMessage,
  webdriverSessionMissingHint,
} from "../lib/webdriver";
import { BEHIND_WINDOW_CAPTURED, captureCdpPage, type BehindWindow } from "../lib/capture-behind-window";
import { hiddenTabSentence, type HiddenTab } from "../lib/capture-hidden-tab";
import {
  captureRdpTab,
  pngDimensions,
  resolveScreenshotPath,
  writeScreenshot,
  type CaptureOutcome,
  type CaptureSize,
} from "../lib/capture";
import { flattenPngAlpha, pngHeader } from "../lib/png-flat";
import { clearsStoreRow, STORE_SCREENSHOT_SPECS, storeSizeSentence } from "../lib/store-screenshot-sizes";
import {
  capturePlan,
  expectedPixels,
  isStoreChoice,
  nextStoreScreenshotPath,
  PRESET_SENTENCE,
  STORE_CHOICES,
  storeScreenshotsFolder,
  type CaptureFamily,
  type StoreChoice,
} from "../lib/store-capture";
import { resolveExtensionId, surfaceDocument, SURFACE_MANIFEST_KEYS } from "./open";

import type { ListingStore } from "../lib/store-md-declarations";

const COMMAND = "extension_screenshot";
const SURFACES = ["popup", "options", "sidebar", "newtab", "history", "bookmarks"];
const DEFAULT_TIMEOUT_MS = 15_000;

export const schema = {
  name: COMMAND,
  description:
    "Take a screenshot of one open extension surface (popup, options, sidebar, newtab, history, bookmarks) or web page in a live extension_dev or extension_start session as a .png file. It asks the browser for the page's own pixels over the debug port (CDP on Chromium, the screenshot actor on Firefox, WebDriver on Safari, web pages only); it never captures the screen and never brings a window forward: on Chromium a page behind other windows or in a hidden tab is shown briefly for the capture (value.behindWindow, value.hiddenTab). Open the surface with extension_open first. `targetId` (from extension_open or extension_dom_snapshot listTargets) captures that exact page; a url matching several tabs of one page captures the most recently active one and warns. width and height set the Chromium viewport, resize the Safari window and crop from the top left on Firefox; deviceScaleFactor sets the pixel ratio. `store` (chrome, firefox, edge, safari or all) captures a store listing screenshot at that store's own size as a 24-bit PNG with no alpha into store/screenshots/<store>/, where extension_submit sync-listing picks it up; one call per view. The file goes under dist/extension-js/<browser>/screenshots unless `path` names one; the answer gives path and pixel size.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: SESSION_PROJECT_PATH,
      browser: SESSION_BROWSER,
      context: {
        type: "string",
        enum: ["page", ...SURFACES],
        default: "page",
        description: "page captures a tab picked by `url` (or the only or selected one); the rest capture that extension surface, which must already be open.",
      },
      url: { type: "string", description: "page: the tab whose url contains this (a web address or the extension's own page url)." },
      targetId: TARGET_ID_PROPERTY,
      width: { type: "number", description: "Viewport width in CSS pixels (Chromium renders at it; Firefox crops to it)." },
      height: { type: "number", description: "Viewport height in CSS pixels (Chromium renders at it; Firefox crops to it)." },
      deviceScaleFactor: { type: "number", description: "Pixel ratio of the image, 0.5 to 4. Defaults to the browser's own on Chromium and 1 on Firefox; Safari answers at the display's own ratio. Set by store when it is given." },
      store: {
        type: "string",
        enum: [...STORE_CHOICES],
        description:
          "Capture for this store's listing at the size it takes, with width, height and deviceScaleFactor set here (chrome, edge and firefox 1280x800 at 1x; safari 1440x900 at 2x, a 2880x1800 image) and the file written to store/screenshots/<store>/<n>.png, numbered from 01; passing any of the three beside store is refused. all on a Chromium session writes every store's file from the same page in one call (one capture for chrome, edge and firefox, a second for safari); all on Safari writes only the safari file and says which stores were skipped. A safari file made outside Safari carries a warning, since Apple's review wants the extension running in Safari. extension_submit action:\"sync-listing\" browsers:[<store>] reads the folder on its own, in filename order.",
      },
      path: {
        type: "string",
        description:
          "Where to write the image, relative to projectPath and inside it: a file name ending in .png (shots/home.png), or a folder with a trailing slash (shots/) that gets a timestamped .png. A path outside projectPath, or a file name that does not end in .png, is refused with E_BAD_REQUEST, so no other file is ever overwritten. Defaults to dist/extension-js/<browser>/screenshots.",
      },
      timeout: CALL_TIMEOUT,
    },
    required: ["projectPath"],
  },
};

interface Args extends CaptureSize {
  projectPath: string;
  browser?: string;
  context?: string;
  url?: string;
  targetId?: string;
  path?: string;
  store?: string;
  forStore?: string;
  timeout?: number;
}

type Shooter = (size: CaptureSize) => Promise<CaptureOutcome>;

interface StoreFile {
  store: ListingStore;
  path: string;
  width: number;
  height: number;
  clears: boolean;
  reason?: string;
}

function refuse(status: string, code: string, message: string, hint?: string, value?: unknown): string {
  return envelope({ ok: false, command: COMMAND, status, error: { code, message }, ...(value ? { value } : {}), ...(hint ? { hint } : {}) });
}

function badSize(args: Args): string | null {
  for (const key of ["width", "height"] as const) {
    const n = args[key];
    if (n !== undefined && !(Number.isInteger(n) && n > 0 && n <= 8192)) return `${key} must be a whole number of CSS pixels from 1 to 8192.`;
  }

  const scale = args.deviceScaleFactor;
  if (scale !== undefined && !(typeof scale === "number" && scale >= 0.5 && scale <= 4)) return "deviceScaleFactor must be from 0.5 to 4.";

  return null;
}

function captured(
  args: Args,
  browser: string,
  context: string,
  outcome: CaptureOutcome,
  url: string,
  transport: string,
  warnings: Array<string | null> = [],
  targetId?: string,
  behindWindow?: BehindWindow,
  hiddenTab?: HiddenTab,
): string {
  if (!outcome.ok) return captureFailure(outcome, url, behindWindow);

  const png = outcome.png;
  const size = pngDimensions(png);
  if (!size) return refuse("capture-failed", "E_CAPTURE_FAILED", `The browser answered data for ${url} that is not a .png image.`);

  const written = writeScreenshot(args.projectPath, browser, context, png, args.path);
  if (!written.ok) return refuse("bad-request", "E_BAD_REQUEST", written.message, written.hint);

  const file = written.file;

  return envelope({
    ok: true,
    command: COMMAND,
    status: "captured",
    value: { browser, context, url, ...(targetId ? { targetId } : {}), ...(behindWindow?.tried ? { behindWindow } : {}), ...(hiddenTab ? { hiddenTab } : {}), path: file, width: size.width, height: size.height, bytes: png.length, transport },
    warnings,
    hint: `The image is ${file} (${size.width} x ${size.height} pixels). Open it with your image reader to look at it.`,
  });
}

function captureFailure(outcome: CaptureOutcome & { ok: false }, url: string, behindWindow?: BehindWindow): string {
  const behind = behindWindow?.tried
    ? behindWindow.shown
      ? " This tool already showed a blank tab in the page's window and retried, and the page still did not paint."
      : ` This tool could not show another tab in the page's window to get it painted: ${behindWindow.reason}.`
    : "";

  return refuse(
    outcome.timedOut ? "capture-timeout" : "capture-failed",
    outcome.timedOut ? "E_CAPTURE_TIMEOUT" : "E_CAPTURE_FAILED",
    `The browser did not hand back an image of ${url}: ${outcome.message}`,
    outcome.timedOut
      ? `The page did not paint within the budget.${behind} This tool never brings a window forward; run the session headless (the default), or retry with a larger timeout.`
      : "Confirm the session is ready (extension_wait) and the page is still open, then retry.",
  );
}

const storeChoiceOf = (args: Args): StoreChoice | null => (isStoreChoice(args.store) ? args.store : null);

function storeFileLine(file: StoreFile): string {
  const name = STORE_SCREENSHOT_SPECS[file.store].name;

  return file.clears
    ? `${file.path} (${file.width} x ${file.height} pixels) clears the screenshot row of ${name}`
    : `${file.path} (${file.width} x ${file.height} pixels) does not clear the screenshot row of ${name}: ${file.reason}. ${storeSizeSentence(file.store)}`;
}

/* @invariant A STORE CAPTURE IS MEASURED, NEVER ASSUMED. Chromium renders
 * the preset exactly; Safari's WebDriver answers its window at the
 * display's own pixel ratio, so the file is measured after the capture and
 * a size other than the preset's pixels is said in a warning with the size
 * Safari answered, rather than filed silently as a listing screenshot the
 * store would refuse (the Rebeccat walk made its 2880x1800 files by hand).
 */
async function capturedForStores(
  args: Args,
  browser: string,
  context: string,
  family: CaptureFamily,
  shoot: Shooter,
  url: string,
  transport: string,
  warnings: Array<string | null> = [],
  targetId?: string,
): Promise<string> {
  const choice = args.store as StoreChoice;
  const plan = capturePlan(choice, family);
  const files: StoreFile[] = [];
  const notes: Array<string | null> = [...warnings];

  for (const shot of plan.shots) {
    const outcome = await shoot(shot.preset);
    if (!outcome.ok) return captureFailure(outcome, url);

    const flat = flattenPngAlpha(outcome.png);
    if ("problem" in flat) return refuse("capture-failed", "E_CAPTURE_FAILED", `The browser answered ${flat.problem} for ${url}, which this tool cannot flatten for a store listing.`);

    const measured = `${flat.width}x${flat.height}`;
    const expected = expectedPixels(shot.preset);

    if (measured !== expected) {
      notes.push(
        `${browser === "safari" ? "Safari" : browser} answered a ${measured} image for a ${shot.preset.width}x${shot.preset.height} window, not ${expected}: the display's pixel ratio is not ${shot.preset.deviceScaleFactor}, so the file is not at the size the ${shot.stores.join(", ")} preset names.`,
      );
    }

    const alpha = pngHeader(flat.png)?.alpha !== "none";

    for (const store of shot.stores) {
      const file = choice === "all" || !args.path ? nextStoreScreenshotPath(args.projectPath, store) : null;
      const written = file ? writeStoreFile(file, flat.png) : writeScreenshot(args.projectPath, browser, context, flat.png, args.path);
      if (!written.ok) return refuse("bad-request", "E_BAD_REQUEST", written.message, written.hint);

      files.push({ store, path: written.file, width: flat.width, height: flat.height, ...clearsStoreRow(store, flat.width, flat.height, alpha) });
    }
  }

  if (plan.skipped.length) {
    notes.push(`Only the safari file was written: Safari's WebDriver captures its own window at the display's pixel ratio, so ${plan.skipped.join(", ")} were skipped; capture them with store:"all" on a Chromium dev session.`);
  }

  if (family !== "webkit" && files.some((file) => file.store === "safari")) {
    notes.push(`The safari file was captured on ${browser}, not Safari: Apple's review wants the extension running in Safari, so capture it again with store:"safari" on a Safari dev session (extension_dev browser:"safari") before the listing push.`);
  }

  const single = files.length === 1 ? files[0]! : null;
  const stores = [...new Set(files.map((file) => file.store))];
  const door =
    choice === "all"
      ? `One call per view; extension_submit action:"sync-listing" browsers:[${stores.map((store) => `"${store}"`).join(", ")}] picks each store's files up from store/screenshots/<store>/.`
      : `One call per view; extension_submit action:"sync-listing" browsers:["${choice}"] picks the files up from ${storeScreenshotsFolder(choice)}/.`;
  const hint = single ? `The image is ${storeFileLine(single)}. ${door}` : `Wrote ${files.map(storeFileLine).join("; ")}. ${door}`;

  return envelope({
    ok: true,
    command: COMMAND,
    status: "captured",
    value: {
      browser,
      context,
      url,
      ...(targetId ? { targetId } : {}),
      store: choice,
      ...(single ? { path: single.path, width: single.width, height: single.height } : {}),
      files,
      transport,
    },
    warnings: notes,
    hint,
  });
}

function writeStoreFile(file: string, png: Buffer): { ok: true; file: string } {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, png);

  return { ok: true, file };
}

function surfaceDocumentOrRefusal(args: Args, browser: string, context: string): { document: string } | { refusal: string } {
  const document = surfaceDocument(args.projectPath, browser, context);
  if (document) return { document };

  const key = SURFACE_MANIFEST_KEYS[context] ?? context;

  return {
    refusal: refuse(
      "no-surface",
      "E_NO_SURFACE_DOCUMENT",
      `This extension declares no ${context}: nothing in its manifest sets ${key}, so there is no ${context} page to capture.`,
      `To add one, set ${key} in the manifest and rebuild.`,
    ),
  };
}

type Chosen<T> = { target: T; warning: string | null };

function chooseTarget<T>(
  matches: T[],
  wanted: string,
  ref: (t: T) => TargetRef,
  family: TargetFamily,
  options: { rank?: (a: T, b: T) => number; prefer?: (t: T) => boolean } = {},
): Chosen<T> | string {
  const pick = pickTarget(matches, ref, options.rank);

  if (pick.kind === "none") {
    return refuse("no-target", "E_NO_TARGET", `No open page matches ${wanted}, so there is nothing to capture.`, "Open it first with extension_open (url: this address), then retry. extension_dom_snapshot with listTargets: true lists what is open.");
  }

  if (pick.kind === "one") return { target: pick.target, warning: identicalPickWarning(ref(pick.target), pick.others.map(ref), family) };

  const preferred = options.prefer ? pick.candidates.filter(options.prefer) : [];
  if (preferred.length === 1) return { target: preferred[0], warning: null };

  return refuse(
    "ambiguous-target",
    "E_AMBIGUOUS_TARGET",
    `${pick.candidates.length} open pages that show different documents match ${wanted}; refusing to guess which one to capture.`,
    AMBIGUOUS_TARGET_HINT,
    { matchingTargets: pick.candidates.map(ref) },
  );
}

const pageRef = (t: PageTarget): TargetRef => ({ targetId: t.targetId, url: t.url });

async function onChromium(args: Args, browser: string, context: string, timeoutMs: number): Promise<string> {
  const resolved = await resolveCdpPort(args.projectPath, browser, { waitMs: Math.min(timeoutMs, 5_000), graceMs: 1_000, timeoutMs });

  if (!resolved) {
    return noSessionEnvelope({
      command: COMMAND,
      projectPath: args.projectPath,
      browser,
      need: "so there is no browser to ask for pixels",
      dev: { message: `No live ${browser} session with a debug port for this project, so there is no browser to ask for pixels. Start extension_dev and extension_wait for ready.`, hint: CDP_PORT_MISSING_HINT },
    });
  }

  let chosen: Chosen<PageTarget> | string;

  if (args.targetId) {
    let all: PageTarget[];

    try {
      all = await listDocumentTargets(resolved.port);
    } catch (error) {
      return refuse("cdp-failed", "E_CDP", `Could not list the session's page targets: ${error instanceof Error ? error.message : String(error)}`);
    }

    const found = all.find((t) => t.targetId === args.targetId);
    if (!found) return targetNotFound(COMMAND, args.targetId, all.map(pageRef), { projectPath: args.projectPath, browser });

    chosen = { target: found, warning: null };
  } else if (context === "page" && !isExtensionUrl(args.url)) {
    const pages = await listPageTargets(resolved.port).catch(() => [] as PageTarget[]);
    chosen = chooseTarget(args.url ? matchTargetsByUrl(pages, args.url) : pages.filter((t) => !isExtensionUrl(t.url)), args.url ?? "any open tab", pageRef, "chromium");
  } else {
    let wanted = args.url as string;

    if (context !== "page") {
      const doc = surfaceDocumentOrRefusal(args, browser, context);
      if ("refusal" in doc) return doc.refusal;

      const extensionId = await resolveExtensionId(args.projectPath, browser);
      if (!extensionId) return refuse("no-extension-id", "E_NO_EXTENSION_ID", "Could not resolve the extension id from the live session's CDP targets.", `Confirm the session is ready (extension_wait). ${CDP_PORT_MISSING_HINT}`);

      wanted = `chrome-extension://${extensionId}/${doc.document}`;
    }

    const read = await readExtensionPageTargets(resolved.port, wanted);
    if ("unreadable" in read) return refuse("cdp-failed", "E_CDP", `Could not list the session's page targets: ${read.unreadable}`);

    if (read.targets.length === 0) {
      return refuse(
        "no-target",
        "E_NO_TARGET",
        `No open page at ${wanted}, so there is nothing to capture. An extension page has a target only while it is open.`,
        context === "page" ? "Open it first with extension_open (url: this address), then retry." : `Open it first with extension_open surface: "${context}", then retry.`,
      );
    }

    chosen = chooseTarget(read.targets, wanted, pageRef, "chromium");
  }

  if (typeof chosen === "string") return chosen;

  const { target, warning } = chosen;
  const session = { projectPath: args.projectPath, browser };

  if (storeChoiceOf(args)) {
    const shoot: Shooter = async (size) => (await captureCdpPage(resolved.port, target.targetId, size, timeoutMs, session)).outcome;

    return capturedForStores(args, browser, context, "chromium", shoot, target.url, "cdp", [warning], target.targetId);
  }

  const { outcome, behindWindow, hiddenTab } = await captureCdpPage(resolved.port, target.targetId, args, timeoutMs, session);
  const behindNote = behindWindow.tried && behindWindow.shown && outcome.ok ? BEHIND_WINDOW_CAPTURED : null;

  return captured(args, browser, context, outcome, target.url, "cdp", [warning, behindNote, hiddenTabSentence(hiddenTab)], target.targetId, behindWindow, hiddenTab);
}

async function onGecko(args: Args, browser: string, context: string, timeoutMs: number): Promise<string> {
  const resolved = await resolveRdpPort(args.projectPath, browser, { waitMs: Math.min(timeoutMs, 5_000), graceMs: 1_000 });
  if (!resolved) return refuse("no-session", "E_NO_SESSION", `No live ${browser} session with a debugger server (RDP) for this project, so there is no browser to ask for pixels. Start extension_dev and extension_wait for ready.`, RDP_PORT_MISSING_HINT);

  let tabs: RdpTab[];

  try {
    tabs = await rdpListTabs(resolved.port, { timeoutMs });
  } catch (error) {
    return refuse("rdp-failed", "E_RDP", `Could not list tabs over RDP: ${error instanceof Error ? error.message : String(error)}`, "Confirm the session is ready (extension_wait), then retry.");
  }

  let tab: RdpTab | string;
  let pickWarning: string | null = null;

  const choose = (matches: RdpTab[], wanted: string, prefer?: (t: RdpTab) => boolean): RdpTab | string => {
    const chosen = chooseTarget(matches, wanted, geckoTabRef, "gecko", { rank: geckoRecency, prefer });
    if (typeof chosen === "string") return chosen;

    pickWarning = chosen.warning;

    return chosen.target;
  };

  if (args.targetId) {
    tab = findGeckoTab(tabs, args.targetId) ?? targetNotFound(COMMAND, args.targetId, tabs.map(geckoTabRef));
  } else if (context !== "page") {
    const doc = surfaceDocumentOrRefusal(args, browser, context);
    if ("refusal" in doc) return doc.refusal;

    const panel = context === "sidebar" ? await captureGeckoSidebarPanel(args.projectPath, browser, resolved.port, args, timeoutMs) : null;
    if (panel && "outcome" in panel) return captured(args, browser, context, panel.outcome, panel.url, "rdp", [panel.note]);

    tab =
      geckoDocumentTab(tabs, doc.document) ??
      refuse(
        "no-target",
        "E_NO_TARGET",
        `No ${browser} tab shows ${doc.document}${panel ? `, and ${panel.closed}` : ""}. The debugger protocol captures pages shown in tabs${panel ? " and the open sidebar panel" : ""}; a popup in its own window is not a tab.`,
        context === "sidebar" ? 'Open the real panel with extension_open surface: "sidebar", then retry.' : `Open the page in a tab with extension_open (url: "${doc.document}"), then retry.`,
      );
  } else if (args.url && /^moz-extension:\/\//.test(args.url)) {
    tab = choose(geckoExtensionTabsByUrl(tabs, args.url), args.url);
  } else {
    const wanted = args.url?.toLowerCase();
    const matches = wanted ? tabs.filter((t) => String(t.url ?? "").toLowerCase().includes(wanted)) : tabs;
    tab = choose(matches, args.url ?? "any open tab", (t) => t.selected === true);
  }

  if (typeof tab === "string") return tab;

  const contextId = (tab as RdpTab & { browsingContextID?: unknown }).browsingContextID;
  if (typeof contextId !== "number") return refuse("capture-failed", "E_CAPTURE_FAILED", `Firefox listed ${String(tab.url ?? "the tab")} without a browsing context id, so its screenshot actor has nothing to capture.`);

  const cropNote = "Firefox's debugger protocol has no viewport override, so width and height crop the page as it is laid out, from the top left.";

  if (storeChoiceOf(args)) {
    const shoot: Shooter = (size) => captureRdpTab(resolved.port, contextId, size, timeoutMs);

    return capturedForStores(args, browser, context, "gecko", shoot, String(tab.url ?? ""), "rdp", [pickWarning, cropNote], geckoTabRef(tab).targetId);
  }

  const outcome = await captureRdpTab(resolved.port, contextId, args, timeoutMs);
  const warnings = [pickWarning, args.width || args.height ? cropNote : null];

  return captured(args, browser, context, outcome, String(tab.url ?? ""), "rdp", warnings, geckoTabRef(tab).targetId);
}

async function onWebKit(args: Args, browser: string, context: string, timeoutMs: number): Promise<string> {
  if (args.targetId) {
    return refuse("bad-request", "E_BAD_REQUEST", "Safari's WebDriver session drives one automation window and lists no targets, so targetId cannot pick a page there.", "Pass url instead, or capture on a Chromium or Firefox session.");
  }

  if (context !== "page" || isExtensionUrl(args.url)) {
    return refuse(
      "surface-not-capturable",
      "E_SURFACE_NOT_CAPTURABLE",
      `Safari's WebDriver reaches only web pages in its automation window, so it cannot capture the ${context === "page" ? "extension page" : context} (an extension page, the popup and the sidebar sit outside that window).`,
      "Capture the same surface on a Chromium or Firefox session, or capture a web page here with context: \"page\".",
    );
  }

  const info = readWebDriverSession(args.projectPath, browser);
  if (!info) return refuse("no-session", "E_NO_SESSION", `No WebDriver session for ${browser} on this project, so there is no window to capture.`, webdriverSessionMissingHint(readWebDriverUnavailableReason(args.projectPath, browser)));

  const client = new WebDriverClient(info);
  const warnings = [
    args.deviceScaleFactor !== undefined && !storeChoiceOf(args) ? "deviceScaleFactor is not applied on Safari: WebDriver answers the window at the display's own pixel ratio." : null,
    (args.width === undefined) !== (args.height === undefined) ? "Safari's window is resized only when both width and height are given; neither was applied." : null,
  ];

  const shoot: Shooter = async (size) => {
    if (size.width && size.height) await client.fitViewport(size.width, size.height, timeoutMs);

    const png = await client.screenshot(timeoutMs);

    return png ? { ok: true, png } : { ok: false, message: "safaridriver answered no image data" };
  };

  try {
    let current = await client.currentUrl();

    if (args.url && !pageMatchesUrl(current, args.url)) {
      const destination = navigableUrl(args.url);
      if (!destination) return refuse("no-matching-target", "E_NO_MATCHING_TARGET", `The Safari automation window shows ${current ?? "an unreadable url"}, which ${args.url} does not match, and ${args.url} is not an address the window can be sent to.`, "Pass a full url, or open the page first with extension_open url and retry.");

      await client.navigate(destination);
      current = await client.currentUrl();
    }

    if (storeChoiceOf(args)) return capturedForStores(args, browser, "page", "webkit", shoot, current ?? "", "webdriver", warnings);

    return captured(args, browser, "page", await shoot(args), current ?? "", "webdriver", warnings);
  } catch (error) {
    if (webdriverSessionEnded(error)) return refuse("webdriver-session-ended", "E_WEBDRIVER_SESSION_ENDED", webdriverSessionEndedMessage(info, browser), webdriverSessionEndedHint(browser));

    return captured(args, browser, "page", { ok: false, message: error instanceof Error ? error.message : String(error) }, args.url ?? "the automation window", "webdriver");
  }
}

export async function handler(args: Args): Promise<string> {
  const ambiguous = ambiguousSessionRefusal(COMMAND, args.projectPath, args.browser);
  if (ambiguous) return ambiguous;

  const invalid = badSize(args);
  if (invalid) return refuse("bad-request", "E_BAD_REQUEST", invalid);

  const choice = args.store ?? args.forStore;

  if (choice !== undefined) {
    if (!isStoreChoice(choice)) return refuse("bad-request", "E_BAD_REQUEST", `store must be one of ${STORE_CHOICES.join(", ")}; got "${String(choice)}".`);

    if (args.width !== undefined || args.height !== undefined || args.deviceScaleFactor !== undefined) {
      return refuse("bad-request", "E_BAD_REQUEST", `store sets the size itself (${PRESET_SENTENCE}); omit width, height and deviceScaleFactor with store.`);
    }

    if (choice === "all" && args.path) return refuse("bad-request", "E_BAD_REQUEST", 'path names one file, and store:"all" writes one per store under store/screenshots/<store>/; omit path with all.');

    args = { ...args, store: choice };
  }

  const context = args.context ?? "page";
  if (context !== "page" && !SURFACES.includes(context)) return refuse("bad-request", "E_BAD_REQUEST", `context must be page or one of ${SURFACES.join(", ")}.`);

  const { browser } = resolveSessionBrowser(args.projectPath, args.browser);

  if (args.path) {
    const target = resolveScreenshotPath(args.projectPath, browser, context, args.path);
    if (!target.ok) return refuse("bad-request", "E_BAD_REQUEST", target.message, target.hint);
  }

  const timeoutMs = args.timeout ?? DEFAULT_TIMEOUT_MS;

  if (WEBKIT_FAMILY.has(browser)) return onWebKit(args, browser, context, timeoutMs);
  if (isGeckoFamily(browser)) return onGecko(args, browser, context, timeoutMs);
  if (isChromiumFamily(browser)) return onChromium(args, browser, context, timeoutMs);

  return refuse("unsupported-browser", "E_UNSUPPORTED_BROWSER", `${browser} is neither a Chromium, a Gecko nor a WebKit browser, so this tool has no protocol to ask it for pixels.`);
}
