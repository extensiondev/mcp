// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";
import * as build from "./build";
import { navigateToUrl } from "./open";
import { uploadPreview } from "../lib/preview-upload";
import { recordSharedPreview } from "../lib/share-record";


const DEFAULT_INSPECT_URL = "http://localhost:3106";
const DEFAULT_PREVIEW_DEV_URL = "http://localhost:3110";

const SURFACES = {
  preview: {
    defaultOrigin: DEFAULT_PREVIEW_DEV_URL,
    scheme: (encoded: string) => `preview://build/${encoded}`,
    fetchPath: "/__preview/fetch",
    devCommand: "pnpm --filter preview.extension.dev dev",
    label: "preview.extension.dev",
  },
  inspect: {
    defaultOrigin: DEFAULT_INSPECT_URL,
    scheme: (encoded: string) => `inspect://path/${encoded}`,
    fetchPath: "/__inspect/fetch",
    devCommand: "pnpm --filter inspect.extension.dev dev",
    label: "inspect.extension.dev",
  },
} as const;

type SurfaceKey = keyof typeof SURFACES;

async function buildShare(
  projectPath: string,
  distDir: string,
  manifest: Record<string, any>,
  browser: string,
): Promise<Record<string, unknown>> {
  const result = await uploadPreview({ distDir, manifest, browser });
  if (!result.ok) {
    const isAuth = result.error.name === "PreviewAuthError";
    return {
      requested: true,
      ok: false,
      supported: !isAuth,
      errorName: result.error.name,
      reason: result.error.message,
      ...(isAuth
        ? {
            loginHint:
              "Run extension_login, or set EXTENSION_DEV_TOKEN (create one in the extension.dev dashboard).",
          }
        : {}),
    };
  }

  const sharedAt = new Date().toISOString();
  const record = recordSharedPreview(projectPath, {
    sharedAt,
    previewUrl: result.data.previewUrl,
    artifactId: result.data.artifactId,
    ...(result.data.revokeUrl ? { revokeUrl: result.data.revokeUrl } : {}),
    ...(result.data.expiresAt ? { expiresAt: result.data.expiresAt } : {}),
    ...(result.data.zipUrl ? { zipUrl: result.data.zipUrl } : {}),
    ...(typeof manifest.name === "string" ? { name: manifest.name } : {}),
    ...(typeof manifest.version === "string"
      ? { version: manifest.version }
      : {}),
    browser,
    distDir,
  });

  return {
    requested: true,
    ok: true,
    previewUrl: result.data.previewUrl,
    artifactId: result.data.artifactId,
    sharedAt,
    ...(result.data.expiresAt ? { expiresAt: result.data.expiresAt } : {}),
    ...(result.data.zipUrl ? { zipUrl: result.data.zipUrl } : {}),
    ...(result.data.revokeUrl ? { revokeUrl: result.data.revokeUrl } : {}),
    serves: "uploaded-local-build",
    localBuildUploaded: true,
    record,
    note:
      "Anyone with this link can open the build you just made, running in the emulator. No install, no sign-in, no dev server. They can also download the whole build as a zip from zipUrl, so the link hands over the built code. It stays live until expiresAt; DELETE revokeUrl with the same token to kill it sooner, and a revoked link stays dead. revokeUrl is the only handle that pulls this link early and re-sharing mints a different one, so " +
      (record.recorded
        ? `it was also written to ${record.path} (record.path), which lists every share from this project.`
        : `keep it: ${record.note}`) +
      " To find this link again later, or to pull it back once it has left this conversation, run extension_shares: it lists every link this token has shared with its live or dead state, and revokes one by artifactId or by pasting any of its URLs." +
      (record.warning ? ` ${record.warning}` : ""),
  };
}

function detectSurfaces(manifest: Record<string, any>): string[] {
  const surfaces: string[] = [];
  const push = (surface: string, condition: unknown) => {
    if (condition) surfaces.push(surface);
  };
  const action = manifest.action ?? manifest.browser_action;
  push("popup", action?.default_popup);
  push("newtab", manifest.chrome_url_overrides?.newtab);
  push("history", manifest.chrome_url_overrides?.history);
  push("bookmarks", manifest.chrome_url_overrides?.bookmarks);
  push("options", manifest.options_ui?.page || manifest.options_page);
  push("background-page", manifest.background?.page);
  push("background-worker", manifest.background?.service_worker);
  push(
    "side-panel",
    manifest.side_panel?.default_path || manifest.sidebar_action?.default_panel,
  );
  push("devtools", manifest.devtools_page);
  push("sandbox-page", manifest.sandbox?.pages?.[0]);
  return surfaces;
}

