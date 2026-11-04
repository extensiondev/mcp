// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

type Row = Record<string, unknown>;

const EVERY_SITE_PATTERNS = new Set(["<all_urls>", "*://*/*", "http://*/*", "https://*/*", "*://*/"]);

const PLAIN_WORDS: Record<string, string> = {
  tabs: "see the address and title of every tab you open",
  history: "read and change your browsing history",
  bookmarks: "read and change your bookmarks",
  downloads: "start, read and manage your downloads",
  cookies: "read and change cookies on the sites it can reach",
  clipboardRead: "read what you copy",
  clipboardWrite: "change what you paste",
  geolocation: "ask for your location",
  notifications: "show desktop notifications",
  management: "see and manage your other extensions",
  nativeMessaging: "talk to a program installed on your computer",
  privacy: "change your browser's privacy settings",
  proxy: "route your traffic through a proxy",
  topSites: "read your most visited sites",
  webNavigation: "see every page you navigate to",
  webRequest: "watch the network requests of the sites it can reach",
  webRequestBlocking: "block or change network requests",
  declarativeNetRequest: "block or redirect requests on any page",
  declarativeNetRequestWithHostAccess: "block or redirect requests on the sites it can reach",
  debugger: "attach the debugger to your tabs and read everything on them",
  desktopCapture: "capture your screen",
  tabCapture: "record what a tab shows",
  pageCapture: "save whole pages",
  contentSettings: "change which sites may use cookies, JavaScript, the camera or the microphone",
  identity: "sign you in with your browser account",
  scripting: "run its scripts in pages it can reach",
  sessions: "read recently closed tabs and windows",
  browsingData: "clear your browsing data",
  storage: "keep its own data on this machine",
  unlimitedStorage: "keep its own data on this machine with no size limit",
  contextMenus: "add items to the right-click menu",
  activeTab: "reach the page you are on when you click it",
  alarms: "wake itself on a timer",
  offscreen: "run a hidden page of its own",
  sidePanel: "show a side panel",
};

export interface TryPermissionFacts {
  name: string;
  manifestVersion: number | null;
  everySite: boolean;
  sites: string[];
  contentScriptSites: string[];
  permissions: string[];
  optionalPermissions: string[];
  plainWords: string[];
  surfaces: { popup: string | null; action: boolean; options: string | null; sidebar: string | null };
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "").map((entry) => entry.trim()) : [];
}

function isRow(value: unknown): value is Row {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSitePattern(entry: string): boolean {
  return entry === "<all_urls>" || entry.includes("://");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function readTryPermissions(manifest: Row): TryPermissionFacts {
  const manifestVersion = typeof manifest.manifest_version === "number" ? manifest.manifest_version : null;
  const declared = strings(manifest.permissions);
  const hostEntries = unique([...strings(manifest.host_permissions), ...declared.filter(isSitePattern)]);
  const permissions = declared.filter((entry) => !isSitePattern(entry));
  const optionalPermissions = unique([...strings(manifest.optional_permissions), ...strings(manifest.optional_host_permissions)]);
  const contentScripts = Array.isArray(manifest.content_scripts) ? manifest.content_scripts.filter(isRow) : [];
  const contentScriptSites = unique(contentScripts.flatMap((script) => strings(script.matches)));
  const everySite = [...hostEntries, ...contentScriptSites].some((entry) => EVERY_SITE_PATTERNS.has(entry));
  const action = [manifest.action, manifest.browser_action, manifest.page_action].find(isRow) ?? null;
  const sidebar = isRow(manifest.side_panel) ? text(manifest.side_panel.default_path) : isRow(manifest.sidebar_action) ? text(manifest.sidebar_action.default_panel) : null;
  const options = isRow(manifest.options_ui) ? text(manifest.options_ui.page) : text(manifest.options_page);

  const plainWords = [
    everySite
      ? "It can read and change what you see on every website you visit."
      : hostEntries.length || contentScriptSites.length
        ? `It can read and change what you see on ${unique([...hostEntries, ...contentScriptSites]).join(", ")}.`
        : "It asks for no website access up front.",
    ...permissions.filter((name) => PLAIN_WORDS[name]).map((name) => `${name}: it can ${PLAIN_WORDS[name]}.`),
    ...permissions.filter((name) => !PLAIN_WORDS[name]).map((name) => `${name}: a permission this tool has no plain words for; read what it allows before trusting the extension with it.`),
    optionalPermissions.length ? `It can ask later for ${optionalPermissions.join(", ")}, and the browser asks you first.` : null,
  ].filter((line): line is string => typeof line === "string");

  return {
    name: text(manifest.name) ?? "this extension",
    manifestVersion,
    everySite,
    sites: hostEntries,
    contentScriptSites,
    permissions,
    optionalPermissions,
    plainWords,
    surfaces: { popup: action ? text(action.default_popup) : null, action: action !== null, options, sidebar },
  };
}
