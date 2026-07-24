// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { promises as fs } from "node:fs";
import path from "node:path";

import {
  CHROME_THEME_IMAGE_KEYS,
  CHROME_THEME_PROPERTY_KEYS,
  CHROME_THEME_TINT_KEYS,
} from "../lib/vendor/chrome-theme/chrome-theme-reference";
import {
  resolveChromeTheme,
  type ChromeThemeManifestTheme,
} from "../lib/vendor/chrome-theme/chrome-theme-resolve";

export const schema = {
  name: "extension_theme_verify",
  description:
    "Verify a Chrome theme manifest before it ships. Settles the four-leg WYSIWYG contract (app-shows == manifest-says == chrome-paints, plus chrome-accepts) as far as is possible headless: it derives every color current Chrome would paint from the manifest (the transcribed Chromium resolver) and reports the divergence class of any problem - D1 fabrication, D3 parity gap, D4 acceptance gap (keys Chrome silently discards: dead legacy keys, incognito keys, unknown keys, out-of-range values). Verification is the product; this verb does not author or mutate a theme. The app-rendered leg [1] and the real-pixel paint leg [3] need a browser and are returned as needsAttended with a pointer to the assert:theme and install-parity harnesses, never reported as passed.",
  inputSchema: {
    type: "object" as const,
    properties: {
      manifest: {
        type: "object",
        description:
          "The Chrome theme manifest object (with a `theme` block). Pass this or manifestPath.",
      },
      manifestPath: {
        type: "string",
        description:
          "Path to a theme manifest.json (or a { manifest } seed wrapper). Read in place of the inline manifest.",
      },
    },
    required: [],
  },
};

type Severity = "error" | "warn" | "info";
type DivergenceClass = "D1" | "D3" | "D4";

interface Finding {
  class: DivergenceClass;
  severity: Severity;
  leg: string;
  key?: string;
  detail: string;
}

const DERIVABLE_COLOR_KEYS = new Set([
  "frame_inactive",
  "toolbar_text",
  "toolbar_button_icon",
  "bookmark_text",
  "tab_text",
  "tab_background_text",
  "tab_background_text_inactive",
  "background_tab",
  "background_tab_inactive",
  "ntp_text",
  "ntp_link",
  "ntp_header",
  "omnibox_text",
  "omnibox_background",
]);

const FABRICATION_SENTINEL = [0, 0, 0];

function isValidChromeVersion(version: string): boolean {
  const parts = version.split(".");
  if (parts.length < 1 || parts.length > 4) return false;
  return parts.every(
    (part) => /^(0|[1-9]\d{0,4})$/.test(part) && Number(part) <= 65535,
  );
}

function isFabricationBlack(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length >= 3 &&
    FABRICATION_SENTINEL.every((c, i) => value[i] === c) &&
    (value.length === 3 || value[3] === 1 || value[3] === 255)
  );
}

function coerceInput(raw: unknown): {
  manifest: Record<string, unknown>;
  theme: ChromeThemeManifestTheme;
} {
  if (!raw || typeof raw !== "object") {
    throw new Error(
      "Theme manifest must be a JSON object with a `theme` block.",
    );
  }
  const obj = raw as Record<string, unknown>;
  const manifest =
    obj.manifest && typeof obj.manifest === "object"
      ? (obj.manifest as Record<string, unknown>)
      : obj;
  const themeBlock =
    manifest.theme && typeof manifest.theme === "object"
      ? (manifest.theme as ChromeThemeManifestTheme)
      :
        manifest.colors || manifest.tints || manifest.images
        ? (manifest as unknown as ChromeThemeManifestTheme)
        : ({} as ChromeThemeManifestTheme);
  return { manifest, theme: themeBlock };
}

