// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import * as path from "path";
import { createRequire } from "module";

import { defineConfig } from "@rslib/core";

import { readBuildId } from "./src/lib/build-id";

const require = createRequire(import.meta.url);
const shouldGenerateDts = (() => {
  try {
    require("@ast-grep/napi");

    return true;
  } catch {
    console.warn(
      "[Extension.js] Skipping d.ts generation: @ast-grep/napi failed to load.",
    );

    return false;
  }
})();

const distRoot = process.env.EXTENSION_MCP_DIST_ROOT || "dist";

/* @invariant THE SERVER BUNDLE IS ONE FILE. A running server reloads a
 * rebuilt dist/module.js by importing it again under a stamped specifier,
 * and Node resolves that file's own static imports without the stamp: a
 * shared chunk or runtime file beside it would come back from the loader's
 * cache as the OLD build, with its module cache keyed by the same ids. So the
 * server entry is bundled alone, with no chunk split and no runtime chunk,
 * and the hosted and clients entries are bundled apart from it.
 */
export default defineConfig({
  output: { distPath: { root: distRoot } },
  source: {
    define: {
      "process.env.EXTENSION_MCP_BUILD_ID": JSON.stringify(readBuildId(__dirname)),
    },
  },
  lib: [
    {
      id: "module",
      format: "esm",
      syntax: "es2021",
      dts: shouldGenerateDts,
      source: { entry: { module: path.resolve(__dirname, "./module.ts") } },
      tools: { rspack: { optimization: { splitChunks: false, runtimeChunk: false } } },
    },
    {
      id: "satellites",
      format: "esm",
      syntax: "es2021",
      dts: false,
      source: {
        entry: {
          clients: path.resolve(__dirname, "./src/clients/index.ts"),
          hosted: path.resolve(__dirname, "./src/hosted.ts"),
        },
      },
    },
  ],
});
