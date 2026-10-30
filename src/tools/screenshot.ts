// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { CALL_TIMEOUT, SESSION_BROWSER, SESSION_PROJECT_PATH } from "../lib/common-schema";
import { envelope } from "../lib/envelope";
import { noSessionEnvelope } from "../lib/production-receipt";
import { ambiguousSessionRefusal, resolveSessionBrowser } from "../lib/session-browser";
import { isChromiumFamily, isGeckoFamily, WEBKIT_FAMILY } from "../lib/browser-family";
import { CDP_PORT_MISSING_HINT, RDP_PORT_MISSING_HINT, resolveCdpPort, resolveRdpPort } from "../lib/cdp-port";
import { listDocumentTargets, listPageTargets, matchTargetsByUrl, type PageTarget } from "../lib/cdp-targets";
import { readExtensionPageTargets } from "../lib/cdp-extension-page";
import { rdpListTabs, type RdpTab } from "../lib/rdp";
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
import {
  captureRdpTab,
  pngDimensions,
  resolveScreenshotPath,
  writeScreenshot,
  type CaptureOutcome,
  type CaptureSize,
} from "../lib/capture";
import { flattenPngAlpha, pngHeader } from "../lib/png-flat";
import { clearsStoreRow, isListingStoreName, pickStoreSize, STORE_SCREENSHOT_SPECS, sizeLabel, storeSizeSentence } from "../lib/store-screenshot-sizes";
import { LISTING_STORES, type ListingStore } from "../lib/store-md-declarations";
import { resolveExtensionId, surfaceDocument, SURFACE_MANIFEST_KEYS } from "./open";

const COMMAND = "extension_screenshot";
const SURFACES = ["popup", "options", "sidebar", "newtab", "history", "bookmarks"];
const DEFAULT_TIMEOUT_MS = 15_000;

