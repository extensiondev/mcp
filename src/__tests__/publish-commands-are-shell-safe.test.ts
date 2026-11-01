// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { execFileSync } from "node:child_process";
import fs from "node:fs";

import { describe, expect, it } from "vitest";

import { runCommandsOf, runText, shellUrl } from "../lib/publish-link";
import { withPackageAddresses } from "../lib/publish-package-commands";

const PROD = "https://www.extension.dev";
const LOCAL = "http://localhost:3100";
const REF = { workspace: "acme", project: "widget" };
const SHA = "c7609a8";
const PREFIX = "npx -y extension@latest preview ";
const SHELLS = ["/bin/sh", "/bin/zsh", "/bin/bash"].filter((shell) => fs.existsSync(shell));

function firstWordAfterPrefix(shell: string, command: string): string {
  expect(command.startsWith(PREFIX)).toBe(true);
  const script = `set -- ${command.slice(PREFIX.length)}; printf '%s' "$1"`;

  return execFileSync(shell, ["-c", script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function commandsOf(api: string, previewCommands: Record<string, string>): Record<string, string> {
  const data: Record<string, unknown> = { previewCommands, shareUrl: `https://acme.extension.dev/widget?share=k3x9q` };
  withPackageAddresses(data, REF, "k3x9q", api);

  return data.previewCommands as Record<string, string>;
}

describe("every run command extension_publish prints passes its URL whole through sh and zsh (ledger 371)", () => {
  it("has a shell to run the commands in", () => {
    expect(SHELLS).toContain("/bin/sh");
  });

  it("quotes the package address the subdomain rewrite prints, so zsh does not answer no matches found", () => {
    const out = commandsOf(PROD, {
      chrome: `${PREFIX}https://acme.extension.dev/widget/builds/${SHA}/chrome.zip?share=k3x9q --browser=chrome`,
    });
    const url = `https://acme.extension.dev/widget/builds/${SHA}/chrome.zip?share=k3x9q`;

    expect(out.chrome).toBe(`${PREFIX}"${url}" --browser=chrome`);
    for (const shell of SHELLS) expect(firstWordAfterPrefix(shell, out.chrome!)).toBe(url);
  });

  it("quotes a platform command it passes through in path mode, with ? and & in the URL", () => {
    const url = `${LOCAL}/api/local-registry/acme/widget/builds/${SHA}/chrome.zip?t=abc.def&x=1`;
    const out = commandsOf(LOCAL, { chrome: `${PREFIX}${url} --browser=chrome` });

    expect(out.chrome).toBe(`${PREFIX}"${url}" --browser=chrome`);
    for (const shell of SHELLS) expect(firstWordAfterPrefix(shell, out.chrome!)).toBe(url);
  });

  it("single-quotes a URL that holds a character double quotes would expand, and reads it back whole", () => {
    const url = "https://acme.extension.dev/widget/builds/c7609a8/chrome.zip?share=a$b!c'd&e=`f`";
    const command = `${PREFIX}${shellUrl(url)} --browser=chrome`;

    expect(shellUrl(url).startsWith("'")).toBe(true);
    for (const shell of SHELLS) expect(firstWordAfterPrefix(shell, command)).toBe(url);
    expect(runCommandsOf([["chrome", command]])).toEqual([{ browser: "chrome", url }]);
  });

  it("prints the tellThem run line with the same quoting", () => {
    const url = `https://acme.extension.dev/widget/builds/${SHA}/chrome.zip?share=k3x9q`;
    const line = runText({ browser: "chrome", url }).slice(1, -1);

    for (const shell of SHELLS) expect(firstWordAfterPrefix(shell, line)).toBe(url);
  });

  it("leaves a URL with no shell character bare", () => {
    expect(shellUrl(`https://acme.extension.dev/widget/builds/${SHA}/chrome.zip`)).toBe(`https://acme.extension.dev/widget/builds/${SHA}/chrome.zip`);
  });
});
