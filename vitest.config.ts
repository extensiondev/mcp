// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));

// The engine packages sit in this package's node_modules under a strict
// linker and in a parent's under a hoisted one, so walk up for them rather
// than naming one layout. Their `exports` maps omit ./package.json, which
// rules out require.resolve.
const findPackageDir = (pkg: string) => {
  const { root } = parse(here);
  for (let dir = here; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", pkg);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dir === root) {
      throw new Error(`Cannot find ${pkg} in any node_modules above ${here}`);
    }
  }
};

const aliasToDist = (pkg: string) => {
  const pkgDir = findPackageDir(pkg);
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
