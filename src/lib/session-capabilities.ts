// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { CDPClient } from "./cdp";
import { resolveCdpPort } from "./cdp-port";
import { isChromiumFamily, isGeckoFamily } from "./browser-family";
import { resolveExtensionId } from "../tools/open";

export type ContextKind =
  | "service-worker"
  | "extension-page"
  | "offscreen-document"
  | "extension-frame"
  | "worker"
  | "shared-worker"
  | "other";

export interface GpuReading {
  adapter: boolean;
  reason?: string;
  vendor?: string | null;
  architecture?: string | null;
  device?: string | null;
  description?: string | null;
  features?: string[];
  limits?: { maxBufferSize: number | null; maxComputeWorkgroupSizeX: number | null };
  isFallbackAdapter?: boolean | null;
}

export interface ContextCapabilities {
  targetId: string;
  kind: ContextKind;
  url: string;
  gpu?: GpuReading;
  crossOriginIsolated?: boolean;
  hardwareConcurrency?: number | null;
  videoDecoder?: boolean;
  error?: string;
}

export interface SessionCapabilities {
  extensionId: string;
  headless: boolean | null;
  browser: string | null;
  contexts: ContextCapabilities[];
}

export type CapabilitiesRead =
  | { capabilities: SessionCapabilities; reason?: undefined }
  | { capabilities: null; reason: string };

export const CAPABILITIES_PROBE = `(async () => {
  const g = globalThis;
  const isWorker = typeof WorkerGlobalScope !== "undefined" && g instanceof WorkerGlobalScope;
  const kind = isWorker
    ? (typeof ServiceWorkerGlobalScope !== "undefined" && g instanceof ServiceWorkerGlobalScope
        ? "service-worker"
        : typeof SharedWorkerGlobalScope !== "undefined" && g instanceof SharedWorkerGlobalScope
          ? "shared-worker"
          : "worker")
    : g.top !== g
      ? "extension-frame"
      : typeof chrome !== "undefined" && chrome.runtime && !chrome.tabs
        ? "offscreen-document"
        : "extension-page";
  const out = {
    kind,
    crossOriginIsolated: g.crossOriginIsolated === true,
    hardwareConcurrency: typeof navigator.hardwareConcurrency === "number" ? navigator.hardwareConcurrency : null,
    videoDecoder: typeof VideoDecoder !== "undefined",
    gpu: { adapter: false, reason: "navigator.gpu is undefined in this context" },
  };
  if (!navigator.gpu) return out;
  let adapter = null;
  try {
    adapter = await navigator.gpu.requestAdapter();
  } catch (e) {
    out.gpu = { adapter: false, reason: "requestAdapter() threw: " + String(e && e.message || e) };
    return out;
  }
  if (!adapter) {
    out.gpu = { adapter: false, reason: "requestAdapter() answered null, so this context has no WebGPU adapter" };
    return out;
  }
  let info = adapter.info || null;
  if (!info && typeof adapter.requestAdapterInfo === "function") {
    try { info = await adapter.requestAdapterInfo(); } catch {}
  }
  const text = (v) => (typeof v === "string" ? v : null);
  const num = (v) => (typeof v === "number" ? v : null);
  out.gpu = {
    adapter: true,
    vendor: text(info && info.vendor),
    architecture: text(info && info.architecture),
    device: text(info && info.device),
    description: text(info && info.description),
    features: Array.from(adapter.features || []).map(String).sort(),
    limits: {
      maxBufferSize: num(adapter.limits && adapter.limits.maxBufferSize),
      maxComputeWorkgroupSizeX: num(adapter.limits && adapter.limits.maxComputeWorkgroupSizeX),
    },
    isFallbackAdapter:
      typeof (info && info.isFallbackAdapter) === "boolean"
        ? info.isFallbackAdapter
        : typeof adapter.isFallbackAdapter === "boolean"
          ? adapter.isFallbackAdapter
          : null,
  };
  return out;
})()`;

const KINDS = new Set<string>([
  "service-worker",
  "extension-page",
  "offscreen-document",
  "extension-frame",
  "worker",
  "shared-worker",
  "other",
]);

interface TargetRow {
  targetId: string;
  type: string;
  url: string;
}

function kindFromTargetType(type: string): ContextKind {
  switch (type) {
    case "service_worker":
      return "service-worker";
    case "worker":
      return "worker";
    case "shared_worker":
      return "shared-worker";
    case "iframe":
      return "extension-frame";
    case "page":
    case "background_page":
      return "extension-page";
    default:
      return "other";
  }
}

