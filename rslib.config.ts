// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

import * as path from "path";
import { createRequire } from "module";
import { defineConfig } from "@rslib/core";

const require = createRequire(import.meta.url);
const shouldGenerateDts = (() => {
  try {
    require("@ast-grep/napi");
    return true;
  } catch (_error) {
    console.warn(
      "[Extension.js] Skipping d.ts generation: @ast-grep/napi failed to load.",
    );
    return false;
  }
})();

export default defineConfig({
  source: {
    entry: {
      module: path.resolve(__dirname, "./module.ts"),
    },
  },
  lib: [
    {
      format: "esm",
      syntax: "es2021",
      dts: shouldGenerateDts,
    },
  ],
});
