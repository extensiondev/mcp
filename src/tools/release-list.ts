// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

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
  userlandProjectUrl,
} from "../lib/registry";
import { UserlandProjectPage } from "@extension.dev/urls/userland";

export const schema = {
  name: "extension_release_list",
  description:
    "List the project's release channels (channel -> promoted build sha) and recent builds from the registry (registry.extension.land), so you can pick a valid buildSha for extension_release_promote, extension_deploy, or extension_publish. Read-only, no dispatch. Defaults to the logged-in project (extension_login); pass workspace + project to inspect another project. Works for PRIVATE projects too when your stored login covers them. Returns the registry URLs it read, the console Builds page URL (needs a login), and a publicUrl per channel and build on the public viewer (no login needed for a public project).",
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
      api: {
        type: "string",
        description:
          "Platform base URL (defaults to https://www.extension.dev or EXTENSION_DEV_API_URL). Used to resolve link origins and, for a private project, to mint a short-lived read token.",
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
  api?: string;
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
    fetchRegistryJson(channelsUrl, fetch, { ref, api: args.api }),
    fetchRegistryJson(metaUrl, fetch, { ref, api: args.api }),
    fetchRegistryJson(buildsUrl, fetch, { ref, api: args.api }),
  ]);

  const buildsPageUrl = consoleProjectUrl(ref, "builds", args.api);

  if (!channelsRes.ok && !metaRes.ok && !buildsRes.ok) {
    return fail(
      "ReleaseListNotFound",
      `No registry data for ${ref.workspace}/${ref.project} (${channelsUrl} returned ${
        channelsRes.status ?? "no response"
      }). The project may have no builds yet, or the workspace/project slugs may be wrong. If it is private, make sure extension_login covers this exact project (a token scoped elsewhere cannot read it). The console Builds page is the authoritative view: ${buildsPageUrl}`,
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

  // The public viewer link for every row, so the caller can hand a human a URL
  // that opens without a login. Private projects need a `?share=` token on top
  // (extension_publish mints one), which publicUrlNote states rather than
  // leaving the bare URL to imply otherwise.
  const isPrivate = String(meta?.visibility || "").toLowerCase() === "private";
  const publicProjectUrl = userlandProjectUrl(ref, "", args.api);
  const channelsWithUrls = channels.map((c) => ({
    ...c,
    publicUrl: userlandProjectUrl(
      ref,
      UserlandProjectPage.channel(c.channel),
      args.api,
    ),
  }));
  const buildsWithUrls = recentBuilds.map((b) => ({
    ...b,
    publicUrl: userlandProjectUrl(
      ref,
      UserlandProjectPage.build(b.sha),
      args.api,
    ),
  }));

  const result: Record<string, unknown> = {
    ok: true,
    workspace: ref.workspace,
    project: ref.project,
    ...(meta?.name ? { name: meta.name } : {}),
    ...(meta?.visibility ? { visibility: meta.visibility } : {}),
    channels: channelsWithUrls,
    recentBuilds: buildsWithUrls,
    registryUrl: channelsUrl,
    buildsPageUrl,
    ...(publicProjectUrl ? { publicProjectUrl } : {}),
    ...(publicProjectUrl
      ? {
          publicUrlNote: isPrivate
            ? "publicUrl links open only for workspace members. This project is private, so an outside recipient needs a share link from extension_publish."
            : "publicUrl links are the public build pages: no login needed, and they carry the per-browser downloads and the run locally instructions.",
        }
      : {}),
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