export const schema = {
  name: "extension_preview_web",
  description:
    "Preview an in-progress extension in the web emulator (no real browser). Builds the project (unless build:false), points preview.extension.dev at the dist directory over the dev-only preview://build scheme, and returns a deep link plus a loadability check against its dev server. preview is the author's front door: it renders YOUR build and carries the Emulated/Real lane toggle and the Trace tab. Pass surface:\"inspect\" to render in inspect.extension.dev instead (the evaluator's door, for fixture and forensic work). Pass share:true to UPLOAD the dist you just built and get back a public link (share.previewUrl) that renders those exact bytes for anyone who opens it, with no install and no dev server, and that also serves the whole build as a downloadable zip. Sharing needs a token scoped to an existing extension.dev workspace and project (extension_login or EXTENSION_DEV_TOKEN, valid up to 7 days), so a local folder with no project on the platform cannot share. Use share:true whenever the build has to reach someone who is not at this machine, since the plain deepLink only resolves locally. Shared links do not disappear when this response scrolls away: extension_shares lists every link this token has shared and revokes any of them.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: {
        type: "string",
        description: "Path to the extension project root",
      },
      browser: {
        type: "string",
        enum: [
          "chrome",
          "chromium",
          "edge",
          "brave",
          "opera",
          "vivaldi",
          "yandex",
          "firefox",
          "waterfox",
          "librewolf",
          "safari",
        ],
        default: "chrome",
        description:
          "Which dist/<browser> output to preview. inspect renders it in the mocked-Chrome emulator regardless.",
      },
      build: {
        type: "boolean",
        default: true,
        description:
          "Build the project before previewing. Set false to preview the existing dist/<browser> as-is.",
      },
      distPath: {
        type: "string",
        description:
          "Preview this built directory directly instead of resolving dist/<browser> under projectPath. Implies build:false.",
      },
      surface: {
        type: "string",
        enum: ["preview", "inspect"],
        default: "preview",
        description:
          "Which front door renders the build. \"preview\" (default) is preview.extension.dev, the author's door: your own in-progress build, with the Emulated/Real lane toggle and the Trace tab. \"inspect\" is inspect.extension.dev, the evaluator's door.",
      },
      hostUrl: {
        type: "string",
        description:
          "Origin of the running dev server for the chosen surface (defaults: http://localhost:3110 for preview, http://localhost:3106 for inspect).",
      },
      inspectUrl: {
        type: "string",
        description:
          "Deprecated alias for hostUrl, kept for callers written before the preview surface existed. Only consulted when surface is \"inspect\".",
      },
      probe: {
        type: "boolean",
        default: true,
        description:
          "Confirm the surface can load the artifact by fetching its dev middleware before returning.",
      },
      open: {
        type: "boolean",
        default: false,
        description:
          "Open the deep link in a running dev session's browser (a new background tab, focus-safe) instead of only returning the link. Requires a live extension_dev/extension_preview session for the project.",
      },
      openIn: {
        type: "string",
        enum: [
          "chrome",
          "chromium",
          "edge",
          "brave",
          "opera",
          "vivaldi",
          "yandex",
          "firefox",
          "waterfox",
          "librewolf",
          "safari",
        ],
        description:
          "Which running dev session's browser to open the preview in. Defaults to the `browser` value.",
      },
      share: {
        type: "boolean",
        default: false,
        description:
          "Upload the built dist and return a public link (share.previewUrl) that renders those exact bytes in the emulator for anyone who opens it: no install, no sign-in, no dev server. The link also serves the whole build as a downloadable zip (share.zipUrl), so sharing it hands over the built code. Needs a token scoped to an existing extension.dev workspace and project (extension_login or EXTENSION_DEV_TOKEN, valid up to 7 days); without one this returns a login hint and never fails the local preview. The link stays live until share.expiresAt, and DELETEing share.revokeUrl with the same token kills it sooner; a revoked link stays dead, and re-sharing the same build returns a new link. Because re-sharing never reproduces the old link, every successful share is also appended to .extension.dev/shared-previews.json in the project (gitignored) so the revoke handle survives losing this response, and extension_shares lists what is actually live on the platform and revokes any of it by id or by URL.",
      },
    },
    required: ["projectPath"],
  },
};

