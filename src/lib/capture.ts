// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CDPClient } from "./cdp";
import { clientRoots } from "./client-roots";
import { RdpSession } from "./rdp";
import { browserArtifactsDir } from "./session-paths";

export interface CaptureSize {
  width?: number;
  height?: number;
  deviceScaleFactor?: number;
}

export type CaptureOutcome =
  | { ok: true; png: Buffer }
  | { ok: false; message: string; timedOut?: boolean };

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function pngDimensions(png: Buffer): { width: number; height: number } | null {
  if (png.length < 24 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (png.subarray(12, 16).toString("ascii") !== "IHDR") return null;

  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface CssViewport {
  width: number;
  height: number;
}

async function cssViewportOf(cdp: CDPClient, sessionId: string, timeoutMs: number): Promise<CssViewport | null> {
  const metrics = (await cdp.sendCommand("Page.getLayoutMetrics", {}, sessionId, timeoutMs)) as
    | { cssLayoutViewport?: { clientWidth?: number; clientHeight?: number } }
    | undefined;
  const width = metrics?.cssLayoutViewport?.clientWidth ?? 0;
  const height = metrics?.cssLayoutViewport?.clientHeight ?? 0;

  return width > 0 && height > 0 ? { width, height } : null;
}

function needsMeasuring(size: CaptureSize): boolean {
  return Boolean(size.width || size.height || size.deviceScaleFactor) && (!size.width || !size.height);
}

async function measureCssViewport(port: number, targetId: string, timeoutMs: number): Promise<CssViewport | null> {
  const cdp = new CDPClient();

  try {
    await cdp.connect(await CDPClient.discoverBrowserWsUrl(port));
    const sessionId = await cdp.attachToTarget(targetId);

    return await cssViewportOf(cdp, sessionId, timeoutMs);
  } catch {
    return null;
  } finally {
    cdp.disconnect();
  }
}

export async function settleCaptureSize(port: number, targetId: string, size: CaptureSize, timeoutMs: number): Promise<CaptureSize> {
  if (!needsMeasuring(size)) return size;

  const viewport = await measureCssViewport(port, targetId, timeoutMs);
  if (!viewport) return size;

  return { ...size, width: size.width || viewport.width, height: size.height || viewport.height };
}

export function askedPixels(size: CaptureSize): CssViewport | null {
  if (!size.deviceScaleFactor || !size.width || !size.height) return null;

  return { width: Math.round(size.width * size.deviceScaleFactor), height: Math.round(size.height * size.deviceScaleFactor) };
}

export async function captureCdpTarget(
  port: number,
  targetId: string,
  size: CaptureSize,
  timeoutMs: number,
): Promise<CaptureOutcome> {
  const cdp = new CDPClient();
  let sessionId = "";
  let override: Record<string, unknown> | null = null;
  let answered = false;

  try {
    await cdp.connect(await CDPClient.discoverBrowserWsUrl(port));
    sessionId = await cdp.attachToTarget(targetId);

    if (size.width || size.height || size.deviceScaleFactor) {
      let { width, height } = size;

      if (!width || !height) {
        const viewport = await cssViewportOf(cdp, sessionId, timeoutMs);
        width = width || viewport?.width || 0;
        height = height || viewport?.height || 0;
      }

      override = { width, height, deviceScaleFactor: size.deviceScaleFactor ?? 0, mobile: false };
      await cdp.sendCommand("Emulation.setDeviceMetricsOverride", override, sessionId, timeoutMs);
    }

    const shot = (await cdp.sendCommand(
      "Page.captureScreenshot",
      { format: "png", fromSurface: true, captureBeyondViewport: false },
      sessionId,
      timeoutMs,
    )) as { data?: unknown } | undefined;

    answered = true;

    if (typeof shot?.data !== "string" || !shot.data) {
      return { ok: false, message: "Page.captureScreenshot answered no image data" };
    }

    return { ok: true, png: Buffer.from(shot.data, "base64") };
  } catch (error) {
    const message = errorText(error);

    return { ok: false, message, ...(/timed out/i.test(message) ? { timedOut: true } : {}) };
  } finally {
    if (override) {
      if (!answered) await cdp.sendCommand("Emulation.setDeviceMetricsOverride", override, sessionId, 2_000).catch(() => {});

      await cdp.sendCommand("Emulation.clearDeviceMetricsOverride", {}, sessionId, 2_000).catch(() => {});
    }

    cdp.disconnect();
  }
}

export async function captureRdpTab(
  port: number,
  browsingContextID: number,
  size: CaptureSize,
  timeoutMs: number,
): Promise<CaptureOutcome> {
  let session: RdpSession | null = null;

  try {
    session = await RdpSession.connect(port, timeoutMs);
    const root = await session.request("root", { type: "getRoot" }, timeoutMs);
    const actor = typeof root.screenshotActor === "string" ? root.screenshotActor : "";

    if (!actor) {
      return { ok: false, message: "this Firefox build exposes no screenshot actor on its debugger server" };
    }

    const rect =
      size.width || size.height
        ? { left: 0, top: 0, width: size.width ?? size.height, height: size.height ?? size.width }
        : undefined;
    const reply = await session.request(
      actor,
      {
        type: "capture",
        args: { browsingContextID, dpr: size.deviceScaleFactor ?? 1, snapshotScale: size.deviceScaleFactor ?? 1, ...(rect ? { rect } : {}) },
      },
      timeoutMs,
    );
    const value = (reply.value ?? {}) as { data?: unknown; messages?: Array<{ text?: unknown }> };
    const data = typeof value.data === "string" ? value.data : "";
    const comma = data.indexOf(",");

    if (!data.startsWith("data:image/png") || comma < 0) {
      const said = (value.messages ?? []).map((m) => String(m.text ?? "")).filter(Boolean).join(" ");

      return { ok: false, message: said || "the screenshot actor answered no image data" };
    }

    return { ok: true, png: Buffer.from(data.slice(comma + 1), "base64") };
  } catch (error) {
    const message = errorText(error);

    return { ok: false, message, ...(/timed out/i.test(message) ? { timedOut: true } : {}) };
  } finally {
    session?.close();
  }
}

function defaultName(context: string): string {
  return `${context}-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
}

export function screenshotsDir(projectPath: string, browser: string): string {
  return path.join(browserArtifactsDir(projectPath, browser), "screenshots");
}

export type ScreenshotPath = { ok: true; file: string } | { ok: false; message: string; hint: string };

export const SCREENSHOT_PATH_RULES =
  "path must name a .png file, or a folder with a trailing slash, inside projectPath, the system temp folder, or one of the client's MCP roots.";

function realDir(dir: string): string | null {
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return null;
  }
}

function existingAncestor(file: string): string {
  let dir = file;

  while (!fs.existsSync(dir)) {
    const up = path.dirname(dir);
    if (up === dir) return dir;

    dir = up;
  }

  return dir;
}

function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);

  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/* @invariant A SCREENSHOT LANDS IN THE PROJECT, THE TEMP FOLDER OR A CLIENT ROOT.
 * The guard exists so this tool never overwrites a file elsewhere, and the
 * project-only form of it made agents write screenshots into the working tree,
 * where they piled up untracked (ledger 400). The system temp folder and the
 * client's own MCP roots are the two places an agent already keeps scratch
 * files, so a path under either is sanctioned; anything else stays refused.
 */
export function sanctionedScreenshotRoots(projectPath: string): string[] {
  const temp = [os.tmpdir(), ...(process.platform === "win32" ? [] : ["/tmp", "/private/tmp"])];

  return [path.resolve(projectPath), ...temp, ...clientRoots()];
}

function insideSanctionedRoot(projectPath: string, resolved: string): boolean {
  const real = (() => {
    const base = existingAncestor(resolved);
    const realBase = realDir(base);

    return realBase ? path.join(realBase, path.relative(base, resolved)) : resolved;
  })();

  return sanctionedScreenshotRoots(projectPath).some((root) => {
    const literal = path.resolve(root);
    const realRoot = realDir(literal) ?? literal;

    return within(literal, resolved) || within(realRoot, real);
  });
}

export function resolveScreenshotPath(projectPath: string, browser: string, context: string, wanted?: string): ScreenshotPath {
  if (!wanted) return { ok: true, file: path.join(screenshotsDir(projectPath, browser), defaultName(context)) };

  const root = path.resolve(projectPath);
  const resolved = path.resolve(root, wanted);

  if (!insideSanctionedRoot(projectPath, resolved)) {
    return {
      ok: false,
      message: `path ${wanted} resolves to ${resolved}, which is not inside the project at ${root}, the system temp folder (${os.tmpdir()}) or a client root. ${SCREENSHOT_PATH_RULES}`,
      hint: `Pass a path relative to projectPath, such as shots/home.png or shots/, an absolute .png path under ${os.tmpdir()} or one of the client's MCP roots, or omit it to write under dist/extension-js/<browser>/screenshots.`,
    };
  }

  const isDir = /[\\/]$/.test(wanted) || (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory());
  if (isDir) return { ok: true, file: path.join(resolved, defaultName(context)) };

  if (path.extname(resolved).toLowerCase() !== ".png") {
    return {
      ok: false,
      message: `path ${wanted} does not end in .png and is not an existing folder, so this tool will not write a .png image there. ${SCREENSHOT_PATH_RULES}`,
      hint: `To write into a folder named ${wanted}, pass ${wanted.replace(/[\\/]*$/, "")}/ (trailing slash); to write a file, end its name in .png.`,
    };
  }

  return { ok: true, file: resolved };
}

export function writeScreenshot(
  projectPath: string,
  browser: string,
  context: string,
  png: Buffer,
  wanted?: string,
): ScreenshotPath {
  const target = resolveScreenshotPath(projectPath, browser, context, wanted);
  if (!target.ok) return target;

  fs.mkdirSync(path.dirname(target.file), { recursive: true });
  fs.writeFileSync(target.file, png);

  return target;
}
