// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import path from "node:path";

import { PREVIEW_SURFACES, previewLocalPath, previewSharePath, type PreviewLinkOptions } from "@extension.dev/urls/paths";

import { isGeckoFamily } from "../lib/browser-family";
import { PROJECT_PATH, REAL_BROWSERS } from "../lib/common-schema";
import { ZIP_URL_REDIRECT_NOTE } from "../lib/artifacts-api";
import { resolveCredential } from "../lib/credential-source";
import { LOGIN_STEPS, PROJECT_TOKEN_INPUT } from "../lib/credentials";
import { spendNarration, ALLOWANCE_PHRASE  } from "../lib/allowance";
import { probeShareCors } from "../lib/share-cors-probe";
import { envelope } from "../lib/envelope";
import {
  PLATFORM_HOLD_CODE,
  PLATFORM_HOLD_STILL_WORKS,
  templatesOrigin,
} from "../lib/platform-hold";
import { PREVIEW_WEB_LOCAL } from "./preview-web-local";
import { renderableContentScripts, renderableSurfaces } from "../lib/surface-names";
import { dropTrailing } from "../lib/linear-text";
import { jsonReadFailure } from "../lib/manifest-path";

import type { uploadPreview } from "../lib/preview-upload";
import type { recordSharedPreview } from "../lib/share-record";

export interface PreviewWebLocal {
  build(projectPath: string, browser: string): Promise<string>;
  distDirOf(args: { projectPath: string; distPath?: string }, browser: string): string;
  distOutsideProject(args: { projectPath: string; distPath?: string }): boolean;
  manifestExists(manifestPath: string): boolean;
  readManifest(manifestPath: string): Record<string, any>;
  distPaths(distDir: string): string[];
  devCheckout(projectPath: string, label: string): string | null;
  navigate(projectPath: string, browser: string, url: string): Promise<string>;
  uploadPreview: typeof uploadPreview;
  recordSharedPreview: typeof recordSharedPreview;
}

const COMMAND = "extension_preview_web";

const DEFAULT_PREVIEW_DEV_URL = "http://localhost:3110";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function safeHostBase(
  raw: string,
): { ok: true; base: string } | { ok: false; message: string } {
  const trimmed = dropTrailing(String(raw || ""), "/");
  let parsed: URL;

  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      ok: false,
      message: `hostUrl is not a URL: ${raw}. Leave it unset to use ${DEFAULT_PREVIEW_DEV_URL}.`,
    };
  }

  const isLocal =
    LOCAL_HOSTS.has(parsed.hostname) ||
    parsed.hostname.endsWith(".localhost") ||
    parsed.hostname === "preview.extension.dev";

  if (!isLocal) {
    return {
      ok: false,
      message: `Refusing to use ${raw} as the preview host: hostUrl may only name a local preview dev server. Leave it unset to use ${DEFAULT_PREVIEW_DEV_URL}, or pass share:true for a link that needs no local server.`,
    };
  }

  return { ok: true, base: trimmed };
}

const HOST_CLAIM_MAX_CHARS = 120;

function clipHostClaim(value: string): string {
  return value.length > HOST_CLAIM_MAX_CHARS
    ? value.slice(0, HOST_CLAIM_MAX_CHARS)
    : value;
}

const DEV_SERVER_IDENTIFIER = /^preview-[0-9a-f]{32}$/;

const SURFACE = {
  defaultOrigin: DEFAULT_PREVIEW_DEV_URL,
  scheme: (encoded: string) => `preview://build/${encoded}`,
  fetchPath: "/__preview/fetch",
  devCommand: "pnpm --filter preview.extension.dev dev",
  label: "preview.extension.dev",
} as const;

function localLaneRemedy(checkout: string | null): string {
  const shareOut =
    "Pass share:true for a link that needs no local server and opens for anyone.";

  return checkout
    ? `Start it with '${SURFACE.devCommand}' in ${checkout}. ${shareOut}`
    : `${SURFACE.label} is a private app of the extension.dev monorepo and no npm install of this server can start it, so the default lane cannot resolve on this machine. ${shareOut}`;
}