export async function handler(args: {
  projectPath: string;
  browser?: string;
  build?: boolean;
  distPath?: string;
  surface?: string;
  hostUrl?: string;
  inspectUrl?: string;
  probe?: boolean;
  open?: boolean;
  openIn?: string;
  share?: boolean;
}): Promise<string> {
  const browser = args.browser ?? "chrome";
  const surfaceKey: SurfaceKey = args.surface === "inspect" ? "inspect" : "preview";
  const surface = SURFACES[surfaceKey];
  const hostBase = (
    args.hostUrl ??
    (surfaceKey === "inspect" ? args.inspectUrl : undefined) ??
    surface.defaultOrigin
  ).replace(/\/+$/, "");
  const shouldBuild = args.distPath ? false : args.build !== false;

  let buildResult: Record<string, unknown> | null = null;
  if (shouldBuild) {
    const raw = await build.handler({ projectPath: args.projectPath, browser });
    try {
      buildResult = JSON.parse(raw);
    } catch {
      buildResult = { success: false, raw };
    }
    if (!buildResult || buildResult.success !== true) {
      return JSON.stringify({
        ok: false,
        stage: "build",
        error:
          "The build failed, so there is nothing to preview. See buildResult for the cause.",
        buildResult,
      });
    }
  }

  const distDir = args.distPath
    ? path.resolve(args.distPath)
    : path.resolve(args.projectPath, "dist", browser);
  const manifestPath = path.join(distDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    return JSON.stringify({
      ok: false,
      stage: "resolve-dist",
      distDir,
      error: `No manifest.json in ${distDir}. Build the project first (build:true), or pass distPath to an already-built directory.`,
    });
  }

  let manifest: Record<string, any> = {};
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (err) {
    return JSON.stringify({
      ok: false,
      stage: "resolve-dist",
      distDir,
      error: `manifest.json in ${distDir} is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }

  const encoded = Buffer.from(distDir).toString("base64url");
  const internalUrl = surface.scheme(encoded);
  const deepLink = `${hostBase}/?url=${encodeURIComponent(internalUrl)}`;

  const result: Record<string, unknown> = {
    ok: true,
    deepLink,
    surface: surfaceKey,
    distDir,
    manifest: {
      name: manifest.name ?? path.basename(distDir),
      version: manifest.version ?? "0.0.0",
      manifestVersion: manifest.manifest_version === 2 ? 2 : 3,
    },
    surfaces: detectSurfaces(manifest),
    ...(buildResult ? { built: true } : { built: false }),
    hint: `Open deepLink in a browser to see the extension render in ${surface.label}'s emulator. It must be running (${surface.devCommand}).${
      surfaceKey === "preview"
        ? " Once it renders, the Trace tab shows every chrome.* call it makes, and the lane toggle switches between the emulated backend and a real carrier-equipped browser."
        : ""
    }`,
  };

  if (args.open) {
    const sessionBrowser = args.openIn ?? browser;
    const navRaw = await navigateToUrl(args.projectPath, sessionBrowser, deepLink);
    let opened: Record<string, unknown>;
    try {
      opened = JSON.parse(navRaw);
    } catch {
      opened = { ok: false, raw: navRaw };
    }
    result.opened = opened;
    result.openedIn = sessionBrowser;
    if (opened.ok !== true) {
      result.openHint =
        "Could not open the preview in a browser. This needs a live dev session (run extension_dev, then extension_wait for ready). The deepLink above still works if you open it yourself.";
    }
  }

  if (args.share) {
    result.share = await buildShare(
      args.projectPath,
      distDir,
      manifest,
      browser,
    );
  }

  if (args.probe === false) {
    return JSON.stringify(result);
  }

  const probeUrl = `${hostBase}${surface.fetchPath}?url=${encodeURIComponent(
    internalUrl,
  )}`;
  try {
    const res = await fetch(probeUrl, {
      headers: { accept: "application/json" },
    });
    const contentType = res.headers.get("content-type") ?? "";
    if (!res.ok || !contentType.includes("application/json")) {
      return JSON.stringify({
        ...result,
        hostReachable: true,
        previewLoadable: false,
        probe: {
          status: res.status,
          contentType,
          note: `${surface.label} answered but not with a preview payload. On the deployed host ${surface.fetchPath} does not exist (dev-only); run a local dev server (${surface.devCommand}) to use web preview.`,
        },
      });
    }
    const payload = (await res.json()) as {
      identifier?: string;
      version?: string;
      manifest?: { name?: string };
      files?: unknown[];
    };
    return JSON.stringify({
      ...result,
      hostReachable: true,
      previewLoadable: true,
      probe: {
        identifier: payload.identifier,
        loadedName: payload.manifest?.name,
        loadedVersion: payload.version,
        fileCount: Array.isArray(payload.files) ? payload.files.length : 0,
      },
    });
  } catch (err) {
    return JSON.stringify({
      ...result,
      hostReachable: false,
      previewLoadable: false,
      probe: {
        error: err instanceof Error ? err.message : String(err),
        note: `Could not reach ${surface.label} at ${hostBase}. Start it with '${surface.devCommand}', then open deepLink.`,
      },
    });
  }
}
