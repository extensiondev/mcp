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
import { ZIP_URL_REDIRECT_NOTE } from "../lib/artifacts-api";
import { uploadPreview } from "../lib/preview-upload";
import { recordSharedPreview } from "../lib/share-record";
import { probeShareCors } from "../lib/share-cors-probe";
import { envelope } from "../lib/envelope";
import {
  PLATFORM_HOLD_CODE,
  PLATFORM_HOLD_STILL_WORKS,
  templatesOrigin,
} from "../lib/platform-hold";

const COMMAND = "extension_preview_web";


const DEFAULT_PREVIEW_DEV_URL = "http://localhost:3110";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/* @invariant
 * hostUrl names a preview server, not an arbitrary place to send things.
 *
 * This is a tool argument, so a model can be steered into supplying it by
 * anything it reads. Three things go to whatever it names: the base64url of an
 * absolute local build path, a deepLink the hint then tells the user to open,
 * and with open:true a real navigation of the author's session browser. What
 * comes back is worse, because identifier, loadedName and loadedVersion are
 * echoed into the tool envelope the model reads next, which makes an arbitrary
 * host a text channel into the agent's context. A preview dev server is always
 * local, so requiring that costs nothing real.
 */
function safeHostBase(
  raw: string,
): { ok: true; base: string } | { ok: false; message: string } {
  const trimmed = String(raw || "").replace(/\/+$/, "");
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

/* @invariant
 * The probe certifies the artifact this call minted, never the port.
 *
 * Anything can be listening on the probed local port: this repo's own dev
 * fleet serves 3110 when preview's server is down, and hostReachable and
 * previewLoadable read true off whatever JSON it happened to answer. Worse,
 * the strings that JSON carried (identifier, loadedName, loadedVersion) were
 * echoed into the tool envelope the model reads next, unmarked, which makes
 * any local server a text channel into the agent's context. So the payload is
 * only certified when it describes the minted build: name and version must
 * match the dist manifest read off disk, and the identifier is echoed only
 * when it equals the derivation the real middleware uses (local-<slug of the
 * manifest name>). Everything the host claimed that could not be confirmed
 * locally travels clipped under probe.hostReported, named as the host's own
 * claim, or not at all.
 */
const HOST_CLAIM_MAX_CHARS = 120;

function clipHostClaim(value: string): string {
  return value.length > HOST_CLAIM_MAX_CHARS
    ? value.slice(0, HOST_CLAIM_MAX_CHARS)
    : value;
}

function expectedPreviewIdentifier(
  name: string | null,
  distDir: string,
): string {
  const base =
    (name ?? path.basename(distDir))
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "extension";
  return base.startsWith("local-") ? base : `local-${base}`;
}

const SURFACE = {
  defaultOrigin: DEFAULT_PREVIEW_DEV_URL,
  scheme: (encoded: string) => `preview://build/${encoded}`,
  fetchPath: "/__preview/fetch",
  devCommand: "pnpm --filter preview.extension.dev dev",
  label: "preview.extension.dev",
} as const;

const PREVIEW_APP_LOCATIONS = [
  ["apps", "web", "preview.extension.dev"],
  ["apps", "preview.extension.dev"],
  ["preview.extension.dev"],
];

/* @invariant
 * The pnpm command is only ever printed to someone who could run it.
 *
 * preview.extension.dev is a private app of the extension.dev monorepo, so
 * `pnpm --filter preview.extension.dev dev` is unrunnable for everyone who
 * installed @extension.dev/mcp from npm. Printing it as the remedy sent that
 * majority down a road with no end, and an agent relaying it burns a turn
 * proving the filter matches nothing. Finding the app's own package.json is
 * the only honest evidence that the command exists here, so the remedy for
 * everyone else names share:true instead, which needs no local server at all.
 */
function previewDevCheckout(startPaths: string[]): string | null {
  const seen = new Set<string>();
  for (const start of startPaths) {
    let dir: string;
    try {
      dir = path.resolve(start);
    } catch {
      continue;
    }
    for (let depth = 0; depth < 8; depth++) {
      if (seen.has(dir)) break;
      seen.add(dir);
      for (const location of PREVIEW_APP_LOCATIONS) {
        const manifest = path.join(dir, ...location, "package.json");
        try {
          const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as {
            name?: string;
          };
          if (parsed.name === SURFACE.label) return dir;
        } catch {
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

function localLaneRemedy(checkout: string | null): string {
  const shareOut =
    "Pass share:true for a link that needs no local server and opens for anyone.";
  return checkout
    ? `Start it with '${SURFACE.devCommand}' in ${checkout}. ${shareOut}`
    : `${SURFACE.label} is a private app of the extension.dev monorepo and no npm install of this server can start it, so the default lane cannot resolve on this machine. ${shareOut}`;
}

function previewOriginOf(previewUrl: string): string | null {
  try {
    return new URL(previewUrl).origin;
  } catch {
    return null;
  }
}

async function buildShare(
  projectPath: string,
  distDir: string,
  manifest: Record<string, any>,
  browser: string,
  verifyInBrowserTerms: boolean,
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
            loginHint:
              "Run extension_auth (action: login), or set EXTENSION_DEV_TOKEN (create one in the extension.dev dashboard).",
          }
        : {}),
    };
  }

  const origin = previewOriginOf(result.data.previewUrl);
  const browserCheck =
    verifyInBrowserTerms && result.data.zipUrl && origin
      ? await probeShareCors({ zipUrl: result.data.zipUrl, origin })
      : null;

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
    ...(browserCheck
      ? browserCheck.held
        ? { browserLoadable: null, heldFromPublic: true, browserCheck }
        : { browserLoadable: browserCheck.ok, browserCheck }
      : { browserLoadable: null }),
    record,
    note:
      "Anyone with this link can open the build you just made, running in the emulator. No install, no sign-in, no dev server. They can also download the whole build as a zip from zipUrl, so the link hands over the built code. It stays live until expiresAt; DELETE revokeUrl with the same token to kill it sooner, and a revoked link stays dead. revokeUrl is the handle that pulls this link early. Re-sharing an unchanged build returns this same link rather than a second one, and only a revoked link is replaced by a different one, so " +
      (record.recorded
        ? `it was also written to ${record.path} (record.path), which lists every share from this project.`
        : `keep it: ${record.note}`) +
      " To find this link again later, or to pull it back once it has left this conversation, run extension_shares: it lists every link this token has shared with its live or dead state, and revokes one by artifactId or by pasting any of its URLs." +
      (result.data.zipUrl ? ` ${ZIP_URL_REDIRECT_NOTE}` : "") +
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
    "Preview an in-progress extension in the web emulator, with no real browser. This builds the project (unless build:false) and previews dist/<browser>. Pass share:true unless you are working inside the extension.dev monorepo: it uploads the build and returns a link anyone can open, with no install, sign-in or dev server, and it is the only lane that works from an npm install of this server. Sharing also serves the build as a zip, so it hands over the built code; read the share property before using it. The default lane instead returns a deep link over the dev-only preview://build scheme, which resolves only against a preview.extension.dev dev server on this machine, so it is for people developing extension.dev itself. Call extension_shares to list and revoke every link shared this way, so one never vanishes with this response.",
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
          "Fetch the surface's dev middleware first to confirm the artifact loads on the local host. With share:true it also checks the shared link the way a browser would, following the zip's redirects and asserting the final response allows the preview origin, and reports that as share.browserLoadable.",
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
          "Upload the built dist and return a public link (share.previewUrl) that renders those exact bytes for anyone: no install, sign-in or dev server. It also serves the build as a zip (share.zipUrl), so sharing hands over the code. Needs a token scoped to an extension.dev project (extension_auth or EXTENSION_DEV_TOKEN); without one you get a login hint and the local preview still succeeds. Live until share.expiresAt; DELETE share.revokeUrl to kill it sooner. Revocation is permanent, and re-sharing an unchanged build returns the same link unless it was revoked, so each share is also appended to the project's gitignored .extension.dev/shared-previews.json.",
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
  const hostBase = host.base;
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
  const checkout = previewDevCheckout([args.projectPath, process.cwd()]);
  const remedy = localLaneRemedy(checkout);
  const hint = `Open deepLink in a browser to see the extension render in ${SURFACE.label}'s emulator, where the Trace tab shows every chrome.* call it makes and the lane toggle switches between the emulated backend and a real carrier-equipped browser. It needs that surface's dev server running on this machine. ${remedy}`;
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
    const share = await buildShare(
      args.projectPath,
      distDir,
      manifest,
      browser,
      args.probe !== false,
    );
    result.share = share;
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
      remoteIdentifier !== null &&
      remoteIdentifier === expectedPreviewIdentifier(localName, distDir);
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
        previewLoadable: true,
        /* @invariant
         * previewLoadable says what this probe proved, and no more.
         *
         * It is a server-side fetch of a dev-only middleware on this machine,
         * so it proves the local host parsed the build; it cannot see a CORS
         * refusal, because a server does not enforce one. It sat one key away
         * from share.previewUrl in the same envelope, and readers took it as a
         * verdict on the shared link, which it never was: that link is read
         * cross-origin by a browser, and only share.browserCheck asks that
         * question. Naming the lane keeps the two apart.
         */
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
    /* @invariant
     * Nothing rendered, so this is not a success.
     *
     * ok:true here reported "previewed" for a run where the host never
     * answered and the link cannot open. Callers branch on ok before they read
     * status, so an agent would relay a deep link as though it worked, and the
     * remedy it then offers is a dev server the caller may not even have.
     *
     * The share lane is the one exception, in the other direction. With
     * share:true the thing the caller asked for is the uploaded link, and on
     * any machine outside the monorepo the local dev host is expected to be
     * absent; failing the whole envelope over that leg reported a working
     * share as a failure. When the share succeeded, the local lane's absence
     * is a warning on a success, not a verdict.
     */
    const shared = result.share as { ok?: unknown } | undefined;
    if (args.share && shared?.ok === true) {
      return envelope({
        ok: true,
        command: COMMAND,
        status: "shared",
        value: {
          ...result,
          hostReachable: false,
          previewLoadable: false,
          probe: {
            error: err instanceof Error ? err.message : String(err),
          },
        },
        hint: "share.previewUrl is live and needs no local server. The deepLink lane is separate: it only resolves against a preview.extension.dev dev server on this machine, and none answered.",
        warnings: [
          ...previewWarnings,
          `The share link works; only the local ${SURFACE.label} dev lane at ${hostBase} is unreachable, which is expected outside the extension.dev monorepo.`,
        ],
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
