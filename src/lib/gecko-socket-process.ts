// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { isGeckoFamily } from "./browser-family";
import { compareVersions, resolvedEngineFacts } from "./engine-version";

/* @invariant THE SOCKET-PROCESS WORKAROUND FOLLOWS THE ENGINE THAT RUNS THE
 * SESSION. An Extension.js engine before 4.3.0 can adopt a short-lived fork
 * of Firefox's socket process as the browser on Linux and end the real one
 * when the fork exits (ledger 987). Measured on Linux arm64 with Firefox
 * 153.7.0esr: 4.1.41 and 4.2.0 without the variable lost 55 of 100
 * sessions, 4.1.41 with it lost 1 of 50, and 4.3.0 without it lost 0 of 70.
 * So `MOZ_DISABLE_SOCKET_PROCESS=1` is handed only to an engine older than
 * 4.3.0, or to one whose version could not be read, and a 4.3.0 engine
 * keeps the socket process and with it WebRTC. A prerelease of 4.3.0 sorts
 * before 4.3.0 and is not known to carry the fix, so it counts as older.
 * `socketProcessWorkaround` is the one place that decides; a person's own
 * MOZ_DISABLE_SOCKET_PROCESS or EXTENSION_KEEP_SOCKET_PROCESS=1 still wins.
 */
export const SOCKET_PROCESS_FIX_ENGINE = "4.3.0";

export function socketProcessWorkaround(engineVersion: string | null): boolean {
  const order = engineVersion ? compareVersions(engineVersion, SOCKET_PROCESS_FIX_ENGINE) : null;

  return order === null || order < 0;
}

export function geckoLaunchEnv(
  browser: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  engineVersion: string | null = null,
): Record<string, string> | null {
  if (!isGeckoFamily(browser) || platform !== "linux") return null;
  if (env.MOZ_DISABLE_SOCKET_PROCESS !== undefined || keepsSocketProcess(env)) return null;

  return socketProcessWorkaround(engineVersion) ? { MOZ_DISABLE_SOCKET_PROCESS: "1" } : null;
}

function keepsSocketProcess(env: NodeJS.ProcessEnv | Record<string, string | undefined>): boolean {
  const raw = String(env.EXTENSION_KEEP_SOCKET_PROCESS ?? "").trim().toLowerCase();

  return raw.length > 0 && raw !== "0" && raw !== "false";
}

export function geckoSocketWarning(
  browser: string,
  noBrowser: boolean,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  engineVersion: string | null = null,
): string | null {
  if (noBrowser || !isGeckoFamily(browser) || platform !== "linux") return null;

  if (env.MOZ_DISABLE_SOCKET_PROCESS !== undefined) {
    return `MOZ_DISABLE_SOCKET_PROCESS is set in this server's environment, and Firefox reads it as set whatever its value, 0 included, so this Firefox runs without its socket process and RTCPeerConnection in this session likely connects no peers. Remove it, set EXTENSION_KEEP_SOCKET_PROCESS=1 in this server's environment, then relaunch with replace: true.`;
  }

  if (keepsSocketProcess(env) || !socketProcessWorkaround(engineVersion)) return null;

  const engine = engineVersion
    ? `the Extension.js engine that runs this session is ${engineVersion}`
    : "the version of the Extension.js engine that runs this session could not be read";

  return `This Linux Firefox runs with MOZ_DISABLE_SOCKET_PROCESS=1 because ${engine}, and an engine older than ${SOCKET_PROCESS_FIX_ENGINE} can lose the browser at startup without it. Firefox's WebRTC networking runs on the socket process, so RTCPeerConnection in this session likely connects no peers. Move the project to Extension.js ${SOCKET_PROCESS_FIX_ENGINE} or later and relaunch with replace: true to keep the socket process.`;
}

export interface GeckoSocketLaunch {
  env: Record<string, string> | null;
  warning: string | null;
}

export async function geckoSocketLaunch(browser: string, noBrowser: boolean, projectPath: string): Promise<GeckoSocketLaunch> {
  if (geckoLaunchEnv(browser) === null) return { env: null, warning: geckoSocketWarning(browser, noBrowser) };

  let engineVersion: string | null = null;

  try {
    engineVersion = (await resolvedEngineFacts(projectPath)).version;
  } catch {
  }

  return {
    env: geckoLaunchEnv(browser, process.platform, process.env, engineVersion),
    warning: geckoSocketWarning(browser, noBrowser, process.platform, process.env, engineVersion),
  };
}