export const schema = {
  name: COMMAND,
  description:
    "Take a screenshot of one open extension surface (popup, options, sidebar, newtab, history, bookmarks) or web page in a live extension_dev or extension_start session as a .png file. It asks the browser for the page's own pixels over the debug port (CDP on Chromium, the screenshot actor on Firefox, WebDriver on Safari, web pages only); it never captures the screen and never brings a window forward: on Chromium a page shown in a window behind others is captured by showing a blank tab there briefly (value.behindWindow). Open the surface with extension_open first. `targetId` (from extension_open or extension_dom_snapshot listTargets) captures that exact page; a url matching several tabs of one page captures the most recently active one and warns. width and height set the Chromium viewport and crop from the top left on Firefox; deviceScaleFactor sets the pixel ratio. `forStore` (chrome, firefox, edge or safari) captures a store listing screenshot at that store's accepted size (1280x800 by default) as a 24-bit PNG with no alpha, and value.forStore says whether it clears the store's screenshot row; pass the path to extension_submit sync-listing screenshots. The file goes under dist/extension-js/<browser>/screenshots unless `path` names one; the answer gives path and pixel size.",
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
      deviceScaleFactor: { type: "number", description: "Pixel ratio of the image, 0.5 to 4. Defaults to the browser's own on Chromium and 1 on Firefox; with forStore it is 1." },
      forStore: {
        type: "string",
        enum: [...LISTING_STORES],
        description:
          "Capture for this store's listing: chrome (1280x800 or 640x400, 24-bit PNG, no alpha), firefox (1280x800 reads best), edge (1280x800 or 640x480) or safari (exactly 1280x800, 1440x900, 2560x1600 or 2880x1800, no alpha). The default 1280x800 24-bit capture clears the screenshot row of all four stores at once.",
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
  forStore?: string;
  timeout?: number;
}

interface StoreVerdict {
  store: ListingStore;
  size: string;
  alpha: "flattened" | "none";
  clears: boolean;
  reason?: string;
  sizes: string[];
  docs: string;
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
): string {
  if (!outcome.ok) {
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

  let png = outcome.png;
  const size = pngDimensions(png);
  if (!size) return refuse("capture-failed", "E_CAPTURE_FAILED", `The browser answered data for ${url} that is not a .png image.`);

  const store = isListingStoreName(args.forStore) ? args.forStore : null;
  let verdict: StoreVerdict | null = null;

  if (store) {
    const flat = flattenPngAlpha(png);
    if ("problem" in flat) return refuse("capture-failed", "E_CAPTURE_FAILED", `The browser answered ${flat.problem} for ${url}, which this tool cannot flatten for a store listing.`);

    png = flat.png;
    const judged = clearsStoreRow(store, size.width, size.height, pngHeader(png)?.alpha !== "none");
    const spec = STORE_SCREENSHOT_SPECS[store];
    verdict = { store, size: sizeLabel([size.width, size.height]), alpha: flat.hadAlpha ? "flattened" : "none", ...judged, sizes: spec.sizes.map(sizeLabel), docs: spec.docs };
  }

  const written = writeScreenshot(args.projectPath, browser, context, png, args.path);
  if (!written.ok) return refuse("bad-request", "E_BAD_REQUEST", written.message, written.hint);

  const file = written.file;
  const storeLine = verdict
    ? verdict.clears
      ? ` It is a ${verdict.size} 24-bit PNG with no alpha, which clears the screenshot row of ${STORE_SCREENSHOT_SPECS[verdict.store].name}; pass it to extension_submit action:"sync-listing" screenshots: ["${file}"] to write it to that store's listing record.`
      : ` It does not clear the screenshot row of ${STORE_SCREENSHOT_SPECS[verdict.store].name}: ${verdict.reason}. ${storeSizeSentence(verdict.store)}`
    : "";

  return envelope({
    ok: true,
    command: COMMAND,
    status: "captured",
    value: { browser, context, url, ...(targetId ? { targetId } : {}), ...(behindWindow?.tried ? { behindWindow } : {}), path: file, width: size.width, height: size.height, bytes: png.length, transport, ...(verdict ? { forStore: verdict } : {}) },
    warnings,
    hint: `The image is ${file} (${size.width} x ${size.height} pixels).${storeLine || " Open it with your image reader to look at it."}`,
  });
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
  const resolved = await resolveCdpPort(args.projectPath, browser, { waitMs: Math.min(timeoutMs, 5_000), graceMs: 1_000 });

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
  const { outcome, behindWindow } = await captureCdpPage(resolved.port, target.targetId, args, timeoutMs, { projectPath: args.projectPath, browser });
  const behindNote = behindWindow.tried && behindWindow.shown && outcome.ok ? BEHIND_WINDOW_CAPTURED : null;

  return captured(args, browser, context, outcome, target.url, "cdp", [warning, behindNote], target.targetId, behindWindow);
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

    tab =
      geckoDocumentTab(tabs, doc.document) ??
      refuse(
        "no-target",
        "E_NO_TARGET",
        `No ${browser} tab shows ${doc.document}. The debugger protocol captures pages shown in tabs; a popup in its own window or a sidebar panel is not a tab.`,
        `Open the page in a tab with extension_open (url: "${doc.document}"), then retry.`,
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

  const outcome = await captureRdpTab(resolved.port, contextId, args, timeoutMs);
  const warnings = [
    pickWarning,
    args.width || args.height ? "Firefox's debugger protocol has no viewport override, so width and height crop the page as it is laid out, from the top left." : null,
  ];

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
  const warnings =
    args.width || args.height || args.deviceScaleFactor ? ["WebDriver captures the window as it is: width, height and deviceScaleFactor are not applied on Safari, and this tool does not resize the window."] : [];

  try {
    let current = await client.currentUrl();

    if (args.url && !pageMatchesUrl(current, args.url)) {
      const destination = navigableUrl(args.url);
      if (!destination) return refuse("no-matching-target", "E_NO_MATCHING_TARGET", `The Safari automation window shows ${current ?? "an unreadable url"}, which ${args.url} does not match, and ${args.url} is not an address the window can be sent to.`, "Pass a full url, or open the page first with extension_open url and retry.");

      await client.navigate(destination);
      current = await client.currentUrl();
    }

    const png = await client.screenshot(timeoutMs);
    const outcome: CaptureOutcome = png ? { ok: true, png } : { ok: false, message: "safaridriver answered no image data" };

    return captured(args, browser, "page", outcome, current ?? "", "webdriver", warnings);
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

  if (args.forStore !== undefined) {
    if (!isListingStoreName(args.forStore)) return refuse("bad-request", "E_BAD_REQUEST", `forStore must be one of ${LISTING_STORES.join(", ")}; got "${String(args.forStore)}".`);
    if (args.deviceScaleFactor !== undefined && args.deviceScaleFactor !== 1) return refuse("bad-request", "E_BAD_REQUEST", "A store screenshot is captured at a 1x pixel ratio so its pixel size is the store's size; omit deviceScaleFactor with forStore.");

    const picked = pickStoreSize(args.forStore, args.width, args.height);
    if (!picked.ok) return refuse("bad-request", "E_BAD_REQUEST", picked.message, storeSizeSentence(args.forStore));

    args = { ...args, width: picked.width, height: picked.height, deviceScaleFactor: 1 };
  }

  const context = args.context ?? "page";
  if (context !== "page" && !SURFACES.includes(context)) return refuse("bad-request", "E_BAD_REQUEST", `context must be page or one of ${SURFACES.join(", ")}.`);

  const { browser } = resolveSessionBrowser(args.projectPath, args.browser);

  const target = resolveScreenshotPath(args.projectPath, browser, context, args.path);
  if (!target.ok) return refuse("bad-request", "E_BAD_REQUEST", target.message, target.hint);

  const timeoutMs = args.timeout ?? DEFAULT_TIMEOUT_MS;

  if (WEBKIT_FAMILY.has(browser)) return onWebKit(args, browser, context, timeoutMs);
  if (isGeckoFamily(browser)) return onGecko(args, browser, context, timeoutMs);
  if (isChromiumFamily(browser)) return onChromium(args, browser, context, timeoutMs);

  return refuse("unsupported-browser", "E_UNSUPPORTED_BROWSER", `${browser} is neither a Chromium, a Gecko nor a WebKit browser, so this tool has no protocol to ask it for pixels.`);
}
