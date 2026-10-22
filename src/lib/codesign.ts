// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function describeCodeSignature(appPath: string): Promise<string | null> {
  if (process.platform !== "darwin") return null;

  try {
    const { stdout, stderr } = await execFileAsync("codesign", ["-dv", "--verbose=2", appPath], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });

    return `${stdout}\n${stderr}`;
  } catch {
    return null;
  }
}
