// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

export const schema = {
  name: "extension_inspect",
  description:
    "Inspect a built extension: file sizes, entry points, permissions used, and structure analysis. The extension must be built first.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: {
        type: "string",
        description: "Path to the extension project root",
      },
      browser: {
        type: "string",
        default: "chrome",
        description: "Browser build to inspect",
      },
      format: {
        type: "string",
        enum: ["summary", "tree", "json"],
        default: "summary",
      },
    },
    required: ["projectPath"],
  },
};

interface FileEntry {
  path: string;
  size: number;
  type: string;
}

function walkDir(dir: string, base: string = ""): FileEntry[] {
  const entries: FileEntry[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = base ? `${base}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        entries.push(...walkDir(path.join(dir, entry.name), rel));
      } else {
        const stat = fs.statSync(path.join(dir, entry.name));
        const ext = path.extname(entry.name).toLowerCase();
        let type = "other";
        if ([".js", ".mjs"].includes(ext)) type = "javascript";
        else if ([".css"].includes(ext)) type = "stylesheet";
        else if ([".html", ".htm"].includes(ext)) type = "html";
        else if ([".json"].includes(ext)) type = "json";
        else if (
          [".png", ".jpg", ".svg", ".gif", ".ico", ".webp"].includes(ext)
        )
          type = "image";
        else if ([".woff", ".woff2", ".ttf", ".otf"].includes(ext))
          type = "font";
        else if ([".wasm"].includes(ext)) type = "wasm";
        else if ([".map"].includes(ext)) type = "sourcemap";
        entries.push({ path: rel, size: stat.size, type });
      }
    }
  } catch {
  }
  return entries;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function handler(args: {
  projectPath: string;
  browser?: string;
  format?: string;
}): Promise<string> {
  const browser = args.browser ?? "chrome";
  const distPath = path.resolve(args.projectPath, "dist", browser);

  if (!fs.existsSync(distPath)) {
    return JSON.stringify({
      error: `Build output not found at ${distPath}. Run extension_build first.`,
      hint: `Use extension_build with browser: "${browser}" to build the extension.`,
    });
  }

  const files = walkDir(distPath);
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);

  let manifest: Record<string, unknown> = {};
  const manifestPath = path.join(distPath, "manifest.json");

  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
  }

  const byType: Record<string, { count: number; size: number }> = {};

  for (const f of files) {
    if (!byType[f.type]) byType[f.type] = { count: 0, size: 0 };
    byType[f.type].count++;
    byType[f.type].size += f.size;
  }

  // A dev dist ships sourcemaps (and inlined HMR runtime); a production build
  // does not. Surface this so the reported size isn't mistaken for shippable
  // weight, sourcemaps never reach the store zip.
  const sourcemapSize = byType.sourcemap?.size ?? 0;
  const buildType = sourcemapSize > 0 ? "development" : "production";
  const shippableSize = totalSize - sourcemapSize;

  // Entry points a caller cares about (content scripts, background, popup) are
  // usually small and get buried under assets in the top-10-by-size list, which
  // reads as "my content script didn't ship". List declared entrypoints
  // explicitly with a present/size flag so their presence is unambiguous.
  const sizeByPath = new Map(files.map((f) => [f.path, f.size]));
  const entrypoints: Array<{
    role: string;
    path: string;
    present: boolean;
    sizeFormatted?: string;
  }> = [];
  const addEntry = (role: string, ref: unknown) => {
    if (typeof ref !== "string") return;
    const size = sizeByPath.get(ref.replace(/^\.?\//, ""));
    entrypoints.push({
      role,
      path: ref,
      present: size !== undefined,
      ...(size !== undefined ? { sizeFormatted: formatBytes(size) } : {}),
    });
  };
  const bg = manifest.background as Record<string, unknown> | undefined;
  if (bg?.service_worker) addEntry("background.service_worker", bg.service_worker);
  if (Array.isArray(bg?.scripts))
    bg.scripts.forEach((s) => addEntry("background.scripts", s));
  const actionField = (manifest.action || manifest.browser_action) as
    | Record<string, unknown>
    | undefined;
  if (actionField?.default_popup)
    addEntry("action.default_popup", actionField.default_popup);
  const contentScripts = manifest.content_scripts as
    | Array<Record<string, unknown>>
    | undefined;
  if (Array.isArray(contentScripts)) {
    contentScripts.forEach((c, i) => {
      if (Array.isArray(c.js))
        c.js.forEach((j) => addEntry(`content_scripts[${i}].js`, j));
      if (Array.isArray(c.css))
        c.css.forEach((s) => addEntry(`content_scripts[${i}].css`, s));
    });
  }

  // Flag assets that silently bloat the shipped package: store-listing promo
  // images (screenshot/promo/marquee) that belong in the listing, not the zip,
  // and any single non-icon asset that dominates the shippable bundle. These
  // kept storeReadiness green while inflating size in the swarm findings.
  const PROMO_RE =
    /(screenshot|promo|marquee|tile|banner|preview)[-_.]?\d*\.(png|jpe?g|webp|gif)$/i;
  const sizeWarnings: string[] = [];
  for (const f of files) {
    if (f.type === "sourcemap") continue;
    if (PROMO_RE.test(f.path)) {
      sizeWarnings.push(
        `${f.path} (${formatBytes(f.size)}) looks like a store-listing promo image shipped inside the extension package, move it out of the bundled sources so it does not inflate the store zip.`,
      );
    } else if (
      f.type === "image" &&
      !f.path.includes("icon") &&
      f.size > 50 * 1024 &&
      shippableSize > 0 &&
      f.size / shippableSize > 0.25
    ) {
      sizeWarnings.push(
        `${f.path} (${formatBytes(f.size)}) is ${Math.round(
          (f.size / shippableSize) * 100,
        )}% of the shipped bundle, unusually large for a shipped asset.`,
      );
    }
  }

  const result = {
    browser,
    distPath,
    entrypoints,
    ...(sizeWarnings.length ? { sizeWarnings } : {}),
    buildType,
    totalSize,
    totalSizeFormatted: formatBytes(totalSize),
    shippableSize,
    shippableSizeFormatted: formatBytes(shippableSize),
    fileCount: files.length,
    ...(buildType === "development"
      ? {
          note: `This dist contains ${formatBytes(sourcemapSize)} of sourcemaps and looks like a dev build; run extension_build for production sizes. shippableSize excludes sourcemaps.`,
        }
      : {}),
    manifest: {
      name: manifest.name,
      version: manifest.version,
      manifest_version: manifest.manifest_version,
      permissions: manifest.permissions,
    },
    byType: Object.fromEntries(
      Object.entries(byType).map(([type, data]) => [
        type,
        {
          count: data.count,
          size: data.size,
          sizeFormatted: formatBytes(data.size),
        },
      ]),
    ),
    ...(args.format === "tree" || args.format === "json"
      ? {
          files: files.map((f) => ({
            ...f,
            sizeFormatted: formatBytes(f.size),
          })),
        }
      : {
          largestFiles: files
            .sort((a, b) => b.size - a.size)
            .slice(0, 10)
            .map((f) => ({
              path: f.path,
              size: f.size,
              sizeFormatted: formatBytes(f.size),
            })),
        }),
    storeReadiness: {
      hasManifest: fs.existsSync(manifestPath),
      hasIcons: files.some(
        (f) => f.type === "image" && f.path.includes("icon"),
      ),
      // hasIcons alone stayed green when only small icons shipped; the Chrome
      // Web Store specifically requires a 128x128 manifest icon (persona F30).
      has128Icon:
        typeof (manifest.icons as Record<string, unknown> | undefined)?.[
          "128"
        ] === "string",
      noSourceMaps: !files.some((f) => f.type === "sourcemap"),
      noPromoAssets: !files.some((f) => PROMO_RE.test(f.path)),
      under10MB: totalSize < 10 * 1024 * 1024,
    },
  };

  return JSON.stringify(result);
}
