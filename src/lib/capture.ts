// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import { CDPClient } from "./cdp";
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

export async function captureCdpTarget(
  port: number,
  targetId: string,
  size: CaptureSize,
  timeoutMs: number,
): Promise<CaptureOutcome> {
  const cdp = new CDPClient();
  let sessionId = "";
  let overridden = false;

  try {
    await cdp.connect(await CDPClient.discoverBrowserWsUrl(port));
    sessionId = await cdp.attachToTarget(targetId);

    if (size.width || size.height || size.deviceScaleFactor) {
      let { width, height } = size;

      if (!width || !height) {
        const metrics = (await cdp.sendCommand("Page.getLayoutMetrics", {}, sessionId, timeoutMs)) as
          | { cssLayoutViewport?: { clientWidth?: number; clientHeight?: number } }
          | undefined;
        width = width ?? metrics?.cssLayoutViewport?.clientWidth ?? 0;
        height = height ?? metrics?.cssLayoutViewport?.clientHeight ?? 0;
      }

      await cdp.sendCommand(
        "Emulation.setDeviceMetricsOverride",
        { width, height, deviceScaleFactor: size.deviceScaleFactor ?? 0, mobile: false },
        sessionId,
        timeoutMs,
      );

      overridden = true;
    }

    const shot = (await cdp.sendCommand(
      "Page.captureScreenshot",
      { format: "png", fromSurface: true, captureBeyondViewport: false },
      sessionId,
      timeoutMs,
    )) as { data?: unknown } | undefined;

    if (typeof shot?.data !== "string" || !shot.data) {
      return { ok: false, message: "Page.captureScreenshot answered no image data" };
    }

    return { ok: true, png: Buffer.from(shot.data, "base64") };
  } catch (error) {
    const message = errorText(error);

    return { ok: false, message, ...(/timed out/i.test(message) ? { timedOut: true } : {}) };
  } finally {
    if (overridden) {
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

export function writeScreenshot(
  projectPath: string,
  browser: string,
  context: string,
  png: Buffer,
  wanted?: string,
): string {
  let file = path.join(screenshotsDir(projectPath, browser), defaultName(context));

  if (wanted) {
    const resolved = path.resolve(projectPath, wanted);
    const isDir = /[\\/]$/.test(wanted) || (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory());
    file = isDir ? path.join(resolved, defaultName(context)) : resolved;
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, png);

  return file;
}
