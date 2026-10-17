// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { CALL_TIMEOUT, SESSION_BROWSER, SESSION_PROJECT_PATH } from "../lib/common-schema";
import { envelope } from "../lib/envelope";
import { ambiguousSessionRefusal, resolveSessionBrowser } from "../lib/session-browser";
import { isChromiumFamily, isGeckoFamily, WEBKIT_FAMILY } from "../lib/browser-family";
import { CDP_PORT_MISSING_HINT, RDP_PORT_MISSING_HINT, resolveCdpPort, resolveRdpPort } from "../lib/cdp-port";
import { listPageTargets, matchTargetsByUrl, type PageTarget } from "../lib/cdp-targets";
import { readExtensionPageTargets } from "../lib/cdp-extension-page";
import { rdpListTabs, type RdpTab } from "../lib/rdp";
import { geckoDocumentTab, geckoExtensionTabByUrl, isExtensionUrl } from "../lib/extension-surfaces";
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
import {
  captureCdpTarget,
  captureRdpTab,
  pngDimensions,
  writeScreenshot,
  type CaptureOutcome,
  type CaptureSize,
} from "../lib/capture";
import { resolveExtensionId, surfaceDocument, SURFACE_MANIFEST_KEYS } from "./open";

const COMMAND = "extension_screenshot";
const SURFACES = ["popup", "options", "sidebar", "newtab", "history", "bookmarks"];
const DEFAULT_TIMEOUT_MS = 15_000;

