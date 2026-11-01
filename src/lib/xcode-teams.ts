// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { envelope } from "./envelope";
import { isSafariTarget } from "./safari-dev-options";

const execFileAsync = promisify(execFile);

const TEAM_KEYS = ["IDEProvisioningTeamByIdentifier", "IDEProvisioningTeams"] as const;

export function parseXcodeTeamIds(output: string): string[] {
  return [...new Set([...output.matchAll(/teamID\s*=\s*"?([A-Za-z0-9]+)"?\s*;/g)].map((match) => match[1]!))];
}

async function readDefaultsKey(key: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("defaults", ["read", "com.apple.dt.Xcode", key], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });

    return stdout;
  } catch {
    return null;
  }
}

export const xcodeTeamsReader = {
  read: async (): Promise<string[] | null> => {
    if (process.platform !== "darwin") return null;

    const answers = await Promise.all(TEAM_KEYS.map(readDefaultsKey));
    const readable = answers.filter((answer): answer is string => answer !== null);
    if (readable.length === 0) return null;

    return parseXcodeTeamIds(readable.join("\n"));
  },
};

export async function teamUnknownToXcodeRefusal(
  command: string,
  browser: string,
  developmentTeam: string | undefined,
  start: number = Date.now(),
): Promise<string | null> {
  const team = (developmentTeam ?? "").trim();
  if (!team || !isSafariTarget(browser)) return null;

  const known = await xcodeTeamsReader.read();
  if (known === null || known.includes(team)) return null;

  const knownWords = known.length > 0 ? `Xcode knows ${known.join(", ")}` : "Xcode lists no team at all";

  return envelope({
    ok: false,
    command,
    status: "team-unknown-to-xcode",
    error: {
      code: "E_TEAM_UNKNOWN_TO_XCODE",
      message:
        `developmentTeam ${team} is not a team Xcode is signed into on this Mac (${knownWords}, read from Xcode's account settings). ` +
        "xcodebuild would print \"No Account for Team\" and the app would come out ad-hoc signed, which Safari runs only while Settings > Developer > Allow unsigned extensions is on, and Safari turns that off at every quit. Nothing was started.",
    },
    value: {
      browser,
      developmentTeam: team,
      knownTeams: known,
      signing: { requested: team, status: "would-fall-back-to-ad-hoc" },
      duration: Date.now() - start,
    },
    hint:
      known.length > 0
        ? `Pass developmentTeam: "${known[0]}" (a team Xcode knows), sign in to Xcode with the Apple ID that owns team ${team} (Xcode > Settings > Accounts), or drop developmentTeam to run ad-hoc on purpose.`
        : `Sign in to Xcode with the Apple ID that owns team ${team} (Xcode > Settings > Accounts), or drop developmentTeam to run ad-hoc on purpose.`,
  });
}
