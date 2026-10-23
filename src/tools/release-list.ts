// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { UserlandProjectPage } from "@extension.dev/urls/userland";

import { CHANNEL_LINK_ADVICE, channelLinkFields, channelUrl } from "../lib/channel-link";
import {
  consoleProjectUrl,
  fetchRegistryJson,
  isSuccessfulBuild,
  parseBuildIndex,
  parseChannels,
  registryFileUrl,
  resolveProjectRef,
  userlandProjectUrl,
  requireShape,
  channelsShapeProblem,
  buildIndexShapeProblem,
} from "../lib/registry";
import { contradictoryRef } from "./store-status";
import { envelope, type ErrorCode } from "../lib/envelope";
import { platformHoldEnvelope } from "../lib/platform-hold";
import { readPlatformVisibility, type ProjectVisibility } from "../lib/platform-visibility";

function fail(
  name: string,
  message: string,
  status: string,
  code: ErrorCode,
  extra?: Record<string, unknown>,
): string {
  return envelope({
    ok: false,
    command: "extension_release_status",
    status,
    value: extra ?? {},
    error: { code, name, message },
  });
}

export async function readReleases(args: {
  workspace?: string;
  project?: string;
  api?: string;
}): Promise<string> {
  const ref = resolveProjectRef(args);

  if (!ref) {
    return fail(
      "ReleaseListInputError",
      contradictoryRef(args) ??
        "No project to list. Run extension_auth (action: login), which names the project, or pass workspace + project explicitly.",
      "auth-required",
      "E_AUTH_REQUIRED",
    );
  }

  const channelsUrl = registryFileUrl(ref, "channels.json", args.api);
  const metaUrl = registryFileUrl(ref, "meta.json", args.api);
  const buildsUrl = registryFileUrl(ref, "builds/index.json", args.api);

  const named = Boolean(args.workspace || args.project);
  const [channelsRaw, metaRes, buildsRaw, platform] = await Promise.all([
    fetchRegistryJson(channelsUrl, fetch, { ref, api: args.api }),
    fetchRegistryJson(metaUrl, fetch, { ref, api: args.api }),
    fetchRegistryJson(buildsUrl, fetch, { ref, api: args.api }),
    readPlatformVisibility({ ref, named, api: args.api }),
  ]);
  const channelsRes = requireShape(channelsRaw, channelsShapeProblem);
  const buildsRes = requireShape(buildsRaw, buildIndexShapeProblem);

  const buildsPageUrl = consoleProjectUrl(ref, "builds", args.api);

  const heldRead = [channelsRes, metaRes, buildsRes].find(
    (res) => !res.ok && res.held === true,
  );

  const heldPlatform = !platform.ok && !platform.skipped && platform.held ? platform : null;

  if ((heldRead && !heldRead.ok) || heldPlatform) {
    return platformHoldEnvelope({
      command: "extension_release_status",
      name: "ReleaseListHeld",
      body: heldRead && !heldRead.ok ? heldRead.body : heldPlatform?.body,
      api: args.api,
      value: { workspace: ref.workspace, project: ref.project },
    });
  }

  if (!channelsRes.ok && !metaRes.ok && !buildsRes.ok) {
    return fail(
      "ReleaseListNotFound",
      `No registry data for ${ref.workspace}/${ref.project} (${channelsRes.message}). The project may have no builds yet, or the workspace/project slugs may be wrong. If it is private, make sure extension_auth covers this exact project (a token scoped elsewhere cannot read it). The console Builds page is the authoritative record: ${buildsPageUrl}`,
      "unavailable",
      "E_PLATFORM",
      { workspace: ref.workspace, project: ref.project, registryUrl: channelsUrl, buildsPageUrl },
    );
  }

  const channels = channelsRes.ok ? parseChannels(channelsRes.json) : [];
  const recentBuilds = buildsRes.ok ? parseBuildIndex(buildsRes.json) : [];
  recentBuilds.sort((a, b) =>
    String(b.timestamp ?? "").localeCompare(String(a.timestamp ?? "")),
  );

  const meta = metaRes.ok
    ? (metaRes.json as Record<string, unknown>)
    : undefined;

  const promotable = Array.from(
    new Set(channels.map((c) => c.sha).filter(Boolean)),
  );

  const visibility = metaRes.ok ? String(meta?.visibility || "private").toLowerCase() : "unknown";
  const isPrivate = visibility !== "public";
  const publicProjectUrl = userlandProjectUrl(ref, "", args.api);
  const channelsWithUrls = channels.map((c) => {
    const url = isPrivate ? "" : channelUrl(ref, c.channel, args.api, { perBrowser: true });

    return url ? { ...c, channelUrl: url } : { ...c };
  });
  const channelWithheld = isPrivate ? channelLinkFields(ref, visibility, null, args.api) : {};
  const registryVisibility: ProjectVisibility | null = metaRes.ok ? (isPrivate ? "private" : "public") : null;
  const projectVisibility = platform.ok ? platform.visibility : registryVisibility;
  const projectVisibilitySource = platform.ok ? "platform" : registryVisibility ? "registry" : null;
  const visibilityNote = platform.ok
    ? registryVisibility && registryVisibility !== platform.visibility
      ? `The platform records this project as ${platform.visibility} while the registry's meta.json says ${registryVisibility}: projectVisibility is the platform's record, and the links above follow the registry until meta.json is republished, which saving the Visibility section in the console does.`
      : null
    : platform.skipped
      ? null
      : `The platform's visibility record could not be read (${platform.message}), so projectVisibility comes from the registry's meta.json${registryVisibility ? "" : ", which could not be read either"}.`;
  const buildsWithUrls = recentBuilds.map((b) => ({
    ...b,
    publicUrl: userlandProjectUrl(
      ref,
      UserlandProjectPage.build(b.sha),
      args.api,
    ),
  }));

  const publicUrlNote = publicProjectUrl
    ? isPrivate
      ? "publicUrl links open only for workspace members. This project is private, so an outside recipient needs a share link from extension_publish."
      : `publicUrl links are the public build pages: they open without login once the project is publicly reachable, and they carry the per-browser downloads and the run locally instructions. Each channel's channelUrl follows that channel to its current build. ${CHANNEL_LINK_ADVICE}`
    : null;
  const channelsUnavailable = channelsRes.ok
    ? null
    : `channels.json unreadable: ${channelsRes.message}`;
  const buildsUnavailable = buildsRes.ok
    ? null
    : `builds/index.json unreadable: ${buildsRes.message}`;

  return envelope({
    ok: true,
    command: "extension_release_status",
    status: "read",
    value: {
      workspace: ref.workspace,
      project: ref.project,
      ...(meta?.name ? { name: meta.name } : {}),
      ...(meta?.visibility ? { visibility: meta.visibility } : {}),
      projectVisibility,
      projectVisibilitySource,
      channels: channelsWithUrls,
      recentBuilds: buildsWithUrls,
      registryUrl: channelsUrl,
      buildsPageUrl,
      ...(publicProjectUrl ? { publicProjectUrl } : {}),
      ...channelWithheld,
    },
    hint:
      promotable.length > 0 || recentBuilds.length > 0
        ? `Promotable shas: channels currently pin ${
            promotable.length > 0 ? promotable.join(", ") : "none"
          }; recent builds add ${
            recentBuilds
              .filter(isSuccessfulBuild)
              .map((b) => b.sha)
              .join(", ") || "none"
          }. Use one of these as buildId/buildSha for promote/deploy/publish.`
        : !channelsRes.ok || !buildsRes.ok
          ? `The registry could not be read for ${ref.workspace}/${ref.project} (${[
              !channelsRes.ok ? `channels.json: ${channelsRes.message}` : null,
              !buildsRes.ok ? `builds index: ${buildsRes.message}` : null,
            ]
              .filter(Boolean)
              .join("; ")}), so whether channels or builds exist is unknown. The console Builds page is the record: ${buildsPageUrl}.`
          : `No channels or builds are recorded on the registry yet for ${ref.workspace}/${ref.project}. Push a commit to produce a build, then check ${buildsPageUrl}.`,
    warnings: [
      publicUrlNote,
      visibilityNote,
      channelsUnavailable,
      buildsUnavailable,
      metaRes.ok ? null : `meta.json could not be read (${metaRes.message}), so the project's visibility is unknown and no public page links are offered.`,
    ],
  });
}
