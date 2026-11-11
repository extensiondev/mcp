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
import { CDP_PORT_MISSING_HINT, rdpPortMissingHint, resolveCdpPort, resolveRdpPort } from "../lib/cdp-port";
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
  askedPixels,
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
  browserPageStoreRefusal,
  capturePlan,
  expectedPixels,
  isBrowserPageUrl,
  isStoreChoice,
  nextStoreScreenshotPath,
  PRESET_SENTENCE,
  STORE_CHOICES,
  storeScreenshotsFolder,
  type CaptureFamily,
  type StoreChoice,
} from "../lib/store-capture";
import {
  CAPTURE_BROWSERS,
  browserDisplayName,
  capturesFolder,
  isCaptureBrowser,
  majorVersion,
  nextCapturePath,
  recordCapture,
  surfaceOfContext,
  syncCapturesDoor,
  type CaptureBrowser,
  type CapturedIn,
} from "../lib/browser-captures";
import { capturedInChromium, capturedInGecko, capturedInWebKit } from "../lib/captured-in";
import { resolveExtensionId, surfaceDocument, SURFACE_MANIFEST_KEYS } from "./open";

import type { ListingStore } from "../lib/store-md-declarations";

const COMMAND = "extension_screenshot";
const SURFACES = ["popup", "options", "sidebar", "newtab", "history", "bookmarks"];
const DEFAULT_TIMEOUT_MS = 15_000;

