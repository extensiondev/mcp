// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const BUNDLE_DIR = path.resolve(pkgRoot, "bundled/extension-dev-tools");
const SOURCE_REL = "apps/extensions/extension-dev-tools";
const TARGETS = [
  { browser: "chrome", folder: "chromium" },
  { browser: "firefox", folder: "firefox" },
];

async function filesUnder(root, dir = root) {
  const out = [];

  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) out.push(...(await filesUnder(root, full)));
    else if (entry.isFile()) out.push(path.relative(root, full).split(path.sep).join("/"));
  }

  return out.sort();
}

export async function treeSha256(root) {
  const whole = createHash("sha256");

  for (const rel of await filesUnder(root)) {
    const bytes = await fs.readFile(path.join(root, rel));
    whole.update(`${rel}\0${createHash("sha256").update(bytes).digest("hex")}\n`);
  }

  return whole.digest("hex");
}

async function standaloneTsconfig(dir, monorepo) {
  const file = path.join(dir, "tsconfig.json");
  const config = JSON.parse(await fs.readFile(file, "utf8"));
  const extended = String(config.extends ?? "");
  const shared = /^@extensiondev\/config\/(.+)$/.exec(extended);

  if (shared) {
    const base = JSON.parse(await fs.readFile(path.join(monorepo, "packages/config", shared[1]), "utf8"));
    delete config.extends;
    config.compilerOptions = { ...base.compilerOptions, ...config.compilerOptions };
  }

  delete config.compilerOptions?.types;
  await fs.writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
}

async function copySource(from, to) {
  await fs.cp(from, to, {
    recursive: true,
    filter: (source) => !/[\\/](node_modules|dist|\.extension-js)([\\/]|$)/.test(path.relative(from, source)),
  });

  const pkgPath = path.join(to, "package.json");
  const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
  delete pkg.devDependencies;
  await fs.writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  return pkg;
}

export function preBuildSteps(pkg) {
  return String(pkg.scripts?.build ?? "")
    .split("&&")
    .map((step) => step.trim())
    .filter((step) => step && !/\bextension@\d+\.\d+\.\d+\b/.test(step));
}

function runPreBuildSteps(source) {
  const pkg = JSON.parse(readFileSync(path.join(source, "package.json"), "utf8"));

  for (const step of preBuildSteps(pkg)) {
    const run = spawnSync(step, { cwd: source, stdio: "inherit", shell: true });

    if (run.status !== 0) throw new Error(`The build step "${step}" failed with exit ${run.status}.`);
  }
}

function engineSpec(pkg) {
  const match = /extension@(\d+\.\d+\.\d+)/.exec(String(pkg.scripts?.build ?? ""));
  if (!match) throw new Error("The tools extension's build script names no exact extension@ version.");

  return `extension@${match[1]}`;
}

async function main() {
  const monorepo = path.resolve(process.argv[2] ?? path.resolve(pkgRoot, "../.."));
  const source = path.join(monorepo, SOURCE_REL);
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "tools-extension-sync-"));

  try {
    runPreBuildSteps(source);
    const pkg = await copySource(source, scratch);
    const engine = engineSpec(pkg);
    await standaloneTsconfig(scratch, monorepo);
    const manifest = JSON.parse(await fs.readFile(path.join(scratch, "src/manifest.json"), "utf8"));
    const record = { name: "extension.dev tools", version: manifest.version, engine, sha256: {} };

    await fs.rm(BUNDLE_DIR, { recursive: true, force: true });
    await fs.mkdir(BUNDLE_DIR, { recursive: true });

    for (const target of TARGETS) {
      const run = spawnSync("npx", ["-y", engine, "build", "--browser", target.browser], {
        cwd: scratch,
        stdio: "inherit",
        env: { ...process.env, EXTENSION_HEADLESS: "1" },
      });

      if (run.status !== 0) throw new Error(`The ${target.browser} build failed with exit ${run.status}.`);

      const built = path.join(scratch, "dist", target.browser);
      const into = path.join(BUNDLE_DIR, target.folder);
      await fs.cp(built, into, { recursive: true, filter: (file) => !file.endsWith(".map") });

      const builtManifest = JSON.parse(await fs.readFile(path.join(into, "manifest.json"), "utf8"));
      if (builtManifest.version !== record.version) throw new Error(`The ${target.browser} build says ${builtManifest.version}, not ${record.version}.`);

      record.sha256[target.folder] = await treeSha256(into);
    }

    await fs.writeFile(path.join(BUNDLE_DIR, "bundle.json"), `${JSON.stringify(record, null, 2)}\n`);
    process.stderr.write(`Bundled extension.dev tools ${record.version} into ${BUNDLE_DIR}\n`);
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