function unrequestedShare(args: {
  projectPath: string;
  browser?: string;
  build?: boolean;
  distPath?: string;
}): Record<string, unknown> {
  const call: Record<string, unknown> = { projectPath: args.projectPath };
  if (args.browser) call.browser = args.browser;
  if (args.build === false) call.build = false;
  if (args.distPath) call.distPath = args.distPath;

  call.share = true;

  return {
    requested: false,
    localLinkNeeds: `deepLink renders only against a ${SURFACE.label} dev server running on this machine, so to anyone else it is a dead link.`,
    shareSpends:
      `share:true uploads this build to extension.dev, which ${ALLOWANCE_PHRASE}, which is why it is off by default.`,
    shareCall: `extension_preview_web ${JSON.stringify(call)}`,
  };
}

function previewLinkOptions(
  browser: string,
  surface: string | undefined,
): { ok: true; options: PreviewLinkOptions } | { ok: false; message: string } {
  const options: PreviewLinkOptions = {
    engine: isGeckoFamily(browser) ? "firefox" : "chromium",
    ...(surface === undefined ? {} : { surface }),
  };

  try {
    previewLocalPath("", options);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }

  return { ok: true, options };
}

function sharedPreviewUrl(previewUrl: string, artifactId: string, options: PreviewLinkOptions): string {
  const origin = previewOriginOf(previewUrl);

  return origin ? `${origin}${previewSharePath(artifactId, options)}` : previewUrl;
}

function previewOriginOf(previewUrl: string): string | null {
  try {
    return new URL(previewUrl).origin;
  } catch {
    return null;
  }
}

async function buildShare(
  local: PreviewWebLocal,
  projectPath: string,
  distDir: string,
  manifest: Record<string, any>,
  browser: string,
  verifyInBrowserTerms: boolean,
  linkOptions: PreviewLinkOptions,
  project?: string,
): Promise<Record<string, unknown>> {
  const credential = resolveCredential({ ...(project ? { project } : {}) });
  const result = await local.uploadPreview({
    distDir,
    manifest,
    browser,
    ...(project ? { token: credential.token } : {}),
    ref: credential.ref,
  });

  if (!result.ok) {
    const isAuth = result.error.name === "PreviewAuthError";

    return {
      requested: true,
      ok: false,
      supported: !isAuth,
      errorName: result.error.name,
      reason: result.error.message,
      ...(result.held
        ? {
            held: true,
            platformCode: PLATFORM_HOLD_CODE,
            stillWorks: PLATFORM_HOLD_STILL_WORKS,
            openSurface: templatesOrigin(),
          }
        : {}),
      ...(isAuth
        ? {
            loginHint: LOGIN_STEPS,
          }
        : {}),
    };
  }

  const previewUrl = sharedPreviewUrl(result.data.previewUrl, result.data.artifactId, linkOptions);
  const origin = previewOriginOf(previewUrl);
  const browserCheck =
    verifyInBrowserTerms && result.data.zipUrl && origin
      ? await probeShareCors({ zipUrl: result.data.zipUrl, origin })
      : null;

  const sharedAt = new Date().toISOString();
  const sharedAtFrom = "this machine's clock at the moment the platform answered, not the platform's record";
  const record = local.recordSharedPreview(projectPath, {
    sharedAt,
    previewUrl,
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
    previewUrl,
    artifactId: result.data.artifactId,
    sharedAt,
    ...(result.data.expiresAt ? { expiresAt: result.data.expiresAt } : {}),
    ...(result.data.zipUrl ? { zipUrl: result.data.zipUrl } : {}),
    ...(result.data.revokeUrl ? { revokeUrl: result.data.revokeUrl } : {}),
    serves: "uploaded-local-build",
    localBuildUploaded: true,
    leftOut: result.data.leftOut,
    allowance: spendNarration({ what: "This share upload", body: result.body }),
    sharedAtFrom,
    ...(browserCheck
      ? browserCheck.held
        ? { browserLoadable: null, heldFromPublic: true, browserCheck }
        : { browserLoadable: browserCheck.ok, browserCheck }
      : { browserLoadable: null }),
    record,
    note:
      `Anyone with this link can open the build you just made, running in the emulator. No install, no sign-in, no dev server. They can also download the whole build as a zip from zipUrl, so the link hands over the built code. It stays live until expiresAt; DELETE revokeUrl with the same token to kill it sooner, and a revoked link stays dead. revokeUrl is the handle that pulls this link early. Re-sharing an unchanged build returns this same link rather than a second one, and only a revoked link is replaced by a different one, so ${ 
      record.recorded
        ? `it was also written to ${record.path} (record.path), which lists every share from this project.`
        : `keep it: ${record.note}` 
      } To find this link again later, or to pull it back once it has left this conversation, run extension_shares_read: it lists every link this token has shared with its live or dead state, and extension_shares_manage revokes one by artifactId or by pasting any of its URLs.${ 
      result.data.zipUrl ? ` ${ZIP_URL_REDIRECT_NOTE}` : "" 
      }${record.warning ? ` ${record.warning}` : ""}${leftOutNote(result.data.leftOut.secrets)}`,
  };
}

function leftOutNote(secrets: string[]): string {
  if (secrets.length === 0) return "";

  return ` ${secrets.length === 1 ? "One credential file stayed" : `${secrets.length} credential files stayed`} on this machine and are not in the link: ${secrets.join(", ")} (leftOut.secrets).`;
}

export const schema = {
  name: "extension_preview_web",
  description:
    "Preview a build in the web emulator; share:true returns a link that needs no install. Answers share.previewUrl; extension_publish answers a tester link with downloads, extension_shares_read lists, extension_shares_manage revokes. Content scripts run only on sample pages, a limit of the preview only. The preview://build default is for developing extension.dev itself.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: PROJECT_PATH,
      project: PROJECT_TOKEN_INPUT,
      browser: {
        type: "string",
        enum: REAL_BROWSERS,
        default: "chrome",
        description:
          "dist/<browser> to preview; Firefox view for Firefox.",
      },
      build: {
        type: "boolean",
        default: true,
        description:
          "Build first.",
      },
      distPath: {
        type: "string",
        description:
          "Preview this directory; implies build:false.",
      },
      hostUrl: {
        type: "string",
        description:
          "Local preview server origin.",
      },
      probe: {
        type: "boolean",
        default: true,
        description:
          "Check the artifact loads.",
      },
      open: {
        type: "boolean",
        default: false,
        description:
          "Also open it in a live session.",
      },
      openIn: {
        type: "string",
        enum: REAL_BROWSERS,
        description:
          "Session browser to open in.",
      },
      surface: {
        type: "string",
        description: `Page the link opens on: ${PREVIEW_SURFACES.join(", ")}.`,
      },
      share: {
        type: "boolean",
        default: false,
        description:
          "Upload for share.previewUrl; metered against the workspace's allowance, and hands over the code.",
      },
    },
    required: ["projectPath"],
  },
};