function extensionTargets(raw: Array<Record<string, unknown>>, extensionId: string): TargetRow[] {
  const prefix = `chrome-extension://${extensionId}/`;
  const rows: TargetRow[] = [];

  for (const t of raw) {
    const url = String(t.url ?? "");
    const targetId = String(t.targetId ?? t.id ?? "");
    if (!targetId || !url.startsWith(prefix)) continue;

    rows.push({ targetId, type: String(t.type ?? ""), url });
  }

  return rows;
}

function headlessReading(browser: string | null, userAgent: string | null): boolean | null {
  if (browser === null && userAgent === null) return null;

  return /HeadlessChrome/i.test(browser ?? "") || /HeadlessChrome/i.test(userAgent ?? "");
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function withinMs<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cap = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms} ms`)), ms);
  });

  try {
    return await Promise.race([work, cap]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function probeTarget(
  cdp: CDPClient,
  target: TargetRow,
  timeoutMs: number,
): Promise<ContextCapabilities> {
  const base: ContextCapabilities = {
    targetId: target.targetId,
    kind: kindFromTargetType(target.type),
    url: target.url,
  };

  try {
    const read = await withinMs(
      (async () => {
        const sessionId = await cdp.attachToTarget(target.targetId);

        return cdp.evaluateAwaited(sessionId, CAPABILITIES_PROBE, timeoutMs);
      })(),
      timeoutMs,
      `the capabilities probe of ${target.url}`,
    );

    if (!read || typeof read !== "object") {
      return { ...base, error: "the probe answered nothing readable" };
    }

    const answer = read as Record<string, unknown>;
    const kind = typeof answer.kind === "string" && KINDS.has(answer.kind) ? (answer.kind as ContextKind) : base.kind;

    return {
      ...base,
      kind,
      gpu: (answer.gpu as GpuReading | undefined) ?? { adapter: false, reason: "the probe answered no gpu reading" },
      crossOriginIsolated: answer.crossOriginIsolated === true,
      hardwareConcurrency: typeof answer.hardwareConcurrency === "number" ? answer.hardwareConcurrency : null,
      videoDecoder: answer.videoDecoder === true,
    };
  } catch (e) {
    return { ...base, error: describeError(e) };
  }
}

export async function readCapabilitiesOverCdp(
  port: number,
  extensionId: string,
  options?: { targetTimeoutMs?: number },
): Promise<CapabilitiesRead> {
  const timeoutMs = options?.targetTimeoutMs ?? 2_000;
  const [browser, userAgent] = await Promise.all([
    CDPClient.discoverBrowserVersion(port),
    CDPClient.discoverUserAgent(port),
  ]);
  const cdp = new CDPClient();

  try {
    await cdp.connect(await CDPClient.discoverBrowserWsUrl(port));
    const targets = extensionTargets(await cdp.getTargets(), extensionId);

    if (targets.length === 0) {
      return {
        capabilities: null,
        reason: `The browser lists no target under chrome-extension://${extensionId}/, so there is no context to read.`,
      };
    }

    const contexts = await Promise.all(targets.map((target) => probeTarget(cdp, target, timeoutMs)));

    return {
      capabilities: {
        extensionId,
        headless: headlessReading(browser, userAgent),
        browser,
        contexts,
      },
    };
  } catch (e) {
    return {
      capabilities: null,
      reason: `The session's debug port did not answer the capabilities read: ${describeError(e)}.`,
    };
  } finally {
    try {
      cdp.disconnect();
    } catch {
    }
  }
}

export async function readSessionCapabilities(
  projectPath: string,
  browser: string,
  options?: { targetTimeoutMs?: number },
): Promise<CapabilitiesRead> {
  if (!isChromiumFamily(browser)) {
    const family = isGeckoFamily(browser) ? "Firefox" : "Safari";

    return {
      capabilities: null,
      reason: `${family} sessions have no Chromium debug port, so the WebGPU adapter, cross-origin isolation and headless mode of each context are not readable here.`,
    };
  }

  try {
    const resolved = await resolveCdpPort(projectPath, browser, { waitMs: 0 });

    if (!resolved) {
      return {
        capabilities: null,
        reason: "The session's ready contract has no CDP port, so no context of the extension can be asked for its capabilities.",
      };
    }

    const extensionId = await resolveExtensionId(projectPath, browser);

    if (!extensionId) {
      return {
        capabilities: null,
        reason: "The extension's id could not be resolved from the session, so its contexts cannot be told apart from the browser's other targets.",
      };
    }

    return await readCapabilitiesOverCdp(resolved.port, extensionId, options);
  } catch (e) {
    return {
      capabilities: null,
      reason: `The capabilities read failed before reaching the browser: ${describeError(e)}.`,
    };
  }
}
