// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SafariAutomation {
  safaridriver: string | null;
  mcp: boolean;
  bidi: boolean;
}

export const SAFARI_MCP_SETTING =
  'Safari > Settings > Developer > "Allow remote automation and external agents"';

export const SAFARI_MCP_ADD_COMMAND =
  'claude mcp add safari-mcp -- "/usr/bin/safaridriver" --mcp';

/* @invariant The reading comes from safaridriver's own usage text, never
 * from a Safari version number. Apple added `--mcp` in Safari 27 and Safari
 * Technology Preview 247, and the Preview ships its own safaridriver inside
 * the app bundle, so a version threshold would call a Preview on macOS 26
 * unsupported while its binary answers `--mcp` just fine. The usage text is
 * the one source that cannot disagree with the binary that prints it.
 */
export function parseSafariDriverHelp(helpText: string): {
  mcp: boolean;
  bidi: boolean;
} {
  const flags = new Set(
    Array.from(helpText.matchAll(/(?:^|\s)--([a-z][a-z-]*)/g)).map(
      (m) => m[1],
    ),
  );
  return { mcp: flags.has("mcp"), bidi: flags.has("bidi") };
}

export function safariDriverCandidates(safariBinary: string | null): string[] {
  const candidates: string[] = [];
  if (safariBinary) {
    candidates.push(path.join(path.dirname(safariBinary), "safaridriver"));
  }
  candidates.push("/usr/bin/safaridriver");
  return Array.from(new Set(candidates));
}

export async function readSafariDriverHelp(
  driverPath: string,
): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(driverPath, ["--help"], {
      timeout: 5000,
      env: { ...process.env },
    });
    return `${stdout}\n${stderr}`;
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string };
    const text = `${failed.stdout ?? ""}\n${failed.stderr ?? ""}`.trim();
    return text.length > 0 ? text : null;
  }
}

export async function detectSafariAutomation(
  safariBinary: string | null,
): Promise<SafariAutomation> {
  if (process.platform !== "darwin") {
    return { safaridriver: null, mcp: false, bidi: false };
  }

  for (const candidate of safariDriverCandidates(safariBinary)) {
    if (!fs.existsSync(candidate)) continue;
    const help = await readSafariDriverHelp(candidate);
    if (help === null) continue;
    return { safaridriver: candidate, ...parseSafariDriverHelp(help) };
  }

  return { safaridriver: null, mcp: false, bidi: false };
}

export async function readSafariVersion(
  safariBinary: string,
): Promise<string | null> {
  const plist = path.resolve(safariBinary, "..", "..", "Info.plist");
  if (!fs.existsSync(plist)) return null;
  try {
    const { stdout } = await execFileAsync(
      "/usr/bin/defaults",
      ["read", plist, "CFBundleShortVersionString"],
      { timeout: 5000 },
    );
    const version = stdout.trim();
    return /^\d+(\.\d+)*$/.test(version) ? version : null;
  } catch {
    return null;
  }
}

export function safariAutomationHint(automation: SafariAutomation): string {
  if (automation.mcp) {
    return (
      `Safari ships Apple's Safari MCP server (${automation.safaridriver} --mcp). ` +
      `Enable ${SAFARI_MCP_SETTING}, then add it beside this server: ${SAFARI_MCP_ADD_COMMAND}. ` +
      "It drives an isolated automation window with page-level tools (tabs, console, network, screenshots, evaluate); it has no extension-aware tool, so use it to read a page your content script touches, not the popup or background."
    );
  }
  if (automation.safaridriver) {
    return (
      `This safaridriver (${automation.safaridriver}) has no --mcp flag: Apple's Safari MCP server needs Safari 27 or Safari Technology Preview 247+. ` +
      "Until then a Safari session is build, open and enable only, with no console or DOM reading from this server."
    );
  }
  return "No safaridriver found beside Safari, so no automation reading is possible for it from this machine.";
}