interface PreviewWebArgs {
  projectPath: string;
  browser?: string;
  build?: boolean;
  distPath?: string;
  hostUrl?: string;
  probe?: boolean;
  open?: boolean;
  openIn?: string;
  share?: boolean;
  surface?: string;
  project?: string;
}

export async function handler(args: PreviewWebArgs): Promise<string> {
  return previewWebWith(args, PREVIEW_WEB_LOCAL);
}

export async function previewWebWith(args: PreviewWebArgs, local: PreviewWebLocal): Promise<string> {
  const browser = args.browser ?? "chrome";
  const host = safeHostBase(args.hostUrl ?? SURFACE.defaultOrigin);

  if (!host.ok) {
    return envelope({
      ok: false,
      command: COMMAND,
      status: "bad-host-url",
      error: { code: "E_BAD_HOST_URL", message: host.message },
      value: { stage: "resolve-host", hostUrl: args.hostUrl },
    });
  }

  const links = previewLinkOptions(browser, args.surface);

  if (!links.ok) {
    return envelope({
      ok: false,
      command: COMMAND,
      status: "unknown-surface",
      error: {
        code: "E_BAD_REQUEST",
        message: `${links.message} Nothing was built or uploaded.`,
        hint: "Pass one of those surfaces, or leave surface out for the preview's default page, and call again.",
      },
      value: { stage: "resolve-surface", surface: args.surface },
    });
  }

  if (args.distPath && local.distOutsideProject(args)) {
    return envelope({
      ok: false,
      command: COMMAND,
      status: "dist-path-refused",
      error: {
        code: "E_BAD_REQUEST",
        message: `distPath has to be a folder inside the project at ${args.projectPath} once its links are followed, and ${args.distPath} is not, so nothing was read or uploaded.`,
        hint: "Pass a distPath inside projectPath, or leave distPath out so the project's own dist is previewed, and call again.",
      },
      value: { stage: "resolve-dist" },
    });
  }

  const hostBase = host.base;
  const shouldBuild = args.distPath ? false : args.build !== false;

  let buildResult: Record<string, unknown> | null = null;

  if (shouldBuild) {
    const raw = await local.build(args.projectPath, browser);

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

  const distDir = local.distDirOf(args, browser);
  const manifestPath = path.join(distDir, "manifest.json");

  if (!local.manifestExists(manifestPath)) {
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

  let manifest: Record<string, any>;

  try {
    manifest = local.readManifest(manifestPath);
  } catch (err) {
    return envelope({
      ok: false,
      command: COMMAND,
      status: "bad-dist-manifest",
      error: {
        code: "E_BAD_MANIFEST",
        message: `manifest.json in ${distDir} could not be read: ${jsonReadFailure(err, manifestPath)}`,
      },
      value: { stage: "resolve-dist", distDir },
    });
  }

  const encoded = Buffer.from(distDir).toString("base64url");
  const internalUrl = SURFACE.scheme(encoded);
  const deepLink = `${hostBase}${previewLocalPath(internalUrl, links.options)}`;

  const distPaths = local.distPaths(distDir);
  const contentScripts = renderableContentScripts(manifest, distPaths);
  const result: Record<string, unknown> = {
    deepLink,
    distDir,
    manifest: {
      name: manifest.name ?? path.basename(distDir),
      version: manifest.version ?? "0.0.0",
      manifestVersion: manifest.manifest_version === 2 ? 2 : 3,
    },
    surfaces: renderableSurfaces(manifest, distPaths),
    ...(contentScripts.length ? { contentScripts, contentScriptsNote: "Content scripts mount no surface of their own; the preview runs them on its sample pages, so look for them there." } : {}),
    ...(buildResult ? { built: true } : { built: false }),
  };

  if (!args.share) {
    result.share = unrequestedShare(args);
  }

  const checkout = local.devCheckout(args.projectPath, SURFACE.label);
  const remedy = localLaneRemedy(checkout);
  const hint = `Open deepLink in a browser to see the extension render in ${SURFACE.label}'s emulator, where the Trace tab shows every chrome.* call it makes and the lane toggle switches between the emulated backend and a real carrier-equipped browser. It needs that surface's dev server running on this machine. ${remedy}`;
  const previewWarnings: string[] = [];

  if (args.open) {
    const sessionBrowser = args.openIn ?? browser;
    const navRaw = await local.navigate(args.projectPath, sessionBrowser, deepLink);
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
    const share = await buildShare(
      local,
      args.projectPath,
      distDir,
      manifest,
      browser,
      args.probe !== false,
      links.options,
      args.project,
    );
    result.share = share;

    if (share.ok !== true) {
      previewWarnings.push(
        `share: true was asked for and the upload did NOT produce a share: ${
          (share as { error?: { message?: string } }).error?.message ?? "the platform refused"
        }. There is no public link; the result below is the local preview only.`,
      );
    }

    if (share.ok === true && share.browserLoadable === false) {
      const check = share.browserCheck as { reason?: string } | undefined;
      previewWarnings.push(
        `The link uploaded, but it will not render for anyone: ${
          check?.reason ?? "its zip is not readable from the preview origin."
        } Do not hand this link out as working until that is fixed.`,
      );
    }
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
    let raw: unknown = null;

    if (res.ok && contentType.includes("application/json")) {
      try {
        raw = await res.json();
      } catch {
        raw = null;
      }
    }

    const payload =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as {
            identifier?: unknown;
            version?: unknown;
            manifest?: { name?: unknown } | null;
            files?: unknown;
          })
        : null;

    if (!payload) {
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
          `${SURFACE.label} answered but not with a preview payload. On the deployed host ${SURFACE.fetchPath} does not exist, because it is dev-only. ${remedy}`,
        ],
      });
    }

    const localName = typeof manifest.name === "string" ? manifest.name : null;
    const localVersion =
      typeof manifest.version === "string" ? manifest.version : null;
    const remoteName =
      typeof payload.manifest?.name === "string" ? payload.manifest.name : null;
    const remoteVersion =
      typeof payload.version === "string" ? payload.version : null;
    const remoteIdentifier =
      typeof payload.identifier === "string" ? payload.identifier : null;
    const fileCount = Array.isArray(payload.files) ? payload.files.length : 0;
    const matchesDist =
      (localName === null || remoteName === localName) &&
      (localVersion === null || remoteVersion === localVersion);

    if (!matchesDist) {
      const hostReported = {
        ...(remoteIdentifier !== null
          ? { identifier: clipHostClaim(remoteIdentifier) }
          : {}),
        ...(remoteName !== null ? { name: clipHostClaim(remoteName) } : {}),
        ...(remoteVersion !== null
          ? { version: clipHostClaim(remoteVersion) }
          : {}),
      };

      return envelope({
        ok: true,
        command: COMMAND,
        status: "host-serving-different-artifact",
        value: {
          ...result,
          hostReachable: true,
          previewLoadable: false,
          probe: {
            method: "server-fetch",
            provesBrowserLoad: false,
            matchesDist: false,
            fileCount,
            ...(Object.keys(hostReported).length ? { hostReported } : {}),
          },
        },
        hint,
        warnings: [
          ...previewWarnings,
          `Something answered at ${hostBase}${SURFACE.fetchPath} but described a different artifact than the build this call minted, so previewLoadable stays false. probe.hostReported carries that host's own claims, clipped and unverified, not facts about your build; another local server on this port is the usual cause. ${remedy}`,
        ],
      });
    }

    const identifierConfirmed =
      remoteIdentifier !== null && DEV_SERVER_IDENTIFIER.test(remoteIdentifier);
    const unconfirmed = {
      ...(!identifierConfirmed && remoteIdentifier !== null
        ? { identifier: clipHostClaim(remoteIdentifier) }
        : {}),
      ...(localName === null && remoteName !== null
        ? { name: clipHostClaim(remoteName) }
        : {}),
      ...(localVersion === null && remoteVersion !== null
        ? { version: clipHostClaim(remoteVersion) }
        : {}),
    };

    return envelope({
      ok: true,
      command: COMMAND,
      status: "previewed",
      value: {
        ...result,
        hostReachable: true,
        previewLoadable: fileCount > 0,
        ...(fileCount > 0 ? {} : { previewLoadableNote: "the host answered this build's name and version but listed no files, so nothing is known to render; previewLoadable stays false" }),
        previewLoadableLane: "local-dev-host",
        probe: {
          ...(identifierConfirmed ? { identifier: remoteIdentifier } : {}),
          ...(localName !== null ? { loadedName: localName } : {}),
          ...(localVersion !== null ? { loadedVersion: localVersion } : {}),
          fileCount,
          method: "server-fetch",
          provesBrowserLoad: false,
          matchesDist: true,
          ...(Object.keys(unconfirmed).length
            ? { hostReported: unconfirmed }
            : {}),
        },
      },
      hint,
      warnings: previewWarnings,
    });
  } catch (err) {
    const shared = result.share as
      | { ok?: unknown; browserLoadable?: unknown; heldFromPublic?: unknown; zipUrl?: unknown }
      | undefined;

    if (args.share && shared?.ok === true) {
      const linkWorks =
        shared.browserLoadable === true &&
        shared.heldFromPublic !== true &&
        typeof shared.zipUrl === "string";
      const linkNote =
        shared.browserLoadable === true && shared.heldFromPublic === true
          ? "The share uploaded and its zip answers, but the platform is holding share pages from the public, so the link does not open for strangers yet."
          : shared.browserLoadable === false
            ? "The share uploaded, but the probe could not read its zip the way a browser would, so the link will not render for anyone until that is fixed; see share.loadCheck."
            : shared.browserLoadable === true
              ? `The share link works; only the local ${SURFACE.label} dev lane at ${hostBase} is unreachable, which is expected outside the extension.dev monorepo.`
              : "The share uploaded, but whether its link renders was not checked (no probe verdict).";

      return envelope({
        ok: true,
        command: COMMAND,
        status: linkWorks ? "shared" : "shared-unverified",
        value: {
          ...result,
          hostReachable: false,
          previewLoadable: false,
          probe: {
            error: err instanceof Error ? err.message : String(err),
          },
        },
        hint: linkWorks
          ? "share.previewUrl is live and needs no local server. The deepLink lane is separate: it only resolves against a preview.extension.dev dev server on this machine, and none answered."
          : "share.previewUrl exists but is not confirmed to render; read share.loadCheck before handing the link to anyone. The deepLink lane is separate and needs a local preview.extension.dev dev server, which did not answer.",
        warnings: [...previewWarnings, linkNote],
      });
    }

    return envelope({
      ok: false,
      command: COMMAND,
      status: "host-unreachable",
      error: {
        code: "E_PREVIEW_HOST_UNREACHABLE",
        message: `Nothing is serving ${SURFACE.label} at ${hostBase}, so deepLink has nothing to open. ${remedy}`,
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
        `Could not reach ${SURFACE.label} at ${hostBase}. ${remedy}`,
      ],
    });
  }
}
