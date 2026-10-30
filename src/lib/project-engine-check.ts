// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import {
  ENGINE_DIR_ENV,
  engineOverrideRefusal,
  insideNodeModules,
  localEngineSentence,
  readLocalEngineFacts,
  readPackageVersion,
  resolveEngineOverride,
} from "./engine-override";
import { engineDrift } from "./engine-version";
import { pinnedCliVersion } from "./exec";

export interface ProjectEngineCheck {
  check: "project-engine";
  status: "pass" | "warn" | "fail";
  detail: string;
  remediation?: string;
}

export interface ProjectEngineRead {
  version: string | null;
  packageDir: string;
  realPath: string | null;
  linkedCheckout: boolean;
}

export function readProjectEngine(projectPath: string): ProjectEngineRead | null {
  const packageDir = path.resolve(projectPath, "node_modules", "extension");
  const version = readPackageVersion(packageDir);
  if (version === null) return null;

  let realPath: string | null = null;

  try {
    if (fs.lstatSync(packageDir).isSymbolicLink()) realPath = fs.realpathSync(packageDir);
  } catch {
    realPath = null;
  }

  return {
    version,
    packageDir,
    realPath,
    linkedCheckout: realPath !== null && !insideNodeModules(realPath),
  };
}

function overrideCheck(projectEngine: string | null): ProjectEngineCheck | null {
  const override = resolveEngineOverride();
  if (!override) return null;

  if (!override.bin || !override.packageDir) {
    return {
      check: "project-engine",
      status: "fail",
      detail: engineOverrideRefusal(override),
      remediation: `Point ${ENGINE_DIR_ENV} at a compiled Extension.js checkout root or at a built extension package, or unset it to run ${projectEngine ? `the project's extension@${projectEngine}` : "the MCP pin"}.`,
    };
  }

  const facts = localEngineSentence(readLocalEngineFacts(override.packageDir));
  const project = projectEngine ? `the project's extension@${projectEngine}` : "the project's engine (none installed)";

  return {
    check: "project-engine",
    status: "pass",
    detail: `engine override: ${override.given} (${facts}) is used for every spawn; ${project} and the MCP pin are bypassed`,
  };
}

function linkedCheck(engine: ProjectEngineRead): ProjectEngineCheck {
  const facts = localEngineSentence(readLocalEngineFacts(engine.realPath!));

  return {
    check: "project-engine",
    status: "pass",
    detail: `linked checkout: the project's node_modules/extension links to ${engine.realPath} (${facts}); the dev loop uses that checkout's bin, so the MCP pin extension@${pinnedCliVersion()} does not apply`,
  };
}

function pinnedCheck(projectPath: string, engineVersion: string): ProjectEngineCheck {
  const pin = pinnedCliVersion();
  const drift = pin === "" || pin === "latest" ? "same" : engineDrift(engineVersion, pin);
  const older = drift === "older" || drift === "unknown";

  return {
    check: "project-engine",
    status: older ? "warn" : "pass",
    detail: `project-local extension@${engineVersion}${drift === "newer" ? `, newer than the extension@${pin} the MCP pins; the dev loop uses the project bin, not the pin, so keep it` : older ? `, but the MCP pins extension@${pin}; the dev loop uses the project bin, not the pin` : ""}`,
    ...(older
      ? {
          remediation: `Run \`(cd ${projectPath} && npm i -D extension@${pin})\` to match the pinned engine.`,
        }
      : {}),
  };
}

export function projectEngineCheck(projectPath: string): ProjectEngineCheck | null {
  const engine = readProjectEngine(projectPath);
  const overridden = overrideCheck(engine?.version ?? null);
  if (overridden) return overridden;
  if (!engine) return null;
  if (engine.linkedCheckout) return linkedCheck(engine);

  return pinnedCheck(projectPath, engine.version!);
}
