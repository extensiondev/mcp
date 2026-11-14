// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { amoChannelOf, type AmoChannel } from "./amo-update-url";
import { storeConfigView } from "./platform-store-records";
import { openProjectApi, projectApiGet } from "./project-api";
import { resolveProjectRef } from "./registry";

export async function platformFirefoxChannel(): Promise<AmoChannel | null> {
  try {
    const ref = resolveProjectRef();
    if (!ref) return null;

    const opened = await openProjectApi({ command: "extension_build", expect: ref });
    if (!opened.ok) return null;

    const config = await projectApiGet<Record<string, unknown>>(opened.api, "stores/config");
    if (!config.ok) return null;

    const view = storeConfigView(config.json.firefox, "firefox");

    return amoChannelOf(view?.releaseChannel ?? view?.submissionMode ?? "");
  } catch {
    return null;
  }
}