export async function handler(args: {
  manifest?: Record<string, unknown>;
  manifestPath?: string;
}): Promise<string> {
  let raw: unknown;
  if (args.manifestPath) {
    const abs = path.resolve(args.manifestPath);
    let text: string;
    try {
      text = await fs.readFile(abs, "utf8");
    } catch {
      return JSON.stringify({
        ok: false,
        error: { name: "InputError", message: `Cannot read ${abs}` },
      });
    }
    try {
      raw = JSON.parse(text);
    } catch (err) {
      return JSON.stringify({
        ok: false,
        error: {
          name: "InputError",
          message: `${abs} is not valid JSON: ${
            err instanceof Error ? err.message : String(err)
          }`,
        },
      });
    }
  } else if (args.manifest) {
    raw = args.manifest;
  } else {
    return JSON.stringify({
      ok: false,
      error: {
        name: "InputError",
        message: "Pass `manifest` (an object) or `manifestPath` (a file path).",
      },
    });
  }

  let manifest: Record<string, unknown>;
  let theme: ChromeThemeManifestTheme;
  try {
    ({ manifest, theme } = coerceInput(raw));
  } catch (err) {
    return JSON.stringify({
      ok: false,
      error: {
        name: "InputError",
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }

  const findings: Finding[] = [];

  const name = typeof manifest.name === "string" ? manifest.name : "";
  const version =
    typeof manifest.version === "string" ? manifest.version : "";
  const nameValid = name.trim().length > 0;
  const versionValid = version.length > 0 && isValidChromeVersion(version);
  const grammarErrors: string[] = [];
  if (!nameValid) grammarErrors.push("name must be a non-empty string");
  if (!versionValid) {
    grammarErrors.push(
      `version "${version}" is not a Chrome version (1-4 integers 0-65535, e.g. "1.0")`,
    );
  }

  const declaredColors = (theme.colors ?? {}) as Record<string, unknown>;
  const declaredTints = (theme.tints ?? {}) as Record<string, unknown>;
  const declaredImages = (theme.images ?? {}) as Record<string, unknown>;
  const declaredProps = (theme.properties ?? {}) as Record<string, unknown>;

  const resolved = resolveChromeTheme(theme);

  for (const { key, reason } of resolved.ignoredKeys) {
    findings.push({
      class: "D4",
      severity: "warn",
      leg: "chrome-accepts",
      key: `colors.${key}`,
      detail: `Chrome discards colors.${key}: ${reason}`,
    });
  }
  const imageKeys = new Set<string>(CHROME_THEME_IMAGE_KEYS);
  for (const key of Object.keys(declaredImages)) {
    if (!imageKeys.has(key)) {
      findings.push({
        class: "D4",
        severity: "warn",
        leg: "chrome-accepts",
        key: `images.${key}`,
        detail: `Chrome does not recognize images.${key} (not in kPersistingImages); it is dropped at parse.`,
      });
    } else if (key.includes("incognito")) {
      findings.push({
        class: "D4",
        severity: "warn",
        leg: "chrome-accepts",
        key: `images.${key}`,
        detail: `images.${key} parses but incognito windows never render extension themes (theme_service.cc:741).`,
      });
    }
  }
  const tintKeys = new Set<string>(CHROME_THEME_TINT_KEYS);
  for (const key of Object.keys(declaredTints)) {
    if (!tintKeys.has(key)) {
      findings.push({
        class: "D4",
        severity: "warn",
        leg: "chrome-accepts",
        key: `tints.${key}`,
        detail: `Chrome does not recognize tints.${key} (not in kTintTable); it is ignored.`,
      });
    } else if (key.includes("incognito")) {
      findings.push({
        class: "D4",
        severity: "warn",
        leg: "chrome-accepts",
        key: `tints.${key}`,
        detail: `tints.${key} parses but incognito windows never render extension themes (theme_service.cc:741).`,
      });
    }
  }
  const propKeys = new Set<string>(CHROME_THEME_PROPERTY_KEYS);
  for (const key of Object.keys(declaredProps)) {
    if (!propKeys.has(key)) {
      findings.push({
        class: "D4",
        severity: "warn",
        leg: "chrome-accepts",
        key: `properties.${key}`,
        detail: `Chrome does not recognize properties.${key} (not in kDisplayProperties); it is ignored.`,
      });
    }
  }

  for (const [key, value] of Object.entries(declaredColors)) {
    if (DERIVABLE_COLOR_KEYS.has(key) && isFabricationBlack(value)) {
      findings.push({
        class: "D1",
        severity: "info",
        leg: "manifest-says",
        key: `colors.${key}`,
        detail: `colors.${key} is opaque black [0,0,0]; Chrome would otherwise DERIVE this key. Confirm it was authored, not fabricated for an unset field (run the app-shows leg to settle it).`,
      });
    }
  }

  for (const caveat of resolved.caveats) {
    findings.push({
      class: "D3",
      severity: "info",
      leg: "chrome-paints",
      detail: `Real Chrome may paint differently: ${caveat}`,
    });
  }

  const hasError = grammarErrors.length > 0;
  const hasWarn = findings.some((f) => f.severity === "warn");
  const verdict: "invalid" | "diverged" | "headless-clean" = hasError
    ? "invalid"
    : hasWarn
      ? "diverged"
      : "headless-clean";

  const attended = [
    {
      leg: "app-shows",
      proves: "the themes.extension.dev app renders exactly resolve(manifest)",
      how: "assert:theme --theme <path> (themes.extension.dev dev harness; drives the theme through the ?__seed=1 door, headless, no focus steal)",
    },
    {
      leg: "chrome-paints (real pixels)",
      proves: "real Chrome paints exactly what the resolver derived",
      how: "install-parity (build-scripts/install-parity.mjs; installs the theme in real Chrome and diffs the capture, mac-local and headed)",
    },
    {
      leg: "chrome-accepts (live)",
      proves: "real Chrome loads the theme with no errors or warnings",
      how: "a Chrome theme is an unpacked extension: extension_dev then extension_logs on the exported theme dir (headless, focus-safe)",
    },
  ];

  return JSON.stringify({
    ok: true,
    tool: "extension_theme_verify",
    verdict,
    needsAttended: true,
    summary: {
      errors: grammarErrors.length,
      warnings: findings.filter((f) => f.severity === "warn").length,
      advisories: findings.filter((f) => f.severity === "info").length,
      byClass: {
        D1: findings.filter((f) => f.class === "D1").length,
        D3: findings.filter((f) => f.class === "D3").length,
        D4: findings.filter((f) => f.class === "D4").length,
      },
    },
    legs: {
      appShows: {
        status: "needs-attended",
        detail:
          "Not run here (needs a browser). The app self-verifies app == resolve(manifest) via the seed door.",
        how: attended[0].how,
      },
      manifestSays: {
        status: hasError ? "invalid" : "verified",
        name,
        version,
        grammar: { nameValid, versionValid, errors: grammarErrors },
        declared: {
          colors: Object.keys(declaredColors),
          tints: Object.keys(declaredTints),
          images: Object.keys(declaredImages),
          properties: Object.keys(declaredProps),
        },
      },
      chromePaints: {
        resolver: {
          status: "reported",
          detail:
            "Headless proxy: every color current stable Chrome derives from this manifest.",
          resolved,
        },
        realPaint: { status: "needs-attended", how: attended[1].how },
      },
      chromeAccepts: {
        status: "reported",
        detail:
          "Static analysis of what Chrome parses but discards (the D4 acceptance gap).",
        discarded: findings
          .filter((f) => f.leg === "chrome-accepts")
          .map((f) => ({ key: f.key, detail: f.detail })),
        live: { status: "needs-attended", how: attended[2].how },
      },
    },
    findings,
    attended,
  });
}
