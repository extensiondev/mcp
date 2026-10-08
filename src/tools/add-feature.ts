// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import { PROJECT_PATH } from "../lib/common-schema";
import { getTemplateBySlug, listTemplates } from "../lib/templates-cache";
import {
  PINNED_COMMIT,
  templateCatalogUrl,
} from "../lib/template-artifact-source";
import { envelope } from "../lib/envelope";

const COMMAND = "extension_add_feature";

const EXAMPLES_TREE_BASE = `https://github.com/extension-js/examples/tree/${PINNED_COMMIT}/examples`;

export const schema = {
  name: "extension_add_feature",
  description:
    "Plan the surface before adding an options page, a popup, a side panel, a content script, a devtools panel, a new tab page or a background script to an existing extension. It answers with the manifest additions, the files to create and the catalog template to copy from, and modifies nothing: write what the plan says, then validate the manifest and run extension_dev.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: PROJECT_PATH,
      feature: {
        type: "string",
        enum: [
          "sidebar",
          "popup",
          "options",
          "content-script",
          "background",
          "newtab",
          "devtools",
        ],
        description: "Feature surface to add",
      },
      framework: {
        type: "string",
        enum: ["react", "vue", "svelte", "preact", "vanilla"],
        default: "react",
      },
    },
    required: ["projectPath", "feature"],
  },
};

export const FEATURE_TEMPLATE_MAP: Record<string, Record<string, string>> = {
  sidebar: {
    react: "sidebar-shadcn",
    vanilla: "sidebar",
    vue: "vue",
    svelte: "svelte",
    preact: "preact",
  },
  "content-script": {
    react: "content-react",
    vue: "content-vue",
    svelte: "content-svelte",
    preact: "content-preact",
    vanilla: "content",
  },
  popup: {
    react: "action",
    vanilla: "action",
    vue: "action",
    svelte: "action",
    preact: "action",
  },
  newtab: {
    react: "newtab-react",
    vue: "newtab-vue",
    svelte: "newtab-svelte",
    preact: "newtab-preact",
    vanilla: "newtab",
  },
  background: {
    react: "javascript",
    vanilla: "javascript",
    vue: "javascript",
    svelte: "javascript",
    preact: "javascript",
  },
};

const MANIFEST_ADDITIONS: Record<string, Record<string, unknown>> = {
  sidebar: {
    "chromium:side_panel": { default_path: "sidebar/index.html" },
    "firefox:sidebar_action": { default_panel: "sidebar/index.html" },
    "chromium:permissions": ["sidePanel"],
  },
  popup: {
    "chromium:action": {
      default_popup: "action/index.html",
      default_title: "Extension Popup",
    },
    "firefox:browser_action": {
      default_popup: "action/index.html",
      default_title: "Extension Popup",
    },
  },
  "content-script": {
    content_scripts: [
      {
        matches: ["<all_urls>"],
        js: ["content/scripts.ts"],
        css: ["content/styles.css"],
      },
    ],
  },
  newtab: {
    chrome_url_overrides: { newtab: "newtab/index.html" },
  },
  options: {
    options_ui: { page: "options/index.html", open_in_tab: true },
  },
  background: {
    background: {
      "chromium:service_worker": "background.ts",
      "firefox:scripts": ["background.ts"],
    },
  },
  devtools: {
    devtools_page: "devtools/index.html",
  },
};

