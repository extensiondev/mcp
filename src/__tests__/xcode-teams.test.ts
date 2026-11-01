// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { describe, it, expect } from "vitest";

import { parseXcodeTeamIds } from "../lib/xcode-teams";
import { signingStatus } from "../lib/safari-signing";

const BY_IDENTIFIER = `{
    "F6F605E1-BC2F-4694-BB0B-08A4FE3229D8" =     (
                {
            isFreeProvisioningTeam = 0;
            teamID = JU3XAJJQ2G;
            teamName = "Cezar Augusto";
            teamType = Individual;
        }
    );
}`;

const LEGACY = `{
    "someone@example.com" = (
        { teamID = "62ZL6K4MM4"; teamName = "Acme"; },
        { teamID = JU3XAJJQ2G; teamName = "Cezar Augusto"; }
    );
}`;

describe("the teams Xcode is signed into", () => {
  it("reads team ids from both of Xcode's account keys, once each", () => {
    expect(parseXcodeTeamIds(BY_IDENTIFIER)).toEqual(["JU3XAJJQ2G"]);
    expect(parseXcodeTeamIds(`${LEGACY}\n${BY_IDENTIFIER}`)).toEqual(["62ZL6K4MM4", "JU3XAJJQ2G"]);
    expect(parseXcodeTeamIds("{\n}")).toEqual([]);
  });
});

describe("signing.status names what became of the requested team (ledger 347)", () => {
  it("says fell-back-to-ad-hoc only when a team was asked for and the app came out ad-hoc", () => {
    expect(signingStatus("JU3XAJJQ2G", "ad-hoc")).toBe("fell-back-to-ad-hoc");
    expect(signingStatus(null, "ad-hoc")).toBe("ad-hoc");
    expect(signingStatus("JU3XAJJQ2G", "team:JU3XAJJQ2G")).toBe("team-signed");
    expect(signingStatus("62ZL6K4MM4", "team:JU3XAJJQ2G")).toBe("other-team");
    expect(signingStatus(null, "team:JU3XAJJQ2G")).toBe("team-signed");
    expect(signingStatus("JU3XAJJQ2G", "unknown")).toBe("unknown");
  });
});
