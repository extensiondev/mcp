import fs from "node:fs";
import path from "node:path";
import { getTemplateBySlug } from "../lib/templates-cache";

const RAW_BASE =
  "https://raw.githubusercontent.com/extension-js/examples/main/examples";

export const schema = {
  name: "extension_add_feature",
  description:
    "Add a new feature surface to an existing extension. Generates the required files and updates manifest.json. Sources patterns from the extension.dev template catalog.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: {
        type: "string",
        description: "Path to the extension project root",
      },
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

// Map feature + framework to the best reference template
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

// Manifest fields needed per feature
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

  // Validate project exists
  const manifestPath = path.join(srcDir, "manifest.json");

  if (!fs.existsSync(manifestPath)) {
    return JSON.stringify({
      error: `No manifest.json found at ${manifestPath}`,
      hint: "Ensure projectPath points to an extension project root with src/manifest.json",
    });
  }

  // Find reference template
  const templateSlug = FEATURE_TEMPLATE_MAP[args.feature]?.[framework];

  if (!templateSlug) {
    return JSON.stringify({
      error: `No reference template for feature "${args.feature}" with framework "${framework}"`,
    });
  }

  const template = await getTemplateBySlug(templateSlug);
  const referenceFiles = template?.keyFiles ?? template?.files ?? [];

  // Determine what files to create
  const featureDir =
    args.feature === "content-script" ? "content" : args.feature;
  const filesToCreate: Array<{ path: string; hint: string }> = [];
  const manifestUpdates = MANIFEST_ADDITIONS[args.feature] ?? {};

  if (
    ["sidebar", "popup", "newtab", "options", "devtools"].includes(args.feature)
  ) {
    filesToCreate.push(
      { path: `src/${featureDir}/index.html`, hint: "HTML entry point" },
      {
        path: `src/${featureDir}/scripts.${framework === "vanilla" ? "ts" : "tsx"}`,
        hint:
          framework === "vanilla"
            ? "Script entry point"
            : `${framework} mount point`,
      },
      { path: `src/${featureDir}/styles.css`, hint: "Stylesheet" },
    );

    if (framework !== "vanilla") {
      filesToCreate.push({
        path: `src/${featureDir}/${featureDir.charAt(0).toUpperCase() + featureDir.slice(1)}App.tsx`,
        hint: `Main ${framework} component`,
      });
    }
  }

  if (args.feature === "content-script") {
    filesToCreate.push(
      { path: "src/content/scripts.ts", hint: "Content script entry point" },
      { path: "src/content/styles.css", hint: "Content script styles" },
    );
  }

  if (args.feature === "background") {
    filesToCreate.push({
      path: "src/background.ts",
      hint: "Background service worker / script",
    });
  }

  // Check for conflicts
  const conflicts = filesToCreate.filter((f) =>
    fs.existsSync(path.join(projectPath, f.path)),
  );

  return JSON.stringify({
    feature: args.feature,
    framework,
    referenceTemplate: {
      slug: templateSlug,
      repositoryUrl: `https://github.com/extension-js/examples/tree/main/examples/${templateSlug}`,
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
      `4. Reference template source: https://github.com/extension-js/examples/tree/main/examples/${templateSlug}/src`,
      "5. Run npm run dev to test",
    ].filter(Boolean),
    hint: conflicts.length
      ? `Warning: ${conflicts.length} file(s) already exist and would be overwritten.`
      : "No conflicts detected. Safe to create all files.",
  });
}
