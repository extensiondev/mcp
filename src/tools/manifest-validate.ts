import fs from "node:fs";
import path from "node:path";
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

  // Read manifest
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

  // Required fields
  if (!manifest.name) {
    result.errors.push("Missing required field: name");
  }
  if (!manifest.version) {
    result.warnings.push(
      "Missing field: version (required for store submission)",
    );
  }

  // Manifest version
  const chromiumMv =
    manifest["chromium:manifest_version"] ?? manifest.manifest_version;
  const firefoxMv =
    manifest["firefox:manifest_version"] ?? manifest.manifest_version;

  if (!chromiumMv && !manifest.manifest_version) {
    result.errors.push(
      'Missing manifest_version. Use "chromium:manifest_version": 3 and "firefox:manifest_version": 2 for cross-browser support.',
    );
  }

  // Browser-specific validation
  for (const browser of browsers) {
    const isChromium = ["chrome", "edge", "chromium-based"].includes(browser);
    const isFirefox = ["firefox", "gecko-based"].includes(browser);
    const issues: string[] = [];

    if (isChromium) {
      const mv = chromiumMv as number;

      if (mv && mv < 3) {
        issues.push(
          "Manifest V2 is deprecated on Chromium. Use chromium:manifest_version: 3.",
        );
      }

      // Side panel check
      if (manifest["chromium:side_panel"] || manifest.side_panel) {
        const perms = (manifest["chromium:permissions"] ??
          manifest.permissions ??
          []) as string[];

        if (!perms.includes("sidePanel")) {
          issues.push(
            'Side panel declared but "sidePanel" permission is missing.',
          );
        }
      }
      // Action check
      if (
        manifest["firefox:browser_action"] &&
        !manifest["chromium:action"] &&
        !manifest.action
      ) {
        issues.push(
          'Firefox browser_action found but no chromium:action. Chromium MV3 uses "action" instead of "browser_action".',
        );
      }
    }

    if (isFirefox) {
      // world: MAIN check
      const contentScripts = manifest.content_scripts as
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
      // Side panel vs sidebar action
      if (
        manifest["chromium:side_panel"] &&
        !manifest["firefox:sidebar_action"]
      ) {
        issues.push(
          "Chromium side_panel declared but no firefox:sidebar_action. Firefox uses sidebar_action for sidebars.",
        );
      }

      // Service worker vs scripts
      const bg = manifest.background as Record<string, unknown> | undefined;

      if (bg) {
        if (bg.service_worker && !bg["firefox:scripts"] && !bg.scripts) {
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

  // Find similar templates in the catalog
  const surfaces: string[] = [];
  if (manifest.content_scripts) surfaces.push("content");
  if (manifest["chromium:side_panel"] || manifest.side_panel)
    surfaces.push("sidebar");
  if (
    manifest.action ||
    manifest["chromium:action"] ||
    manifest["firefox:browser_action"]
  )
    surfaces.push("action");
  if ((manifest.chrome_url_overrides as Record<string, unknown>)?.newtab)
    surfaces.push("newtab");
  if (manifest.background) surfaces.push("background");

  if (surfaces.length) {
    try {
      const templates = await listTemplates();
      result.similarTemplates = templates
        .filter((t) => t.surfaces.some((s) => surfaces.includes(s)))
        .slice(0, 5)
        .map((t) => ({ slug: t.slug, surfaces: t.surfaces }));
    } catch {
      // Template lookup is best-effort
    }
  }

  if (result.errors.length === 0) {
    result.valid = Object.values(result.browserSupport).every(
      (b) => b.supported,
    );
  }

  return JSON.stringify(result);
}
