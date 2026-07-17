import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import type { ReadyContract } from "./types";

export async function resolveCdpPort(
  projectPath: string,
  browser: string,
  options?: { waitMs?: number },
): Promise<{ port: number; source: "contract" | "default-probe" } | null> {
  const waitMs = options?.waitMs ?? 20_000;
  const readyPath = path.resolve(
    projectPath,
    "dist",
    "extension-js",
    browser,
    "ready.json",
  );

  const deadline = Date.now() + waitMs;
  let contractSeen = false;
  for (;;) {
    try {
      const contract = JSON.parse(
        fs.readFileSync(readyPath, "utf8"),
      ) as ReadyContract & { cdpPort?: number };
      contractSeen = true;
      if (typeof contract.cdpPort === "number") {
        return { port: contract.cdpPort, source: "contract" };
      }
    } catch {
      if (!contractSeen) break;
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (!contractSeen && (await isCdpEndpoint(9222))) {
    return { port: 9222, source: "default-probe" };
  }
  return null;
}

export const CDP_PORT_MISSING_HINT =
  "The session's ready contract has no CDP port (the browser may still be binding its debug port, or was launched without one). Confirm the session with extension_wait, give it a moment, and retry.";

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
