// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

import { clearCredentials } from "@extension.dev/core";

export const schema = {
  name: "extension_logout",
  description:
    "Delete the locally stored extension.dev credentials. Does not revoke the token server-side (revoke from the dashboard if needed); only removes it from this machine.",
  inputSchema: {
    type: "object" as const,
    properties: {},
  },
};

export async function handler(): Promise<string> {
  const result = clearCredentials();
  return JSON.stringify({
    ok: true,
    cleared: result.cleared,
    message: result.cleared
      ? "Local credentials removed."
      : "No stored credentials to remove.",
  });
}