export const schema = {
  name: COMMAND,
  description:
    "Take a .png of one open surface, page or targetId in a live session (Safari: pages only); open it with extension_open first.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: SESSION_PROJECT_PATH,
      browser: SESSION_BROWSER,
      context: {
        type: "string",
        enum: ["page", ...SURFACES],
        default: "page",
        description: "page: the tab url picks; else that open surface.",
      },
      url: { type: "string", description: "page: tab url substring." },
      targetId: TARGET_ID_PROPERTY,
      width: { type: "number", description: "Viewport width (CSS px)." },
      height: { type: "number", description: "Viewport height (CSS px)." },
      deviceScaleFactor: { type: "number", description: "Pixel ratio, 0.5 to 4." },
      store: {
        type: "string",
        enum: [...STORE_CHOICES],
        description:
          "Store listing size, for extension_submit sync-listing.",
      },
      browserCapture: {
        type: "boolean",
        description:
          "Capture for extension_publish sync-captures.",
      },
      path: {
        type: "string",
        description:
          "A .png or folder/ under projectPath or an MCP root.",
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
  browserCapture?: boolean;
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
  capturedIn: CapturedIn | null = null,
  asked: CaptureSize | null = null,
): string {
  if (!outcome.ok) return captureFailure(outcome, url, behindWindow);

  const png = outcome.png;
  const size = pngDimensions(png);
  if (!size) return refuse("capture-failed", "E_CAPTURE_FAILED", `The browser answered data for ${url} that is not a .png image.`);

  const expected = asked ? askedPixels(asked) : null;
  const sizeNote =
    expected && asked && (expected.width !== size.width || expected.height !== size.height)
      ? `The browser answered a ${size.width} x ${size.height} image where ${expected.width} x ${expected.height} was expected (a ${asked.width} x ${asked.height} CSS viewport at deviceScaleFactor ${asked.deviceScaleFactor}); width and height name the image as answered.`
      : null;

  if (args.browserCapture && isCaptureBrowser(browser)) return capturedForBrowser(args, browser, context, png, url, transport, warnings, capturedIn, targetId);

  const written = writeScreenshot(args.projectPath, browser, context, png, args.path);
  if (!written.ok) return refuse("bad-request", "E_BAD_REQUEST", written.message, written.hint);

  const file = written.file;

  return envelope({
    ok: true,
    command: COMMAND,
    status: "captured",
    value: { browser, context, url, ...(targetId ? { targetId } : {}), ...(behindWindow?.tried ? { behindWindow } : {}), ...(hiddenTab ? { hiddenTab } : {}), path: file, width: size.width, height: size.height, bytes: png.length, transport },
    warnings: [...warnings, sizeNote],
    hint: `The image is ${file} (${size.width} x ${size.height} pixels). Open it with your image reader to look at it.`,
  });
}

/* @invariant A BROWSER CAPTURE IS FILED FLAT, NUMBERED PER SURFACE, AND
 * NAMES THE BROWSER THAT MADE IT. The file lands in captures/<browser>/ as
 * <context>-NN.png with its alpha flattened, so the folder is already what
 * sync-captures accepts, and captures.json beside it records the live
 * browser's name and version and the file's surface, which is what the build
 * page says under the image; the hint names the file, the browser and the
 * surface, and the one call that sends the folder. */
function capturedForBrowser(
  args: Args,
  browser: CaptureBrowser,
  context: string,
  png: Buffer,
  url: string,
  transport: string,
  warnings: Array<string | null>,
  capturedIn: CapturedIn | null,
  targetId?: string,
): string {
  const flat = flattenPngAlpha(png);
  if ("problem" in flat) return refuse("capture-failed", "E_CAPTURE_FAILED", `The browser answered ${flat.problem} for ${url}, which this tool cannot flatten for a browser capture.`);

  const file = nextCapturePath(args.projectPath, browser, context);
  const surface = surfaceOfContext(context);

  writeStoreFile(file, flat.png);

  const index = recordCapture(args.projectPath, browser, { file: path.basename(file), surface, width: flat.width, height: flat.height, capturedAt: new Date().toISOString() }, capturedIn);
  const made = majorVersion(capturedIn) || majorVersion(index.capturedIn);
  const notes = [...warnings, capturedIn ? null : `The ${browser} session did not answer its version, so ${capturesFolder(browser)}/captures.json ${index.capturedIn ? "keeps the browser it recorded before" : "records no capturedIn"}; the build page then says the browser without a version.`];

  return envelope({
    ok: true,
    command: COMMAND,
    status: "captured",
    value: {
      browser,
      context,
      url,
      ...(targetId ? { targetId } : {}),
      browserCapture: true,
      surface,
      path: file,
      width: flat.width,
      height: flat.height,
      bytes: flat.png.length,
      ...(index.capturedIn ? { capturedIn: index.capturedIn } : {}),
      folder: capturesFolder(browser),
      transport,
    },
    warnings: notes,
    hint: `${file} (${flat.width} x ${flat.height} pixels) is a ${made || browserDisplayName(browser)} capture of the ${context}. ${syncCapturesDoor(browser)}`,
  });
}

function captureFailure(outcome: CaptureOutcome & { ok: false }, url: string, behindWindow?: BehindWindow): string {
  const behind = behindWindow?.tried
    ? behindWindow.shown
      ? " This tool already showed a blank tab in the page's window and retried, and the page still did not paint."
      : ` This tool could not show another tab in the page's window to get it painted: ${behindWindow.reason}.`
    : "";
  const windowState = behindWindow?.tried && behindWindow.windowState ? ` (the browser reports its window as ${behindWindow.windowState})` : "";
  const whyNoPaint = ` On a headed session the browser paints a shown tab only while its window is on screen: a window that is minimized, behind another app's window or on another macOS Space does not paint, and this tool cannot see which of those holds the page${windowState}.`;

  return refuse(
    outcome.timedOut ? "capture-timeout" : "capture-failed",
    outcome.timedOut ? "E_CAPTURE_TIMEOUT" : "E_CAPTURE_FAILED",
    `The browser did not hand back an image of ${url}: ${outcome.message}`,
    outcome.timedOut
      ? `The page did not paint within the budget.${behind}${whyNoPaint} This tool never brings a window forward; bring the page's tab forward yourself with extension_open {url, foreground: true} (it reloads the tab in place), or move the window onto the screen you are on, and retry; run the session headless (the default); or retry with a larger timeout, which is spent on the capture in full.`
      : "Confirm the session is ready (extension_wait) and the page is still open, then retry.",
  );
}

const storeChoiceOf = (args: Args): StoreChoice | null => (isStoreChoice(args.store) ? args.store : null);

const storeName = (store: ListingStore): string => STORE_SCREENSHOT_SPECS[store].name;
const pixels = (file: StoreFile): string => `${file.path} (${file.width} x ${file.height} pixels)`;

const notClearing = (file: StoreFile): string =>
  `${file.path} does not clear the screenshot row of ${storeName(file.store)}: ${file.reason}. ${storeSizeSentence(file.store).replace(/\.$/, "")}`;

function storeFilesSentence(files: StoreFile[]): string {
  if (files.length === 1) {
    const file = files[0]!;

    return file.clears ? `${pixels(file)} clears the screenshot row of ${storeName(file.store)}.` : `${pixels(file)}: ${notClearing(file)}.`;
  }

  const listed = files.map((file) => `${pixels(file)} for ${storeName(file.store)}`);
  const joined = `${listed.slice(0, -1).join(", ")} and ${listed[listed.length - 1]}`;
  const failing = files.filter((file) => !file.clears);

  if (!failing.length) return `Wrote ${joined}; each clears that store's screenshot row.`;

  const rest = files.length - failing.length;
  const others = rest ? ` The other ${rest === 1 ? "file clears its" : "files clear their"} store's screenshot row.` : "";

  return `Wrote ${joined}. ${failing.map((file) => `${notClearing(file)}.`).join(" ")}${others}`;
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
  const hint = `${storeFilesSentence(files)} ${door}`;

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

function storeTargets<T>(args: Args, matches: T[], url: (t: T) => string): T[] | string {
  if (!storeChoiceOf(args)) return matches;

  const sites = matches.filter((t) => !isBrowserPageUrl(url(t)));
  if (sites.length || !matches.length) return sites;

  const why = browserPageStoreRefusal(matches.map(url));

  return refuse("no-target", "E_NO_TARGET", why.message, why.hint);
}

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

    const kept = storeTargets(args, [found], (t) => t.url);
    chosen = typeof kept === "string" ? kept : { target: found, warning: null };
  } else if (context === "page" && !isExtensionUrl(args.url)) {
    const pages = await listPageTargets(resolved.port).catch(() => [] as PageTarget[]);
    const matches = storeTargets(args, args.url ? matchTargetsByUrl(pages, args.url) : pages.filter((t) => !isExtensionUrl(t.url)), (t) => t.url);
    chosen = typeof matches === "string" ? matches : chooseTarget(matches, args.url ?? "any open tab", pageRef, "chromium");
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

  const capturedIn = args.browserCapture && isCaptureBrowser(browser) ? await capturedInChromium(resolved.port, browser, timeoutMs) : null;
  const { outcome, behindWindow, hiddenTab, size } = await captureCdpPage(resolved.port, target.targetId, args, timeoutMs, session);
  const behindNote = behindWindow.tried && behindWindow.shown && outcome.ok ? BEHIND_WINDOW_CAPTURED : null;

  return captured(args, browser, context, outcome, target.url, "cdp", [warning, behindNote, hiddenTabSentence(hiddenTab)], target.targetId, behindWindow, hiddenTab, capturedIn, size);
}

async function onGecko(args: Args, browser: string, context: string, timeoutMs: number): Promise<string> {
  const resolved = await resolveRdpPort(args.projectPath, browser, { waitMs: Math.min(timeoutMs, 5_000), graceMs: 1_000 });
  if (!resolved?.port) return refuse("no-session", "E_NO_SESSION", `No live ${browser} session with a debugger server (RDP) for this project, so there is no browser to ask for pixels. Start extension_dev and extension_wait for ready.`, rdpPortMissingHint(resolved));

  let tabs: RdpTab[];

  try {
    tabs = await rdpListTabs(resolved.port, { timeoutMs });
  } catch (error) {
    return refuse("rdp-failed", "E_RDP", `Could not list tabs over RDP: ${error instanceof Error ? error.message : String(error)}`, "Confirm the session is ready (extension_wait), then retry.");
  }

  const capturedIn = args.browserCapture && isCaptureBrowser(browser) ? await capturedInGecko(resolved.port, browser, args.projectPath, timeoutMs) : null;

  let tab: RdpTab | string;
  let pickWarning: string | null = null;

  const choose = (matches: RdpTab[], wanted: string, prefer?: (t: RdpTab) => boolean): RdpTab | string => {
    const chosen = chooseTarget(matches, wanted, geckoTabRef, "gecko", { rank: geckoRecency, prefer });
    if (typeof chosen === "string") return chosen;

    pickWarning = chosen.warning;

    return chosen.target;
  };

  const tabUrl = (t: RdpTab): string => String(t.url ?? "");

  if (args.targetId) {
    const found = findGeckoTab(tabs, args.targetId);
    const kept = found ? storeTargets(args, [found], tabUrl) : [];
    tab = typeof kept === "string" ? kept : (found ?? targetNotFound(COMMAND, args.targetId, tabs.map(geckoTabRef)));
  } else if (context !== "page") {
    const doc = surfaceDocumentOrRefusal(args, browser, context);
    if ("refusal" in doc) return doc.refusal;

    const panel = context === "sidebar" ? await captureGeckoSidebarPanel(args.projectPath, browser, resolved.port, args, timeoutMs) : null;
    if (panel && "outcome" in panel) return captured(args, browser, context, panel.outcome, panel.url, "rdp", [panel.note], undefined, undefined, undefined, capturedIn);

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
    const matches = storeTargets(args, wanted ? tabs.filter((t) => tabUrl(t).toLowerCase().includes(wanted)) : tabs, tabUrl);
    tab = typeof matches === "string" ? matches : choose(matches, args.url ?? "any open tab", (t) => t.selected === true);
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

  return captured(args, browser, context, outcome, String(tab.url ?? ""), "rdp", warnings, geckoTabRef(tab).targetId, undefined, undefined, capturedIn);
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

    if (storeChoiceOf(args)) {
      const kept = storeTargets(args, [current ?? ""], (url) => url);
      if (typeof kept === "string") return kept;

      return capturedForStores(args, browser, "page", "webkit", shoot, current ?? "", "webdriver", warnings);
    }

    const capturedIn = args.browserCapture && isCaptureBrowser(browser) ? await capturedInWebKit(client, browser, timeoutMs) : null;

    return captured(args, browser, "page", await shoot(args), current ?? "", "webdriver", warnings, undefined, undefined, undefined, capturedIn);
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

  if (args.browserCapture) {
    if (choice !== undefined) return refuse("bad-request", "E_BAD_REQUEST", "store and browserCapture are two different files: store writes a listing screenshot at the store's size under store/screenshots/<store>/, browserCapture writes a capture of the extension running in this browser under captures/<browser>/; pass one of them.");
    if (args.path) return refuse("bad-request", "E_BAD_REQUEST", "browserCapture names the file itself, captures/<browser>/<context>-NN.png, numbered per context; omit path with it.");
  }

  const context = args.context ?? "page";
  if (context !== "page" && !SURFACES.includes(context)) return refuse("bad-request", "E_BAD_REQUEST", `context must be page or one of ${SURFACES.join(", ")}.`);

  const { browser } = resolveSessionBrowser(args.projectPath, args.browser);

  if (args.browserCapture && !isCaptureBrowser(browser)) {
    return refuse(
      "bad-request",
      "E_BAD_REQUEST",
      `The build pages show captures for ${CAPTURE_BROWSERS.join(", ")}, and this session runs ${browser}, so there is no captures/${browser}/ set to send.`,
      `Start a dev session on one of them (extension_dev browser:"chrome") and capture there, or capture without browserCapture for a file of your own.`,
    );
  }

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