export async function handler(args: {
  projectPath: string;
  feature: string;
  framework?: string;
}): Promise<string> {
  const framework = args.framework ?? "react";
  const projectPath = path.resolve(args.projectPath);
  const srcDir = path.join(projectPath, "src");

  const manifestPath = path.join(srcDir, "manifest.json");

  if (!fs.existsSync(manifestPath)) {
    return envelope({
      ok: false,
      command: COMMAND,
      status: "manifest-not-found",
      error: {
        code: "E_MANIFEST_NOT_FOUND",
        message: `No manifest.json found at ${manifestPath}`,
      },
      hint: "Ensure projectPath points to an extension project root with src/manifest.json",
    });
  }

  const FEATURE_DIR: Record<string, string> = {
    "content-script": "content",
    popup: "action",
  };
  const featureDir = FEATURE_DIR[args.feature] ?? args.feature;

  let templateSlug: string | undefined = FEATURE_TEMPLATE_MAP[args.feature]?.[framework];
  let referenceNote: string | undefined;

  if (!templateSlug) {
    try {
      const carriers = await listTemplates({ surface: featureDir });
      const exact = carriers.find((t) => (t.uiFramework ?? "vanilla") === framework);
      const pick = exact ?? carriers[0];

      if (pick) {
        templateSlug = pick.slug;

        if (!exact) {
          referenceNote = `No ${framework} template in the catalog ships a ${featureDir} surface; ${pick.slug} (${pick.uiFramework ?? "vanilla"}) is referenced for the surface wiring only.`;
        }
      }
    } catch {
      referenceNote = `The template catalog could not be read, so whether a template ships a ${featureDir} surface is unknown.`;
    }
  }

  const template = templateSlug
    ? await getTemplateBySlug(templateSlug)
    : undefined;
  const referenceFiles = template?.keyFiles ?? template?.files ?? [];

  const scriptExt =
    framework === "react" || framework === "preact" ? "tsx" : "ts";
  const componentExt =
    framework === "vue" ? "vue" : framework === "svelte" ? "svelte" : "tsx";
  const COMPONENT_BASE: Record<string, string> = {
    content: "Content",
    sidebar: "Sidebar",
    action: "Action",
    newtab: "NewTab",
    options: "Options",
    devtools: "DevTools",
    background: "Background",
  };
  const componentBase =
    COMPONENT_BASE[featureDir] ??
    featureDir.charAt(0).toUpperCase() + featureDir.slice(1);

  const filesToCreate: Array<{ path: string; hint: string }> = [];
  const manifestUpdates: Record<string, unknown> = { ...(MANIFEST_ADDITIONS[args.feature] ?? {}) };

  if (
    ["sidebar", "popup", "newtab", "options", "devtools"].includes(args.feature)
  ) {
    filesToCreate.push(
      { path: `src/${featureDir}/index.html`, hint: "HTML entry point" },
      {
        path: `src/${featureDir}/scripts.${scriptExt}`,
        hint:
          framework === "vanilla"
            ? "Script entry point"
            : `${framework} mount point`,
      },
      { path: `src/${featureDir}/styles.css`, hint: "Stylesheet" },
    );

    if (framework !== "vanilla") {
      filesToCreate.push({
        path: `src/${featureDir}/${componentBase}App.${componentExt}`,
        hint: `Main ${framework} component`,
      });

      if (framework === "vue") {
        filesToCreate.push({
          path: `src/${featureDir}/shims-vue.d.ts`,
          hint: "Vue SFC type shim (lets TS import .vue components)",
        });
      }
    }
  }

  if (args.feature === "content-script") {
    filesToCreate.push(
      {
        path: "src/content/scripts.ts",
        hint:
          framework === "vanilla"
            ? "Content script entry point"
            : `${framework} content-script mount point`,
      },
      { path: "src/content/styles.css", hint: "Content script styles" },
    );

    if (framework !== "vanilla") {
      filesToCreate.push({
        path: `src/content/ContentApp.${componentExt}`,
        hint: `Main ${framework} component mounted by the content script`,
      });

      if (framework === "vue") {
        filesToCreate.push({
          path: "src/content/shims-vue.d.ts",
          hint: "Vue SFC type shim (lets TS import .vue components)",
        });
      }
    }
  }

  if (args.feature === "background") {
    filesToCreate.push({
      path: "src/background.ts",
      hint: "Background service worker / script",
    });
  }

  const conflicts = filesToCreate.filter((f) =>
    fs.existsSync(path.join(projectPath, f.path)),
  );

  const bareKey = (key: string): string =>
    key.replace(/^(chromium|chrome|firefox|gecko|safari|edge|opera|brave):/, "");
  let manifestKeys: string[] | null = null;
  let manifestUnreadable: string | undefined;
  let current: Record<string, unknown> = {};

  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not a JSON object");

    current = parsed as Record<string, unknown>;
    manifestKeys = Object.keys(current);
  } catch (err) {
    manifestUnreadable = err instanceof Error ? err.message : String(err);
  }

  const merged: string[] = [];

  for (const [key, value] of Object.entries(manifestUpdates)) {
    if (!Array.isArray(value)) continue;

    const prefixed = current[key];
    const bare = current[bareKey(key)];
    const existing = Array.isArray(prefixed) ? prefixed : Array.isArray(bare) ? bare : null;
    if (!existing) continue;

    manifestUpdates[key] = [...existing, ...value.filter((v) => !existing.includes(v))];
    merged.push(key);
  }

  const manifestConflicts = manifestKeys
    ? Object.keys(manifestUpdates).filter(
        (key) => !merged.includes(key) && manifestKeys.some((present) => bareKey(present) === bareKey(key)),
      )
    : [];
  const safe = conflicts.length === 0 && manifestConflicts.length === 0 && !manifestUnreadable;

  const conflictHint = `Warning: ${conflicts.length} file(s) already exist and would be overwritten.`;
  const manifestConflictHint = `Warning: src/manifest.json already declares ${manifestConflicts.join(", ")}; the manifest additions above would replace ${manifestConflicts.length === 1 ? "it" : "them"}, so merge by hand instead of pasting.`;
  const manifestUnreadableHint = `src/manifest.json could not be parsed (${manifestUnreadable}), so which keys the additions would replace is unknown.`;

  return envelope({
    ok: true,
    command: COMMAND,
    status: safe ? "planned" : "planned-with-conflicts",
    value: {
      feature: args.feature,
      framework,
      ...(templateSlug
        ? {
            referenceTemplate: {
              slug: templateSlug,
              repositoryUrl: `${EXAMPLES_TREE_BASE}/${templateSlug}`,
              catalogUrl: templateCatalogUrl(templateSlug),
              referenceFiles: referenceFiles.filter(
                (f: string) =>
                  f.includes(featureDir) || f.includes("manifest"),
              ),
            },
          }
        : {}),
      manifestUpdates,
      filesToCreate: filesToCreate.map((f) => ({
        ...f,
        exists: fs.existsSync(path.join(projectPath, f.path)),
      })),
      conflicts: conflicts.map((c) => c.path),
      manifestConflicts,
      manifestMerged: merged,
      manifestReadable: manifestKeys !== null,
      instructions: [
        `1. Add these fields to your src/manifest.json:\n${JSON.stringify(manifestUpdates, null, 2)}`,
        `2. Create the following files in your project:`,
        ...filesToCreate.map((f) => `   - ${f.path} (${f.hint})`),
        args.feature === "sidebar"
          ? "3. Add background.ts to handle sidebar open: chromium uses chrome.sidePanel.setPanelBehavior, firefox uses browser.sidebarAction.open()"
          : "",
        templateSlug
          ? `4. Reference template source: ${EXAMPLES_TREE_BASE}/${templateSlug}/src`
          : "4. No catalog template ships this surface yet: build from the manifest additions and file hints above",
        "5. Validate the manifest with extension_manifest_validate, then run extension_dev (npm run dev without the server) to test",
      ].filter(Boolean),
    },
    warnings: [
      ...(referenceNote ? [referenceNote] : []),
      ...(merged.length ? [`${merged.join(", ")} already declared values; the additions above merge them with the new entries, so paste the merged list.`] : []),
      ...(conflicts.length ? [conflictHint] : []),
      ...(manifestConflicts.length ? [manifestConflictHint] : []),
      ...(manifestUnreadable ? [manifestUnreadableHint] : []),
    ],
    ...(safe ? { hint: "No conflicts detected. Safe to create all files." } : {}),
  });
}
