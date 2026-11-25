// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function filesOf(dir: string, base = dir): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) return filesOf(full, base);

      return entry.isFile() ? [path.relative(base, full)] : [];
    })
    .sort();
}

export function copyBuildNumber(dir: string): number {
  const hash = crypto.createHash("sha256");

  for (const file of filesOf(dir)) {
    hash.update(file.split(path.sep).join("/"));
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(dir, file)));
    hash.update("\0");
  }

  return parseInt(hash.digest("hex").slice(0, 4), 16);
}

/* @invariant A CHANGED GUIDED COPY ALWAYS LOADS AS A NEW VERSION. Chromium
 * keeps an extension's service worker registered per version in the profile,
 * so a guided profile that once ran this version keeps running that old
 * background even after the copy on disk changed. The copy's manifest
 * version gains a fourth part read from the copy's own bytes, so different
 * bytes load as a different version and the browser registers the new
 * background, while the same bytes keep the same version.
 */
export function guidedVersion(version: unknown, build: number): string {
  const parts = String(version ?? "").split(".").filter((part) => /^\d{1,5}$/.test(part)).slice(0, 3);

  while (parts.length < 3) parts.push("0");

  return `${parts.join(".")}.${build}`;
}

export function guidedManifest(manifest: Record<string, unknown>): Record<string, unknown> {
  const hosts = (value: unknown) => (Array.isArray(value) ? value.filter((host): host is string => typeof host === "string") : []);
  const { optional_host_permissions: optional, ...rest } = manifest;

  return { ...rest, host_permissions: [...new Set([...hosts(manifest.host_permissions), ...hosts(optional)])] };
}

/* @invariant THE GUIDED BROWSER LOADS ITS OWN COPY OF EXTENSION.DEV TOOLS
 * WITH THE STORE HOSTS ALREADY GRANTED (MCP ledger 1116). That browser exists
 * only for the store connect, so the copy it loads declares the store sites
 * the store build keeps optional as host permissions, and the guide panel is
 * on the key page without a toolbar grant. The copy is made from the folder
 * that just passed its hash check, in the person's private cache, and the
 * verified folder and every store build keep their optional permissions.
 */
export function guidedCopy(verifiedDir: string, cacheDir: string, engine: string): string {
  const target = path.join(cacheDir, `guided-${engine}`);

  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(verifiedDir, target, { recursive: true });
  fs.chmodSync(target, 0o700);

  const manifestPath = path.join(target, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  fs.writeFileSync(manifestPath, `${JSON.stringify({ ...guidedManifest(manifest), version: guidedVersion(manifest.version, copyBuildNumber(verifiedDir)) }, null, 2)}\n`);

  return target;
}
