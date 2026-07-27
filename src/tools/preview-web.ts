// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { PROJECT_PATH, REAL_BROWSERS } from "../lib/common-schema";
import fs from "node:fs";
import path from "node:path";
import * as build from "./build";
import { navigateToUrl } from "./open";
import { uploadPreview } from "../lib/preview-upload";
import { recordSharedPreview } from "../lib/share-record";
import { envelope } from "../lib/envelope";

const COMMAND = "extension_preview_web";


const DEFAULT_PREVIEW_DEV_URL = "http://localhost:3110";

const SURFACE = {
  defaultOrigin: DEFAULT_PREVIEW_DEV_URL,
  scheme: (encoded: string) => `preview://build/${encoded}`,
  fetchPath: "/__preview/fetch",
  devCommand: "pnpm --filter preview.extension.dev dev",
  label: "preview.extension.dev",
} as const;

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
              "Run extension_auth (action: login), or set EXTENSION_DEV_TOKEN (create one in the extension.dev dashboard).",
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
    "Preview an in-progress extension in the web emulator, with no real browser. This builds the project (unless build:false), points preview.extension.dev at dist/<browser> over the dev-only preview://build scheme, and returns a deep link plus a loadability check. Use it as the author's door for a local build: it renders your build and carries the Emulated/Real lane toggle and the Trace tab, but the deep link resolves only on this machine. Pass share:true to get a public link that reaches anyone. Call extension_shares to list and revoke every link shared this way, so one never vanishes with this response.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: PROJECT_PATH,
      browser: {
        type: "string",
        enum: REAL_BROWSERS,
        default: "chrome",
        description:
          "Which dist/<browser> output to preview. The emulator renders it as mocked Chrome either way.",
      },
      build: {
        type: "boolean",
        default: true,
        description:
          "Build first. false previews the existing dist/<browser> as-is.",
      },
      distPath: {
        type: "string",
        description:
          "Preview this built directory instead of dist/<browser> under projectPath. Implies build:false.",
      },
      hostUrl: {
        type: "string",
        description:
          "Origin of the running preview.extension.dev dev server (default http://localhost:3110).",
      },
      probe: {
        type: "boolean",
        default: true,
        description:
          "Fetch the surface's dev middleware first to confirm the artifact loads.",
      },
      open: {
        type: "boolean",
        default: false,
        description:
          "Also open the deep link in a running session's browser, in a focus-safe background tab. Needs a live extension_dev/extension_start session.",
      },
      openIn: {
        type: "string",
        enum: REAL_BROWSERS,
        description:
          "Which session's browser to open it in. Defaults to `browser`.",
      },
      share: {
        type: "boolean",
        default: false,
        description:
          "Upload the built dist and return a public link (share.previewUrl) that renders those exact bytes for anyone: no install, sign-in or dev server. It also serves the build as a zip (share.zipUrl), so sharing hands over the code. Needs a token scoped to an extension.dev project (extension_auth or EXTENSION_DEV_TOKEN); without one you get a login hint and the local preview still succeeds. Live until share.expiresAt; DELETE share.revokeUrl to kill it sooner. Revocation is permanent and re-sharing mints a different link, so each share is also appended to the project's gitignored .extension.dev/shared-previews.json.",
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
  hostUrl?: string;
  probe?: boolean;
  open?: boolean;
  openIn?: string;
  share?: boolean;
}): Promise<string> {
  const browser = args.browser ?? "chrome";
  const hostBase = (args.hostUrl ?? SURFACE.defaultOrigin).replace(/\/+$/, "");
  const shouldBuild = args.distPath ? false : args.build !== false;

  let buildResult: Record<string, unknown> | null = null;
  if (shouldBuild) {
    const raw = await build.handler({ projectPath: args.projectPath, browser });
    try {
      buildResult = JSON.parse(raw);
    } catch {
      buildResult = { ok: false, raw };
    }
    if (!buildResult || buildResult.ok !== true) {
      return envelope({
        ok: false,
        command: COMMAND,
        status: "build-failed",
        error: {
          code: "E_BUILD_FAILED",
          message:
            "The build failed, so there is nothing to preview. See buildResult for the cause.",
        },
        value: { stage: "build", buildResult },
      });
    }
  }

  const distDir = args.distPath
    ? path.resolve(args.distPath)
    : path.resolve(args.projectPath, "dist", browser);
  const manifestPath = path.join(distDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    return envelope({
      ok: false,
      command: COMMAND,
      status: "no-dist",
      error: {
        code: "E_NO_DIST",
        message: `No manifest.json in ${distDir}. Build the project first (build:true), or pass distPath to an already-built directory.`,
      },
      value: { stage: "resolve-dist", distDir },
    });
  }

  let manifest: Record<string, any> = {};
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (err) {
    return envelope({
      ok: false,
      command: COMMAND,
      status: "bad-dist-manifest",
      error: {
        code: "E_BAD_MANIFEST",
        message: `manifest.json in ${distDir} is not valid JSON: ${
          err instanceof Error ? err.message : String(err)
        }`,
      },
      value: { stage: "resolve-dist", distDir },
    });
  }

  const encoded = Buffer.from(distDir).toString("base64url");
  const internalUrl = SURFACE.scheme(encoded);
  const deepLink = `${hostBase}/?url=${encodeURIComponent(internalUrl)}`;

  const result: Record<string, unknown> = {
    deepLink,
    distDir,
    manifest: {
      name: manifest.name ?? path.basename(distDir),
      version: manifest.version ?? "0.0.0",
      manifestVersion: manifest.manifest_version === 2 ? 2 : 3,
    },
    surfaces: detectSurfaces(manifest),
    ...(buildResult ? { built: true } : { built: false }),
  };
  const hint = `Open deepLink in a browser to see the extension render in ${SURFACE.label}'s emulator. It must be running (${SURFACE.devCommand}). Once it renders, the Trace tab shows every chrome.* call it makes, and the lane toggle switches between the emulated backend and a real carrier-equipped browser.`;
  const previewWarnings: string[] = [];

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
      previewWarnings.push(
        "Could not open the preview in a browser. This needs a live dev session (run extension_dev, then extension_wait for ready). The deepLink above still works if you open it yourself.",
      );
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
    return envelope({
      ok: true,
      command: COMMAND,
      status: "previewed",
      value: result,
      hint,
      warnings: previewWarnings,
    });
  }

  const probeUrl = `${hostBase}${SURFACE.fetchPath}?url=${encodeURIComponent(
    internalUrl,
  )}`;
  try {
    const res = await fetch(probeUrl, {
      headers: { accept: "application/json" },
    });
    const contentType = res.headers.get("content-type") ?? "";
    if (!res.ok || !contentType.includes("application/json")) {
      return envelope({
        ok: true,
        command: COMMAND,
        status: "host-not-serving-preview",
        value: {
          ...result,
          hostReachable: true,
          previewLoadable: false,
          probe: {
            status: res.status,
            contentType,
          },
        },
        hint,
        warnings: [
          ...previewWarnings,
          `${SURFACE.label} answered but not with a preview payload. On the deployed host ${SURFACE.fetchPath} does not exist (dev-only); run a local dev server (${SURFACE.devCommand}) to use web preview.`,
        ],
      });
    }
    const payload = (await res.json()) as {
      identifier?: string;
      version?: string;
      manifest?: { name?: string };
      files?: unknown[];
    };
    return envelope({
      ok: true,
      command: COMMAND,
      status: "previewed",
      value: {
        ...result,
        hostReachable: true,
        previewLoadable: true,
        probe: {
          identifier: payload.identifier,
          loadedName: payload.manifest?.name,
          loadedVersion: payload.version,
          fileCount: Array.isArray(payload.files) ? payload.files.length : 0,
        },
      },
      hint,
      warnings: previewWarnings,
    });
  } catch (err) {
    /* @invariant
     * Nothing rendered, so this is not a success.
     *
     * ok:true here reported "previewed" for a run where the host never
     * answered and the link cannot open. Callers branch on ok before they read
     * status, so an agent would relay a deep link as though it worked, and the
     * remedy it then offers is a dev server the caller may not even have.
     */
    return envelope({
      ok: false,
      command: COMMAND,
      status: "host-unreachable",
      error: {
        code: "E_PREVIEW_HOST_UNREACHABLE",
        message: `Nothing is serving ${SURFACE.label} at ${hostBase}, so deepLink has nothing to open. Pass share:true to get a link that needs no local server, or start the dev server if you are working inside the extension.dev monorepo.`,
      },
      value: {
        ...result,
        hostReachable: false,
        previewLoadable: false,
        probe: {
          error: err instanceof Error ? err.message : String(err),
        },
      },
      hint,
      warnings: [
        ...previewWarnings,
        `Could not reach ${SURFACE.label} at ${hostBase}. Start it with '${SURFACE.devCommand}', then open deepLink.`,
      ],
    });
  }
}
