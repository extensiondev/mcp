import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));

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

const aliasToDist = (pkg: string, subpath = ".") => {
  const pkgDir = findPackageDir(pkg);
  const pkgJson = JSON.parse(
    readFileSync(join(pkgDir, "package.json"), "utf8"),
  );
  const target = pkgJson.exports?.[subpath];
  const entry =
    (typeof target === "string" ? target : target?.import) ??
    (subpath === "." ? pkgJson.main : undefined);

  if (!entry) {
    throw new Error(`${pkg} does not export "${subpath}"`);
  }

  return join(pkgDir, entry);
};

/* @invariant An exact-match RegExp, not a bare string key. Vite's string
   aliases are PREFIX replacements, so a plain "extension-develop" entry also
   swallows "extension-develop/bridge" and rewrites it to
   <pkg>/dist/module.mjs/bridge, which resolves to nothing. Anchoring each
   specifier keeps the subpath export reachable. */
const exact = (specifier: string) =>
  new RegExp(`^${specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/__tests__/setup-session-dir.ts"],
    /* @invariant Windows reads its process table through a PowerShell CIM
       query, and a cold PowerShell on a busy runner can
       take several seconds by itself, so a cell that stops a session ran past
       the 5 s default there (carrier-not-shipped, 2026-10-06). The longer
       budget is Windows only; every other host keeps the default. */
    testTimeout: process.platform === "win32" ? 30_000 : 5_000,
  },
  resolve: {
    alias: [
      {
        find: exact("extension-develop/bridge"),
        replacement: aliasToDist("extension-develop", "./bridge"),
      },
      {
        find: exact("extension-develop"),
        replacement: aliasToDist("extension-develop"),
      },
      {
        find: exact("extension-create"),
        replacement: aliasToDist("extension-create"),
      },
      {
        find: exact("extension-install"),
        replacement: aliasToDist("extension-install"),
      },
    ],
  },
});
