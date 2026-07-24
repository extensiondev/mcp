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

// Web preview renders the extension inside the mocked-Chrome emulator instead
// of launching a real browser. The emulator already loads store URLs, dropped
// artifacts, and dev fixtures through one pipeline; this tool hands it an
// in-progress build over the dev-only preview://build scheme, which reads the
// dist directory straight off disk (no upload, no staging copy). The tool emits
// the deep link a human/agent opens, and probes the same middleware the browser
// will hit so a caller learns whether the artifact is loadable without opening
// anything.
//
// SHAREABLE PREVIEW (share:true) UPLOADS THE LOCAL DIST. It POSTs the directory
// just built to /api/artifacts with kind:"dist" and the project bearer token,
// and returns the preview.extension.dev link that renders those exact bytes.
//
// Read this before changing the share path, because the obvious alternative is
// wrong: /api/cli/publish (what extension_publish calls) takes no projectPath
// and uploads nothing. It flips a share link on whatever build the token's
// project last published from its own CI. Routing share through it, as this
// tool used to, means the link renders a DIFFERENT build than the one on the
// developer's disk, which is the opposite of what "share my preview" means.
// The two rails coexist on purpose:
//   * share here          -> the bytes you just built, ephemeral, revocable
//   * extension_publish   -> the project's released CI build, channel-scoped

const DEFAULT_INSPECT_URL = "http://localhost:3106";
const DEFAULT_PREVIEW_DEV_URL = "http://localhost:3110";

// Which front door renders the build. preview.extension.dev is the author's
// door (preview YOUR in-progress build) and is therefore the default for this
// tool; inspect.extension.dev is the evaluator's door (examine someone else's
// shipped extension) and stays reachable for the fixture/forensic lane. Both
// run the same emulator engine, so only the origin, the internal scheme and
// the dev middleware path differ.
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

/**
 * Upload the dist that was just built and return the link that renders it.
 * Never throws: a failure here surfaces inside `share` so the local deep link
 * the caller already earned is still returned.
 */
async function buildShare(
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
      // Distinguish "you are not logged in" (fixable in one step, and the
      // common case) from "the upload itself failed".
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

  return {
    requested: true,
    ok: true,
    previewUrl: result.data.previewUrl,
    artifactId: result.data.artifactId,
    ...(result.data.expiresAt ? { expiresAt: result.data.expiresAt } : {}),
    ...(result.data.zipUrl ? { zipUrl: result.data.zipUrl } : {}),
    ...(result.data.revokeUrl ? { revokeUrl: result.data.revokeUrl } : {}),
    // The claim the old implementation could not make. Stated positively so a
    // caller can rely on it rather than having to read a caveat.
    serves: "uploaded-local-build",
    localBuildUploaded: true,
    note: "Anyone with this link can open the build you just made, running in the emulator. No install, no sign-in, no dev server. The link expires (see expiresAt); DELETE revokeUrl with the same token to kill it sooner.",
  };
}

// Mirror of inspect's own surface detection (runtime-fixture-utils.detectSurfaces)
// so the tool can report what the previewed artifact will render.
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
    "Preview an in-progress extension in the web emulator (no real browser). Builds the project (unless build:false), points preview.extension.dev at the dist directory over the dev-only preview://build scheme, and returns a deep link plus a loadability check against its dev server. preview is the author's front door: it renders YOUR build and carries the Emulated/Real lane toggle and the Trace tab. Pass surface:\"inspect\" to render in inspect.extension.dev instead (the evaluator's door, for fixture and forensic work). Pass share:true to UPLOAD the dist you just built and get back a link (share.previewUrl) that renders those exact bytes for anyone who opens it, with no install and no dev server; that needs auth (extension_login or EXTENSION_DEV_TOKEN). Use share:true whenever the build has to reach someone who is not at this machine, since the plain deepLink only resolves locally.",
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
          "Upload the built dist and return a shareable link (share.previewUrl) that renders those exact bytes in the emulator for anyone who opens it. Requires auth (extension_login or EXTENSION_DEV_TOKEN); degrades gracefully with a login hint when not authenticated, and never fails the local preview. The link expires (share.expiresAt) and can be revoked early by DELETEing share.revokeUrl with the same token.",
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
  // inspectUrl predates the preview surface, so it only speaks for inspect.
  const hostBase = (
    args.hostUrl ??
    (surfaceKey === "inspect" ? args.inspectUrl : undefined) ??
    surface.defaultOrigin
  ).replace(/\/+$/, "");
  // An explicit distPath is authoritative: the caller already has the artifact,
  // so building would only overwrite it.
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

  // base64url keeps the absolute path a single clean URL segment; the surface's
  // dev middleware decodes it and reads the dist off disk.
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

  // Focus-safe auto-open: drive a running dev session's browser to the deep
  // link in a NEW BACKGROUND tab (reuses extension_open's CDP path, which never
  // steals the foreground/keyboard). This is the same move extension_open makes
  // for inspect's trace lane (?session=live), applied to the preview lane. It
  // needs a live session; without one the deep link is still returned to open
  // by hand.
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

  // Shareable preview: additive, opt-in, and uploads the dist resolved above,
  // so the link renders the same bytes the local deepLink does. Attached to the
  // local result so every return path below (probe on/off) carries it. Never
  // fails the local preview: an upload error surfaces inside share, not as the
  // tool's verdict.
  if (args.share) {
    result.share = await buildShare(distDir, manifest, browser);
  }

  if (args.probe === false) {
    return JSON.stringify(result);
  }

  // Probe the exact middleware the browser will hit. A JSON payload with a
  // manifest is proof the surface resolved and seeded the artifact; a
  // connection refusal means the dev server is not up.
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
