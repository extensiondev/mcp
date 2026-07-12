import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The extension-* runtime packages expose a `development` export condition that
// points at TS source (./module.ts) which the published package does not ship.
// Vite resolves that condition during transform and fails to find an entry.
// Alias each to its built ESM entry so resolution is unambiguous in tests.
// Since 4.x the packages are ESM-only and their exports maps hide package.json,
// so read the entry straight from node_modules instead of require.resolve.
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
  },
  resolve: {
    alias: {
      "extension-develop": aliasToDist("extension-develop"),
      "extension-create": aliasToDist("extension-create"),
      "extension-install": aliasToDist("extension-install"),
    },
  },
});
