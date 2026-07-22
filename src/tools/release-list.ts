// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

// The discovery sibling of extension_release_promote / extension_deploy /
// extension_publish: those verbs demand a build sha, and this is the verb
// that lists the valid ones. Reads the project's public state on
// registry.extension.land (channels.json + builds/index.json + meta.json),
// which needs no auth for public projects.

import {
  consoleProjectUrl,
  fetchRegistryJson,
  parseBuildIndex,
  parseChannels,
  registryFileUrl,
  resolveProjectRef,
} from "../lib/registry";

export const schema = {
  name: "extension_release_list",
  description:
    "List the project's release channels (channel -> promoted build sha) and recent builds from the public registry (registry.extension.land), so you can pick a valid buildSha for extension_release_promote, extension_deploy, or extension_publish. Read-only, no dispatch. Defaults to the logged-in project (extension_login); pass workspace + project to inspect another public project. Also returns the registry URLs it read and the console Builds page URL.",
  inputSchema: {
    type: "object" as const,
    properties: {
      workspace: {
        type: "string",
        description:
          "Workspace slug override (defaults to the stored login's workspace).",
      },
      project: {
        type: "string",
        description:
          "Project slug override (defaults to the stored login's project).",
      },
    },
    required: [],
  },
};

function fail(name: string, message: string, extra?: Record<string, unknown>): string {
  return JSON.stringify({ ok: false, error: { name, message }, ...(extra ?? {}) });
}

export async function handler(args: {
  workspace?: string;
  project?: string;
}): Promise<string> {
  const ref = resolveProjectRef(args);
  if (!ref) {
    return fail(
      "ReleaseListInputError",
      "No project to list. Run extension_login (the stored login names the project), or pass workspace + project explicitly.",
    );
  }

  const channelsUrl = registryFileUrl(ref, "channels.json");
  const metaUrl = registryFileUrl(ref, "meta.json");
  const buildsUrl = registryFileUrl(ref, "builds/index.json");

  const [channelsRes, metaRes, buildsRes] = await Promise.all([
    fetchRegistryJson(channelsUrl),
    fetchRegistryJson(metaUrl),
    fetchRegistryJson(buildsUrl),
  ]);

  const buildsPageUrl = consoleProjectUrl(ref, "builds");

  if (!channelsRes.ok && !metaRes.ok && !buildsRes.ok) {
    return fail(
      "ReleaseListNotFound",
      `No registry data for ${ref.workspace}/${ref.project} (${channelsUrl} returned ${
        channelsRes.status ?? "no response"
      }). The project may have no builds yet, be private (private registry data needs a share token), or the workspace/project slugs may be wrong. The console Builds page is the authoritative view: ${buildsPageUrl}`,
      { workspace: ref.workspace, project: ref.project, registryUrl: channelsUrl, buildsPageUrl },
    );
  }

  const channels = channelsRes.ok ? parseChannels(channelsRes.json) : [];
  const recentBuilds = buildsRes.ok ? parseBuildIndex(buildsRes.json) : [];
  // Newest first; the index is small (the registry writer caps it).
  recentBuilds.sort((a, b) =>
    String(b.timestamp ?? "").localeCompare(String(a.timestamp ?? "")),
  );

  const meta = metaRes.ok
    ? (metaRes.json as Record<string, unknown>)
    : undefined;

  const promotable = Array.from(
    new Set(channels.map((c) => c.sha).filter(Boolean)),
  );

  const result: Record<string, unknown> = {
    ok: true,
    workspace: ref.workspace,
    project: ref.project,
    ...(meta?.name ? { name: meta.name } : {}),
    ...(meta?.visibility ? { visibility: meta.visibility } : {}),
    channels,
    recentBuilds,
    registryUrl: channelsUrl,
    buildsPageUrl,
    message:
      promotable.length > 0 || recentBuilds.length > 0
        ? `Promotable shas: channels currently pin ${
            promotable.length > 0 ? promotable.join(", ") : "none"
          }; recent builds add ${
            recentBuilds
              .filter((b) => b.status === "success")
              .map((b) => b.sha)
              .join(", ") || "none"
          }. Use one of these as buildId/buildSha for promote/deploy/publish.`
        : `No channels or builds are recorded on the registry yet for ${ref.workspace}/${ref.project}. Push a commit to produce a build, then check ${buildsPageUrl}.`,
  };
  if (!channelsRes.ok) {
    result.channelsUnavailable = `channels.json unreadable: ${channelsRes.message}`;
  }
  if (!buildsRes.ok) {
    result.buildsUnavailable = `builds/index.json unreadable: ${buildsRes.message}`;
  }
  return JSON.stringify(result);
}
