// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { resolveEngineOverride } from "./engine-override";

export type EngineRangeSource = "override" | "project" | "bundled";

export interface EngineNodeRange {
  range: string | null;
  engine: string;
  source: EngineRangeSource;
  named: string;
}

interface EnginesRead {
  version: string;
  range: string | null;
}

function readEngines(packageJson: string): EnginesRead | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJson, "utf8")) as {
      version?: unknown;
      engines?: { node?: unknown };
    };
    const node = pkg.engines?.node;
    const range = typeof node === "string" && node.trim() ? node.trim() : null;

    return { version: typeof pkg.version === "string" ? pkg.version : "unknown", range };
  } catch {
    return null;
  }
}

function bundledPackageJson(): string | null {
  try {
    return createRequire(import.meta.url).resolve("extension-develop/package.json");
  } catch {
    return null;
  }
}

export function engineNodeRange(
  projectPath?: string,
  env: NodeJS.ProcessEnv = process.env,
): EngineNodeRange | null {
  const override = resolveEngineOverride(env);

  if (override) {
    const read = override.packageDir ? readEngines(path.join(override.packageDir, "package.json")) : null;
    const engine = read?.version ?? "unknown";

    return {
      range: read?.range ?? null,
      engine,
      source: "override",
      named: `the engine override ${override.env}=${override.given} (extension ${engine})`,
    };
  }

  if (projectPath) {
    const read = readEngines(path.resolve(projectPath, "node_modules", "extension", "package.json"));

    if (read) {
      return {
        range: read.range,
        engine: read.version,
        source: "project",
        named: `the project's extension ${read.version}`,
      };
    }
  }

  const bundled = bundledPackageJson();
  const read = bundled ? readEngines(bundled) : null;
  if (!read) return null;

  return {
    range: read.range,
    engine: read.version,
    source: "bundled",
    named: `this server's bundled extension-develop ${read.version}`,
  };
}

function parts(version: string): number[] | null {
  const m = version.trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);

  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null;
}

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

export interface NodeCheck {
  check: "node";
  status: "pass" | "warn" | "fail";
  detail: string;
  remediation?: string;
  engine?: { source: EngineRangeSource; version: string; range: string | null };
}

export function nodeCheck(version: string, projectPath?: string): NodeCheck {
  const where = `Node ${version} on ${process.platform}/${process.arch}`;
  const engine = engineNodeRange(projectPath);

  if (!engine) {
    return {
      check: "node",
      status: "warn",
      detail: `${where}; no engine could be read for its Node range, so this version is unverified.`,
    };
  }

  const facts = { source: engine.source, version: engine.engine, range: engine.range };

  if (!engine.range) {
    return {
      check: "node",
      status: "warn",
      detail: `${where}; ${engine.named} declares no Node range, so this version is unverified.`,
      engine: facts,
    };
  }

  const verdict = meetsNodeRange(version, engine.range);

  if (verdict === null) {
    return {
      check: "node",
      status: "warn",
      detail: `${where}; ${engine.named} declares engines.node "${engine.range}", which this check cannot read.`,
      engine: facts,
    };
  }

  return {
    check: "node",
    status: verdict ? "pass" : "fail",
    detail: `${where}; ${engine.named} needs ${engine.range}.`,
    engine: facts,
    ...(verdict
      ? {}
      : { remediation: `The engine this server spawns, ${engine.named}, needs Node ${engine.range}; this is ${version}. Upgrade Node before running extension_dev.` }),
  };
}
