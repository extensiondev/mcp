// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

/* @invariant This reading of the match-pattern grammar decides WORDING, never a
   pass. extension_assert's content-script clause cannot pass on a declared
   match, only on evidence that the script actually ran, so the worst a
   disagreement with Chrome here can do is describe a refusal imprecisely. If a
   later verb ever wants to pass on coverage alone, this file is not enough:
   the browser's own answer is, and there is no reader for it today. */

const ALL_URLS = "<all_urls>";

const ALL_URLS_SCHEMES = new Set(["http", "https", "file", "ftp", "urn"]);

const STAR_SCHEMES = new Set(["http", "https"]);

const PATTERN = /^([a-z*][a-z0-9*+.-]*):\/\/([^/]*)(\/.*)$/i;

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\\\*/g, ".*")}$`);
}

function hostMatches(patternHost: string, host: string): boolean {
  if (patternHost === "*") return true;
  const lower = patternHost.toLowerCase();
  if (lower.startsWith("*.")) {
    const suffix = lower.slice(2);
    return host === suffix || host.endsWith(`.${suffix}`);
  }
  return host === lower;
}

export function matchPatternCovers(pattern: string, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();

  if (pattern.trim() === ALL_URLS) return ALL_URLS_SCHEMES.has(scheme);

  const parts = PATTERN.exec(pattern.trim());
  if (!parts) return false;
  const [, patternScheme, patternHost, patternPath] = parts;

  const schemeOk =
    patternScheme === "*"
      ? STAR_SCHEMES.has(scheme)
      : patternScheme.toLowerCase() === scheme;
  if (!schemeOk) return false;

  if (scheme === "file") {
    if (patternHost !== "" && patternHost !== "*") return false;
  } else if (!hostMatches(patternHost, parsed.hostname.toLowerCase())) {
    return false;
  }

  const path = `${parsed.pathname}${parsed.search}`;
  return globToRegExp(patternPath).test(path);
}

export function coveringMatches(patterns: string[], url: string): string[] {
  return patterns.filter((pattern) => matchPatternCovers(pattern, url));
}

/* @invariant Only schemes the browser refuses OUTRIGHT belong here, because a
   hit is reported as a failed expectation rather than an unanswerable one.
   about:blank is deliberately absent: match_about_blank injects there, so
   calling it forbidden would be a wrong red. file:// is absent for the same
   reason, since a profile launched with file access enabled does inject. */
const FORBIDDEN: Array<{ test: RegExp; reason: string }> = [
  {
    test: /^chrome:\/\//i,
    reason:
      "chrome:// pages are browser interface, and Chrome injects no content script into them at any permission level",
  },
  {
    test: /^chrome-untrusted:\/\//i,
    reason:
      "chrome-untrusted:// is reserved for the browser's own sandboxed interface and takes no extension content script",
  },
  {
    test: /^devtools:\/\//i,
    reason:
      "devtools:// pages take no content script; a devtools page is declared with devtools_page instead",
  },
  {
    test: /^(edge|brave|opera|vivaldi|yandex):\/\//i,
    reason:
      "this Chromium vendor's own interface scheme takes no extension content script",
  },
  {
    test: /^view-source:/i,
    reason: "view-source: documents take no content script",
  },
  {
    test: /^(chrome|moz)-extension:\/\//i,
    reason:
      "an extension page is not a host page: content scripts do not inject into extension origins, and a surface's own scripts run there instead",
  },
  {
    test: /^https?:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i,
    reason:
      "Chrome blocks every extension from the Web Store's own pages by policy, whatever the manifest declares",
  },
];

export function contentScriptsForbidden(url: string): string | null {
  const trimmed = String(url ?? "").trim();
  for (const rule of FORBIDDEN) {
    if (rule.test.test(trimmed)) return rule.reason;
  }
  return null;
}
