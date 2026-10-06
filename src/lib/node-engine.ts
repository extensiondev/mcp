// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { createRequire } from "node:module";

/* @invariant THE NODE FLOOR IS THE ENGINE'S, READ FROM THE INSTALLED
   PACKAGE. The doctor used to pass any Node >= 20 while the pinned
   extension-develop declares `>=22.12`; a hardcoded
   floor goes stale the moment the engine moves. */
export function engineNodeRange(): { range: string; engine: string } | null {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("extension-develop/package.json") as {
      version?: string;
      engines?: { node?: string };
    };
    const range = pkg.engines?.node?.trim();
    return range ? { range, engine: pkg.version ?? "unknown" } : null;
  } catch {
    return null;
  }
}

function parts(version: string): number[] | null {
  const m = version.trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null;
}

/* `>=a.b.c` only, which is how the engine states its floor; anything else
   is "not understood" so the caller can say so instead of guessing. */
export function meetsNodeRange(version: string, range: string): boolean | null {
  const m = range.trim().match(/^>=\s*v?([\d.]+)$/);
  const have = parts(version);
  const need = m ? parts(m[1]) : null;
  if (!have || !need) return null;
  for (let i = 0; i < 3; i++) {
    if (have[i] > need[i]) return true;
    if (have[i] < need[i]) return false;
  }
  return true;
}

export function nodeCheck(version: string): {
  check: "node";
  status: "pass" | "warn" | "fail";
  detail: string;
  remediation?: string;
} {
  const where = `Node ${version} on ${process.platform}/${process.arch}`;
  const engine = engineNodeRange();
  if (!engine) {
    return {
      check: "node",
      status: "warn",
      detail: `${where}; the installed engine declares no Node range, so this version is unverified.`,
    };
  }
  const verdict = meetsNodeRange(version, engine.range);
  if (verdict === null) {
    return {
      check: "node",
      status: "warn",
      detail: `${where}; extension-develop ${engine.engine} declares engines.node "${engine.range}", which this check cannot read.`,
    };
  }
  return {
    check: "node",
    status: verdict ? "pass" : "fail",
    detail: `${where}; extension-develop ${engine.engine} needs ${engine.range}.`,
    ...(verdict
      ? {}
      : { remediation: `Extension.js ${engine.engine} needs Node ${engine.range}; this is ${version}. Upgrade Node before running extension_dev.` }),
  };
}
