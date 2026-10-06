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
import { envelope } from "../lib/envelope";
import { engineBrowserName } from "../lib/browser-family";
import { isDevelopmentBuild, reviewCoverageNotes, reviewRiskWarnings, reviewRisksReport } from "../lib/store-review";
import { engineProjectRoot } from "../lib/session-paths";

const COMMAND = "extension_analyze";

export const schema = {
  name: "extension_analyze",
  description:
    "Analyze a BUILT extension on disk: file sizes, declared entry points, permissions, bundle composition, and store-readiness checks. This is static only: it reads dist/<browser> from the filesystem and never touches a browser, so build first with extension_build. Use extension_inspect for a running extension's live DOM and console.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: PROJECT_PATH,
      browser: {
        type: "string",
        default: "chrome",
        description: "Browser build to analyze",
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
        let stat: fs.Stats;
        try {
          stat = fs.statSync(path.join(dir, entry.name));
        } catch {
          entries.push({ path: rel, size: 0, type: "unreadable" });
          continue;
        }
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
        else if ([".zip"].includes(ext)) type = "archive";
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
  const distPath = path.join(engineProjectRoot(args.projectPath), "dist", engineBrowserName(browser));

  if (!fs.existsSync(distPath)) {
    return envelope({
      ok: false,
      command: COMMAND,
      status: "no-dist",
      error: {
        code: "E_NO_DIST",
        message: `Build output not found at ${distPath}. Run extension_build first.`,
      },
      hint: `Use extension_build with browser: "${browser}" to build the extension.`,
    });
  }

  const files = walkDir(distPath);
  if (files.length === 0) {
    return envelope({
      ok: false,
      command: COMMAND,
      status: "dist-empty",
      error: { code: "E_NO_DIST", message: `${distPath} holds no files, so there is nothing to analyze. Run extension_build first.` },
    });
  }
  const unreadable = files.filter((f) => f.type === "unreadable").map((f) => f.path);
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);

  let manifest: Record<string, unknown> = {};
  const manifestPath = path.join(distPath, "manifest.json");

  /* @invariant AN UNREADABLE DIST IS NOT AN ANALYZED ONE. A manifest that
     could not be parsed used to become `{}` and the readiness flags all
     passed on nothing. */
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    manifest = parsed as Record<string, unknown>;
  } catch (err) {
    return envelope({
      ok: false,
      command: COMMAND,
      status: "dist-unreadable",
      error: {
        code: "E_NO_DIST",
        message: `${manifestPath} ${fs.existsSync(manifestPath) ? `could not be parsed (${(err as Error)?.message ?? String(err)})` : "does not exist"}, so this dist cannot be analyzed. Run extension_build first.`,
      },
    });
  }

  const byType: Record<string, { count: number; size: number }> = {};

  for (const f of files) {
    if (!byType[f.type]) byType[f.type] = { count: 0, size: 0 };
    byType[f.type].count++;
    byType[f.type].size += f.size;
  }

  const sourcemapSize = byType.sourcemap?.size ?? 0;
  const buildType = isDevelopmentBuild(files) ? "development" : "production";
  const archiveSize = byType.archive?.size ?? 0;
  const shippableSize = totalSize - sourcemapSize - archiveSize;

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

  const PROMO_RE =
    /(screenshot|promo|marquee|tile|banner|preview)[-_.]?\d*\.(png|jpe?g|webp|gif)$/i;
  const sizeWarnings: string[] = [];
  for (const f of files) {
    if (f.type === "sourcemap" || f.type === "archive") continue;
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

  const note =
    buildType === "development"
      ? `This dist holds the dev runtime (hot-update or the engine's companion files) and is a dev build; run extension_build for production sizes. shippableSize excludes sourcemaps.`
      : sourcemapSize > 0
        ? `This dist contains ${formatBytes(sourcemapSize)} of sourcemaps; they ship unless the build strips them. shippableSize excludes them.`
        : undefined;
  const archiveNote =
    archiveSize > 0
      ? `This dist contains ${formatBytes(archiveSize)} of .zip archive(s) (store packaging output, written into dist by zip builds). shippableSize excludes them so the packaged copy does not double-count the files it contains.`
      : undefined;

  const review = reviewRisksReport({
    distPath,
    browser,
    manifest,
    files,
    development: buildType === "development",
  });
  const risks = review.risks;

  const result = {
    browser,
    distPath,
    reviewRisks: risks,
    reviewCoverage: { unreadable: review.unreadable, notScanned: review.notScanned },
    entrypoints,
    buildType,
    totalSize,
    totalSizeFormatted: formatBytes(totalSize),
    shippableSize,
    shippableSizeFormatted: formatBytes(shippableSize),
    fileCount: files.length,
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
      has128Icon: (() => {
        const icon = (manifest.icons as Record<string, unknown> | undefined)?.["128"];
        return typeof icon === "string" && fs.existsSync(path.join(distPath, icon.replace(/^\.?\//, "")));
      })(),
      noSourceMaps: !files.some((f) => f.type === "sourcemap"),
      noPromoAssets: !files.some((f) => PROMO_RE.test(f.path)),
      under10MB: totalSize - archiveSize < 10 * 1024 * 1024,
    },
  };

  return envelope({
    ok: true,
    command: COMMAND,
    status: "analyzed",
    value: result,
    warnings: [
      ...reviewRiskWarnings(risks),
      ...reviewCoverageNotes(review),
      ...sizeWarnings,
      note,
      archiveNote,
      unreadable.length
        ? `${unreadable.length} entr${unreadable.length === 1 ? "y" : "ies"} could not be read and count as 0 bytes: ${unreadable.join(", ")}.`
        : undefined,
    ],
  });
}
