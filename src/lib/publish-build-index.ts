// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import {
  buildIndexShapeProblem,
  fetchRegistryJson,
  isSuccessfulBuild,
  parseBuildIndex,
  registryFileUrl,
  type ProjectRef,
} from "./registry";

type Row = Record<string, unknown>;

export async function fillFromBuildIndex(data: Row, pinnedSha: string | undefined, ref: ProjectRef | null, api?: string): Promise<string | null> {
  if (!ref) return null;

  const buildsUrl = registryFileUrl(ref, "builds/index.json", api);
  const buildsRes = await fetchRegistryJson(buildsUrl, fetch, { ref, api });

  if (!buildsRes.ok) return null;

  const shape = buildIndexShapeProblem(buildsRes.json);
  if (shape) return `The project's build index at ${buildsUrl} answered but ${shape}, so buildSha, version and builtAt were not filled in from it.`;

  const items = parseBuildIndex(buildsRes.json);

  if (pinnedSha) {
    const pin = String(pinnedSha).toLowerCase();
    const pinned = items.find((item) => {
      const sha = item.sha.toLowerCase();
      const commit = String(item.commit ?? "").toLowerCase();

      return sha.startsWith(pin) || pin.startsWith(sha) || (commit !== "" && (commit.startsWith(pin) || pin.startsWith(commit)));
    });

    if (pinned) {
      if (data.buildSha == null) data.buildSha = pinned.sha;
      if (data.builtAt == null && pinned.timestamp) data.builtAt = pinned.timestamp;
      if (data.version == null && pinned.version) data.version = pinned.version;
      if (data.channel == null && pinned.channel) data.channel = pinned.channel;

      data.registryUrl = buildsUrl;

      return null;
    }

    if (data.buildSha == null) data.buildSha = pinnedSha;

    data.registryUrl = buildsUrl;

    return `buildSha ${pinnedSha} is pinned but was not found in the project's registry build index, so builtAt/version/channel are not filled in from another build. The platform accepted the pin without reading its own index (it echoes the sha when the index is unreadable), so whether a build with that sha exists was not verified here.`;
  }

  const newestSuccess = items.filter(isSuccessfulBuild).sort((a, b) => String(b.timestamp ?? "").localeCompare(String(a.timestamp ?? "")))[0];
  const platformSha = typeof data.buildSha === "string" && data.buildSha ? String(data.buildSha).toLowerCase() : null;
  const served = platformSha
    ? items.find((item) => item.sha.toLowerCase().startsWith(platformSha) || platformSha.startsWith(item.sha.toLowerCase()))
    : newestSuccess;

  if (served) {
    if (data.buildSha == null) data.buildSha = served.sha;
    if (data.builtAt == null && served.timestamp) data.builtAt = served.timestamp;
    if (data.version == null && served.version) data.version = served.version;
    if (data.channel == null && served.channel) data.channel = served.channel;

    data.registryUrl = buildsUrl;

    return platformSha
      ? `builtAt/version are read from the index row of build ${served.sha}, the build the platform says the link serves.`
      : "The platform named no build for this link; buildSha/builtAt/version describe the newest successful build in the project's registry index, which is what an unpinned link is expected to serve. Pin buildSha to serve a specific build.";
  }

  if (platformSha) {
    data.registryUrl = buildsUrl;

    return `The platform says the link serves build ${data.buildSha}, which the project's registry index does not list, so builtAt and version were not filled in from another build.`;
  }

  return null;
}
