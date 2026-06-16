import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const schema = {
  name: "extension_detect_browsers",
  description:
    "Detect which browsers are available for extension development. Checks both system-installed and managed browsers, returning paths and capabilities for each.",
  inputSchema: {
    type: "object" as const,
    properties: {
      browsers: {
        type: "array",
        items: {
          type: "string",
          enum: ["chrome", "chromium", "edge", "firefox"],
        },
        description: "Browsers to check. If omitted, checks all.",
      },
    },
  },
};

interface DetectedBrowser {
  browser: string;
  binaryPath: string | null;
  source: "managed" | "system" | "not_found";
  engine: "chromium" | "gecko";
  version: string | null;
  cdpSupport: boolean;
  rdpSupport: boolean;
}

const ALL_BROWSERS = ["chrome", "chromium", "edge", "firefox"] as const;

// Platform-specific default binary paths for system-installed browsers
const SYSTEM_PATHS: Record<string, Record<string, string[]>> = {
  darwin: {
    chrome: [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      `${process.env.HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
    ],
    chromium: [
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      `${process.env.HOME}/Applications/Chromium.app/Contents/MacOS/Chromium`,
    ],
    edge: [
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      `${process.env.HOME}/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge`,
    ],
    firefox: [
      "/Applications/Firefox.app/Contents/MacOS/firefox",
      `${process.env.HOME}/Applications/Firefox.app/Contents/MacOS/firefox`,
    ],
  },
  linux: {
    chrome: [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/local/bin/google-chrome",
    ],
    chromium: [
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/snap/bin/chromium",
    ],
    edge: [
      "/usr/bin/microsoft-edge",
      "/usr/bin/microsoft-edge-stable",
      "/opt/microsoft/msedge/msedge",
    ],
    firefox: [
      "/usr/bin/firefox",
      "/snap/bin/firefox",
      "/usr/lib/firefox/firefox",
    ],
  },
  win32: {
    chrome: [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ],
    chromium: ["C:\\Program Files\\Chromium\\Application\\chrome.exe"],
    edge: [
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ],
    firefox: [
      "C:\\Program Files\\Mozilla Firefox\\firefox.exe",
      "C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe",
    ],
  },
};

function resolveCacheRoot(): string {
  const explicit = String(process.env.EXT_BROWSERS_CACHE_DIR || "").trim();
  if (explicit) return path.resolve(explicit);

  const isWin = process.platform === "win32";
  const isMac = process.platform === "darwin";

  if (isWin) {
    const local = String(process.env.LOCALAPPDATA || "").trim();
    if (local) return path.join(local, "extension.js", "browsers");
    const userProfile = String(process.env.USERPROFILE || "").trim();
    if (userProfile)
      return path.join(
        userProfile,
        "AppData",
        "Local",
        "extension.js",
        "browsers",
      );
    return path.resolve(process.cwd(), ".cache", "extension.js", "browsers");
  }

  if (isMac) {
    const home = String(process.env.HOME || "").trim();
    if (home)
      return path.join(home, "Library", "Caches", "extension.js", "browsers");
    return path.resolve(process.cwd(), ".cache", "extension.js", "browsers");
  }

  const xdg = String(process.env.XDG_CACHE_HOME || "").trim();
  if (xdg) return path.join(xdg, "extension.js", "browsers");
  const home = String(process.env.HOME || "").trim();
  if (home) return path.join(home, ".cache", "extension.js", "browsers");
  return path.resolve(process.cwd(), ".cache", "extension.js", "browsers");
}

function findManagedBinary(browser: string): string | null {
  const browserDir = path.join(resolveCacheRoot(), browser);
  if (!fs.existsSync(browserDir)) return null;

  // Look for known executable patterns in the managed cache
  const execNames: Record<string, string[]> = {
    chrome: ["chrome", "chrome.exe", "Google Chrome for Testing"],
    chromium: [
      "chrome",
      "chromium",
      "chrome.exe",
      "chromium.exe",
      "Chromium.app",
    ],
    edge: ["msedge", "msedge.exe", "microsoft-edge", "Microsoft Edge"],
    firefox: ["firefox", "firefox.exe", "Firefox.app"],
  };

  const names = execNames[browser] ?? [];

  // Shallow search (max 4 levels deep)
  function search(dir: string, depth: number): string | null {
    if (depth > 4) return null;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isFile() && names.includes(entry.name)) {
          return full;
        }
        if (entry.isDirectory() && depth < 4) {
          const found = search(full, depth + 1);
          if (found) return found;
        }
      }
    } catch {
      // Not readable
    }
    return null;
  }

  return search(browserDir, 0);
}

function findSystemBinary(browser: string): string | null {
  const platform = process.platform;
  const paths = SYSTEM_PATHS[platform]?.[browser] ?? [];

  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }

  return null;
}

async function getVersion(
  binaryPath: string,
  browser: string,
): Promise<string | null> {
  try {
    const flag = browser === "firefox" ? "--version" : "--version";
    const { stdout } = await execFileAsync(binaryPath, [flag], {
      timeout: 5000,
      env: { ...process.env },
    });
    // Extract version number from output like "Google Chrome 120.0.6099.109" or "Mozilla Firefox 121.0"
    const match = stdout.match(/[\d]+\.[\d]+[\d.]*/);
    return match ? match[0] : stdout.trim().slice(0, 50);
  } catch {
    return null;
  }
}

export async function handler(args: { browsers?: string[] }): Promise<string> {
  const browsersToCheck = args.browsers ?? [...ALL_BROWSERS];
  const detected: DetectedBrowser[] = [];
  const managed: { cacheRoot: string; installed: string[] } = {
    cacheRoot: resolveCacheRoot(),
    installed: [],
  };

  // Check managed cache
  for (const browser of ALL_BROWSERS) {
    const browserDir = path.join(managed.cacheRoot, browser);
    if (fs.existsSync(browserDir)) {
      managed.installed.push(browser);
    }
  }

  // Detect each requested browser
  for (const browser of browsersToCheck) {
    const isGecko = browser === "firefox";

    // Check managed first, then system
    let binaryPath = findManagedBinary(browser);
    let source: DetectedBrowser["source"] = "managed";

    if (!binaryPath) {
      binaryPath = findSystemBinary(browser);
      source = binaryPath ? "system" : "not_found";
    }

    let version: string | null = null;
    if (binaryPath) {
      version = await getVersion(binaryPath, browser);
    }

    detected.push({
      browser,
      binaryPath,
      source,
      engine: isGecko ? "gecko" : "chromium",
      version,
      cdpSupport: !isGecko,
      rdpSupport: isGecko,
    });
  }

  const available = detected.filter((d) => d.source !== "not_found");
  const missing = detected.filter((d) => d.source === "not_found");

  return JSON.stringify({
    detected,
    managed,
    summary: {
      available: available.map((d) => d.browser),
      missing: missing.map((d) => d.browser),
    },
    hint: missing.length
      ? `Missing browser(s): ${missing.map((d) => d.browser).join(", ")}. Use extension_install_browser to install them.`
      : "All requested browsers are available.",
  });
}
