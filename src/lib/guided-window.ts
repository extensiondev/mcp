// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { execFileSync } from "node:child_process";

export type WindowCheck = "visible" | "headless" | "unknown";

function processTable(): string | null {
  try {
    return execFileSync("ps", ["-axww", "-o", "args="], { encoding: "utf8", timeout: 3_000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

export function headlessFromProcesses(raw: string | null, profileDir: string): WindowCheck {
  const lines = String(raw ?? "").split("\n").filter((line) => line.includes(profileDir) && !line.includes(" preview "));
  if (!lines.length) return "unknown";

  return lines.some((line) => /(?:^|\s)--?headless(?:[=\s]|$)/.test(line)) ? "headless" : "visible";
}

/* @invariant AN ANSWER NEVER CLAIMS A WINDOW THE MACHINE DID NOT SHOW. A
 * setup outside the MCP can add --headless to every browser it starts, so
 * after a launch the browser processes of the guided profile are read back
 * from the process table for a few seconds; one started with --headless turns
 * the answer into the console page with the reason. Where the table cannot be
 * read, nothing is claimed beyond the launch.
 */
export async function windowCheck(profileDir: string): Promise<WindowCheck> {
  if (process.platform !== "darwin" && process.platform !== "linux") return "unknown";

  for (let waited = 0; waited < 10_000; waited += 500) {
    const seen = headlessFromProcesses(processTable(), profileDir);
    if (seen !== "unknown") return seen;

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return "unknown";
}

