import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import type { ReadyContract } from "./types";

// Resolve the CDP port for a project's dev session.
//
// The ready contract is written when the extension compiles, but the browser
// launcher stamps `cdpPort` into it only after the browser binds its debug
// port (the framework explicitly preserves that post-launch write across
// recompiles). extension_wait can therefore report ready BEFORE cdpPort
// exists — observed deterministically against the real-extension corpus on
// fast-compiling samples. So: poll the contract for a stamped port instead of
// reading it once.
//
// The legacy fallback (TCP-probe 9222 and assume it is the session) was
// actively misleading on developer machines: an unrelated long-running Chrome
// can own 9222, and the tool then reported that browser's errors as the
// session's. The fallback now requires the port to actually answer CDP's
// /json/version before it is trusted.
export async function resolveCdpPort(
  projectPath: string,
  browser: string,
  options?: { waitMs?: number },
): Promise<{ port: number; source: "contract" | "default-probe" } | null> {
  // Cold browser starts (first launch on a machine, fresh profile) can take
  // well over 5s between compile-ready and the launcher's port stamp.
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
      // No ready.json at all: no session is starting, so polling would just
      // delay a truthful error. Fail fast to the probe/null path.
      if (!contractSeen) break;
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  // Only when no contract exists at all does the default-port probe make
  // sense (e.g. a manually launched browser). With a contract present but
  // portless, probing would find some OTHER browser, not this session.
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
