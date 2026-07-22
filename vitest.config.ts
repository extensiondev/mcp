// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));
const aliasToDist = (pkg: string) => {
  const pkgDir = join(here, "node_modules", pkg);
  const pkgJson = JSON.parse(
    readFileSync(join(pkgDir, "package.json"), "utf8"),
  );
  const root = pkgJson.exports?.["."];
  const entry =
    (typeof root === "string" ? root : root?.import) ?? pkgJson.main;
  return join(pkgDir, entry);
};

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/__tests__/setup-session-dir.ts"],
  },
  resolve: {
    alias: {
      "extension-develop": aliasToDist("extension-develop"),
      "extension-create": aliasToDist("extension-create"),
      "extension-install": aliasToDist("extension-install"),
    },
  },
});
