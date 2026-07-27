// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { PROJECT_PATH } from "../lib/common-schema";
import fs from "node:fs";
import path from "node:path";
import { getTemplateBySlug } from "../lib/templates-cache";
import { PINNED_COMMIT } from "../lib/template-artifact-source";
import { envelope } from "../lib/envelope";

const COMMAND = "extension_add_feature";

const EXAMPLES_TREE_BASE = `https://github.com/extension-js/examples/tree/${PINNED_COMMIT}/examples`;

export const schema = {
  name: "extension_add_feature",
  description:
    "Plan a new feature surface for an existing extension. This returns step-by-step instructions, the manifest additions to make, and reference templates from the extension.dev catalog. It modifies no files: apply the returned plan yourself.",
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

const FEATURE_TEMPLATE_MAP: Record<string, Record<string, string>> = {
  sidebar: {
    react: "sidebar-shadcn",
    vanilla: "sidebar",
    vue: "sidebar",
    svelte: "sidebar",
    preact: "sidebar",
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
    react: "new-react",
    vue: "new-vue",
    svelte: "new-svelte",
    preact: "new-preact",
    vanilla: "new",
  },
  background: {
    react: "javascript",
    vanilla: "javascript",
    vue: "javascript",
    svelte: "javascript",
    preact: "javascript",
  },
  options: {
    react: "javascript",
    vanilla: "javascript",
    vue: "javascript",
    svelte: "javascript",
    preact: "javascript",
  },
  devtools: {
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

  const templateSlug = FEATURE_TEMPLATE_MAP[args.feature]?.[framework];

  if (!templateSlug) {
    return envelope({
      ok: false,
      command: COMMAND,
      status: "no-reference-template",
      error: {
        code: "E_NO_REFERENCE_TEMPLATE",
        message: `No reference template for feature "${args.feature}" with framework "${framework}"`,
      },
    });
  }

  const template = await getTemplateBySlug(templateSlug);
  const referenceFiles = template?.keyFiles ?? template?.files ?? [];

  const FEATURE_DIR: Record<string, string> = {
    "content-script": "content",
    popup: "action",
  };
  const featureDir = FEATURE_DIR[args.feature] ?? args.feature;

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
  const manifestUpdates = MANIFEST_ADDITIONS[args.feature] ?? {};

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

  const conflictHint = `Warning: ${conflicts.length} file(s) already exist and would be overwritten.`;

  return envelope({
    ok: true,
    command: COMMAND,
    status: conflicts.length ? "planned-with-conflicts" : "planned",
    value: {
      feature: args.feature,
      framework,
      referenceTemplate: {
        slug: templateSlug,
        repositoryUrl: `${EXAMPLES_TREE_BASE}/${templateSlug}`,
        referenceFiles: referenceFiles.filter(
          (f: string) => f.includes(featureDir) || f.includes("manifest"),
        ),
      },
      manifestUpdates,
      filesToCreate: filesToCreate.map((f) => ({
        ...f,
        exists: fs.existsSync(path.join(projectPath, f.path)),
      })),
      conflicts: conflicts.map((c) => c.path),
      instructions: [
        `1. Add these fields to your src/manifest.json:\n${JSON.stringify(manifestUpdates, null, 2)}`,
        `2. Create the following files in your project:`,
        ...filesToCreate.map((f) => `   - ${f.path} (${f.hint})`),
        args.feature === "sidebar"
          ? "3. Add background.ts to handle sidebar open: chromium uses chrome.sidePanel.setPanelBehavior, firefox uses browser.sidebarAction.open()"
          : "",
        `4. Reference template source: ${EXAMPLES_TREE_BASE}/${templateSlug}/src`,
        "5. Run npm run dev to test",
      ].filter(Boolean),
    },
    warnings: conflicts.length ? [conflictHint] : [],
    ...(conflicts.length
      ? {}
      : { hint: "No conflicts detected. Safe to create all files." }),
  });
}
