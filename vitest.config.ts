import { createRequire } from "node:module";
import { defineConfig } from "vitest/config";

// The extension-* runtime packages expose a `development` export condition that
// points at TS source (./module.ts) which the published package does not ship.
// Vite resolves that condition during transform and fails to find an entry.
// Alias each to its built CJS entry so resolution is unambiguous in tests.
const require = createRequire(import.meta.url);
const aliasToDist = (pkg: string) => require.resolve(pkg);

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
