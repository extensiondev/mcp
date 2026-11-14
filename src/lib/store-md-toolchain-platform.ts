// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { projectApiGet, type ProjectApi } from "./project-api";
import { isRow, text } from "./row";
import { localBuildToolchain, toolchainOf, type BuiltToolchain } from "./store-md-toolchain";

type Row = Record<string, unknown>;

export async function platformBuildToolchain(api: ProjectApi, buildSha: string): Promise<BuiltToolchain | null> {
  const sha = text(buildSha).toLowerCase();
  if (!sha) return null;

  const read = await projectApiGet<Row>(api, `builds/${encodeURIComponent(sha)}`).catch(() => null);
  if (!read || !read.ok || !isRow(read.json)) return null;

  const build = isRow(read.json.build) ? read.json.build : read.json;
  const chain = toolchainOf(build.toolchain) ?? toolchainOf(read.json.toolchain);

  return chain ? { chain, from: `build ${sha} on extension.dev` } : null;
}

export async function builtToolchainFor(api: ProjectApi | null, projectPath: string, buildSha: string): Promise<BuiltToolchain | null> {
  const platform = api ? await platformBuildToolchain(api, buildSha) : null;

  return platform ?? (projectPath ? localBuildToolchain(projectPath) : null);
}
