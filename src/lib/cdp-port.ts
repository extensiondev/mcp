// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import http from "node:http";
import type { ReadyContract } from "./types";
import { readyContractPath } from "./session-paths";

async function resolveContractPort(
  projectPath: string,
  browser: string,
  field: "cdpPort" | "rdpPort",
  options?: { waitMs?: number; graceMs?: number },
): Promise<{ port: number | null; contractSeen: boolean }> {
  const waitMs = options?.waitMs ?? 20_000;
  const graceMs = options?.graceMs ?? 2_500;
  const readyPath = readyContractPath(projectPath, browser);

  const deadline = Date.now() + waitMs;
  let contractSeen = false;
  let contractSeenAt: number | null = null;
  for (;;) {
    try {
      const contract = JSON.parse(
        fs.readFileSync(readyPath, "utf8"),
      ) as ReadyContract & { cdpPort?: number; rdpPort?: number };
      contractSeen = true;
      if (contractSeenAt == null) contractSeenAt = Date.now();
      if (typeof contract[field] === "number") {
        return { port: contract[field] as number, contractSeen };
      }
    } catch {
      if (!contractSeen) break;
    }
    const effectiveDeadline =
      contractSeenAt != null
        ? Math.min(deadline, contractSeenAt + graceMs)
        : deadline;
    if (Date.now() >= effectiveDeadline) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return { port: null, contractSeen };
}

export async function resolveCdpPort(
  projectPath: string,
  browser: string,
  options?: { waitMs?: number; graceMs?: number },
): Promise<{ port: number; source: "contract" | "default-probe" } | null> {
  const { port, contractSeen } = await resolveContractPort(
    projectPath,
    browser,
    "cdpPort",
    options,
  );
  if (port != null) return { port, source: "contract" };
  if (!contractSeen && (await isCdpEndpoint(9222))) {
    return { port: 9222, source: "default-probe" };
  }
  return null;
}

export async function resolveRdpPort(
  projectPath: string,
  browser: string,
  options?: { waitMs?: number; graceMs?: number },
): Promise<{ port: number; source: "contract" } | null> {
  const { port } = await resolveContractPort(
    projectPath,
    browser,
    "rdpPort",
    options,
  );
  return port != null ? { port, source: "contract" } : null;
}

export const CDP_PORT_MISSING_HINT =
  "The session's ready contract has no CDP port (the browser may still be binding its debug port, or was launched without one). Confirm the session with extension_wait, give it a moment, and retry.";

export const RDP_PORT_MISSING_HINT =
  "The session's ready contract has no rdpPort. Firefox sessions publish one from extension.js 4.0.15 on; upgrade the project's extension dependency (or remove the local install so the MCP's pinned CLI drives the session) and restart the dev session.";

function isCdpEndpoint(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: "/json/version", timeout: 1_000 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}
