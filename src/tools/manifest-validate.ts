import fs from "node:fs";
import path from "node:path";
import { filterKeysForThisBrowser } from "browser-extension-manifest-fields";
import { isChromiumFamily, isGeckoFamily } from "../lib/browser-family";
import { listTemplates } from "../lib/templates-cache";

export const schema = {
  name: "extension_manifest_validate",
  description:
    "Validate a manifest.json file for correctness across browsers. Reports missing fields, invalid permissions, and cross-browser compatibility issues.",
  inputSchema: {
    type: "object" as const,
    properties: {
      manifestPath: {
        type: "string",
        description: "Path to manifest.json",
      },
      browsers: {
        type: "array",
        items: { type: "string" },
        default: ["chrome", "firefox"],
        description: "Browsers to validate against",
      },
    },
    required: ["manifestPath"],
  },
};

interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  browserSupport: Record<string, { supported: boolean; issues: string[] }>;
  similarTemplates: Array<{ slug: string; surfaces: string[] }>;
}

export async function handler(args: {
  manifestPath: string;
  browsers?: string[];
}): Promise<string> {
  const browsers = args.browsers ?? ["chrome", "firefox"];
  const result: ValidationResult = {
    valid: true,
    errors: [],
    warnings: [],
    browserSupport: {},
    similarTemplates: [],
  };

  let manifest: Record<string, unknown>;
  try {
    const raw = fs.readFileSync(path.resolve(args.manifestPath), "utf8");
    manifest = JSON.parse(raw);
  } catch (err) {
    return JSON.stringify({
      valid: false,
      errors: [
        `Cannot read manifest: ${err instanceof Error ? err.message : err}`,
      ],
      warnings: [],
      browserSupport: {},
      similarTemplates: [],
    });
  }

  if (!manifest.name) {
    result.errors.push("Missing required field: name");
  }
  if (!manifest.version) {
    result.warnings.push(
      "Missing field: version (required for store submission)",
    );
  }

  const chromiumManifest = filterKeysForThisBrowser(manifest, "chrome");

  if (!chromiumManifest.manifest_version) {
    result.errors.push(
      'Missing manifest_version. Use "chromium:manifest_version": 3 and "firefox:manifest_version": 2 for cross-browser support.',
    );
  }

  for (const browser of browsers) {
    const isChromium = isChromiumFamily(browser);
    const isFirefox = isGeckoFamily(browser);
    const effective = filterKeysForThisBrowser(manifest, browser);
    const issues: string[] = [];

    if (isChromium) {
      const mv = effective.manifest_version as number;

      if (mv && mv < 3) {
        issues.push(
          "Manifest V2 is deprecated on Chromium. Use chromium:manifest_version: 3.",
        );
      }

      if (effective.side_panel) {
        const perms = (effective.permissions ?? []) as string[];

        if (!perms.includes("sidePanel")) {
          issues.push(
            'Side panel declared but "sidePanel" permission is missing.',
          );
        }
      }
      if (manifest["firefox:browser_action"] && !effective.action) {
        issues.push(
          'Firefox browser_action found but no chromium:action. Chromium MV3 uses "action" instead of "browser_action".',
        );
      }
    }

    if (isFirefox) {
      const contentScripts = effective.content_scripts as
        | Array<Record<string, unknown>>
        | undefined;

      if (contentScripts) {
        for (const cs of contentScripts) {
          if (cs.world === "MAIN" || cs["world"] === "MAIN") {
            issues.push(
              'content_scripts.world: "MAIN" is Chromium-only. Use "chromium:world": "MAIN" and provide a Firefox fallback.',
            );
          }
        }
      }
      if (chromiumManifest.side_panel && !effective.sidebar_action) {
        issues.push(
          "Chromium side_panel declared but no firefox:sidebar_action. Firefox uses sidebar_action for sidebars.",
        );
      }

      const bg = effective.background as Record<string, unknown> | undefined;

      if (bg) {
        if (bg.service_worker && !bg.scripts) {
          issues.push(
            'Background service_worker declared but no firefox:scripts. Firefox uses "scripts" (array) instead of "service_worker".',
          );
        }
      }
    }

    result.browserSupport[browser] = {
      supported: issues.length === 0,
      issues,
    };

    if (issues.length) {
      result.valid = false;
    }
  }

  const surfaces: string[] = [];
  if (chromiumManifest.content_scripts) surfaces.push("content");
  if (chromiumManifest.side_panel) surfaces.push("sidebar");
  if (chromiumManifest.action || manifest["firefox:browser_action"])
    surfaces.push("action");
  if ((chromiumManifest.chrome_url_overrides as Record<string, unknown>)?.newtab)
    surfaces.push("newtab");
  if (chromiumManifest.background) surfaces.push("background");

  if (surfaces.length) {
    try {
      const templates = await listTemplates();
      result.similarTemplates = templates
        .filter((t) => t.surfaces.some((s) => surfaces.includes(s)))
        .slice(0, 5)
        .map((t) => ({ slug: t.slug, surfaces: t.surfaces }));
    } catch {
    }
  }

  if (result.errors.length === 0) {
    result.valid = Object.values(result.browserSupport).every(
      (b) => b.supported,
    );
  }

  return JSON.stringify(result);
}
