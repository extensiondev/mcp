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

  const result = {
    browser,
    distPath,
    totalSize,
    totalSizeFormatted: formatBytes(totalSize),
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
      noSourceMaps: !files.some((f) => f.type === "sourcemap"),
      under10MB: totalSize < 10 * 1024 * 1024,
    },
  };

  return JSON.stringify(result);
}