export const schema = {
  name: COMMAND,
  description:
    "Take a screenshot of one open extension surface (popup, options, sidebar, newtab, history, bookmarks) or web page in a live extension_dev or extension_start session and save it as a .png file. It asks the browser for that page's own pixels over the session's debug port: CDP Page.captureScreenshot on Chromium, the debugger protocol's screenshot actor on Firefox, and WebDriver on Safari, where only web pages can be captured. It never captures the screen or another window and never brings a window to the front, so there is no need for screencapture, AppleScript or a Playwright script. The surface must already be open: open it with extension_open first. width and height set the viewport on Chromium and crop from the top left on Firefox; deviceScaleFactor sets the pixel ratio. The file goes under dist/extension-js/<browser>/screenshots unless `path` names one, and the answer gives its path and pixel size. Use extension_dom_snapshot for the page's structure as text.",
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
      width: { type: "number", description: "Viewport width in CSS pixels (Chromium renders at it; Firefox crops to it)." },
      height: { type: "number", description: "Viewport height in CSS pixels (Chromium renders at it; Firefox crops to it)." },
      deviceScaleFactor: { type: "number", description: "Pixel ratio of the image, 0.5 to 4. Defaults to the browser's own on Chromium and 1 on Firefox." },
      path: { type: "string", description: "Where to write the .png, a file or a folder, relative to projectPath. Defaults to dist/extension-js/<browser>/screenshots." },
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
  path?: string;
  timeout?: number;
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

function captured(args: Args, browser: string, context: string, outcome: CaptureOutcome, url: string, transport: string, warnings: string[] = []): string {
  if (!outcome.ok) {
    return refuse(
      outcome.timedOut ? "capture-timeout" : "capture-failed",
      outcome.timedOut ? "E_CAPTURE_TIMEOUT" : "E_CAPTURE_FAILED",
      `The browser did not hand back an image of ${url}: ${outcome.message}`,
      outcome.timedOut
        ? "A page in a visible window that is not in front may not be painted, and this tool never brings it forward. Run the session headless (the default), or retry once the page is showing."
        : "Confirm the session is ready (extension_wait) and the page is still open, then retry.",
    );
  }

  const size = pngDimensions(outcome.png);
  if (!size) return refuse("capture-failed", "E_CAPTURE_FAILED", `The browser answered data for ${url} that is not a .png image.`);

  const file = writeScreenshot(args.projectPath, browser, context, outcome.png, args.path);

  return envelope({
    ok: true,
    command: COMMAND,
    status: "captured",
    value: { browser, context, url, path: file, width: size.width, height: size.height, bytes: outcome.png.length, transport },
    warnings,
    hint: `The image is ${file} (${size.width} x ${size.height} pixels). Open it with your image reader to look at it.`,
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

function pickOne<T extends { url?: string }>(matches: T[], wanted: string, selected?: (t: T) => boolean): T | string {
  if (matches.length === 1) return matches[0];

  const chosen = selected ? matches.filter(selected) : [];
  if (chosen.length === 1) return chosen[0];

  if (matches.length === 0) {
    return refuse("no-target", "E_NO_TARGET", `No open page matches ${wanted}, so there is nothing to capture.`, "Open it first with extension_open (url: this address), then retry. extension_dom_snapshot with listTargets: true lists what is open.");
  }

  return refuse(
    "ambiguous-target",
    "E_AMBIGUOUS_TARGET",
    `${matches.length} open pages match ${wanted}; refusing to guess which one to capture.`,
    "Pass a `url` that matches exactly one of matchingTargets.",
    { matchingTargets: matches.map((m) => ({ url: String(m.url ?? "") })) },
  );
}

async function onChromium(args: Args, browser: string, context: string, timeoutMs: number): Promise<string> {
  const resolved = await resolveCdpPort(args.projectPath, browser, { waitMs: Math.min(timeoutMs, 5_000), graceMs: 1_000 });
  if (!resolved) return refuse("no-session", "E_NO_SESSION", `No live ${browser} session with a debug port for this project, so there is no browser to ask for pixels. Start extension_dev and extension_wait for ready.`, CDP_PORT_MISSING_HINT);

  let target: PageTarget | string;

  if (context === "page" && !isExtensionUrl(args.url)) {
    const pages = await listPageTargets(resolved.port).catch(() => [] as PageTarget[]);
    target = pickOne(args.url ? matchTargetsByUrl(pages, args.url) : pages.filter((t) => !isExtensionUrl(t.url)), args.url ?? "any open tab");
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

    target = read.targets[0];
  }

  if (typeof target === "string") return target;

  const outcome = await captureCdpTarget(resolved.port, target.targetId, args, timeoutMs);

  return captured(args, browser, context, outcome, target.url, "cdp");
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

  if (context !== "page") {
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
    tab = geckoExtensionTabByUrl(tabs, args.url) ?? pickOne([], args.url);
  } else {
    const wanted = args.url?.toLowerCase();
    const matches = wanted ? tabs.filter((t) => String(t.url ?? "").toLowerCase().includes(wanted)) : tabs;
    tab = pickOne(matches, args.url ?? "any open tab", (t) => t.selected === true);
  }

  if (typeof tab === "string") return tab;

  const contextId = (tab as RdpTab & { browsingContextID?: unknown }).browsingContextID;
  if (typeof contextId !== "number") return refuse("capture-failed", "E_CAPTURE_FAILED", `Firefox listed ${String(tab.url ?? "the tab")} without a browsing context id, so its screenshot actor has nothing to capture.`);

  const outcome = await captureRdpTab(resolved.port, contextId, args, timeoutMs);
  const warnings =
    args.width || args.height ? ["Firefox's debugger protocol has no viewport override, so width and height crop the page as it is laid out, from the top left."] : [];

  return captured(args, browser, context, outcome, String(tab.url ?? ""), "rdp", warnings);
}

async function onWebKit(args: Args, browser: string, context: string, timeoutMs: number): Promise<string> {
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

  const context = args.context ?? "page";
  if (context !== "page" && !SURFACES.includes(context)) return refuse("bad-request", "E_BAD_REQUEST", `context must be page or one of ${SURFACES.join(", ")}.`);

  const { browser } = resolveSessionBrowser(args.projectPath, args.browser);
  const timeoutMs = args.timeout ?? DEFAULT_TIMEOUT_MS;

  if (WEBKIT_FAMILY.has(browser)) return onWebKit(args, browser, context, timeoutMs);
  if (isGeckoFamily(browser)) return onGecko(args, browser, context, timeoutMs);
  if (isChromiumFamily(browser)) return onChromium(args, browser, context, timeoutMs);

  return refuse("unsupported-browser", "E_UNSUPPORTED_BROWSER", `${browser} is neither a Chromium, a Gecko nor a WebKit browser, so this tool has no protocol to ask it for pixels.`);
}
