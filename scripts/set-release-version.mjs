// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const version = (process.argv[2] || "").trim();
const root = process.argv[3] || process.cwd();

if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`set-release-version: "${version}" is not a semver version`);
  process.exit(1);
}

const write = (rel, mutate) => {
  const file = path.join(root, rel);
  if (!existsSync(file)) return;

  const json = JSON.parse(readFileSync(file, "utf8"));
  mutate(json);
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
};

write("package.json", (j) => {
  j.version = version;
});

write("server.json", (j) => {
  j.version = version;
  for (const pkg of j.packages || []) pkg.version = version;
});

write(".claude-plugin/plugin.json", (j) => {
  j.version = version;
});

write(".claude-plugin/marketplace.json", (j) => {
  for (const p of j.plugins || []) p.version = version;
});

for (const rel of ["docs/tools.json", "docs/clients.json", "docs/store-md-fields.json"]) {
  write(rel, (j) => {
    if ("version" in j) j.version = version;
  });
}
