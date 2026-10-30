// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { userlandHostMode } from "@extension.dev/urls/userland";

import { mcpOrigins } from "./origins";
import { userlandProjectUrl, type ProjectRef } from "./registry";

type Row = Record<string, unknown>;

export const REGISTRY_HOST = /registry\.extension\.land/i;
export const GRANT_QUERY = /[?&](?:t|share)=/;
export const REGISTRY_TOKEN_QUERY = /[?&]t=/;

const BUILD_FILE = /\/builds\/([0-9a-f]{7,40})\/([^?#]+)/i;
const PACKAGE_EXTENSION = /\.(?:zip|xpi|crx)$/i;

export interface PackageFile {
  sha: string;
  file: string;
  browser: string;
}

export interface PackageScope {
  ref: ProjectRef | null;
  sha?: string;
  browser?: string;
  api?: string;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRow(value: unknown): value is Row {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/* @invariant THE PACKAGE ADDRESS IS COMPUTED HERE FROM WHAT THIS SERVER
 * KNOWS, NEVER COPIED FROM THE PLATFORM. On 2026-10-30 the Hands-free
 * preflight told the owner to create the Chrome Web Store item "with this
 * package" and named a 330-character registry.extension.land address with a
 * JWT in its query string, while extension_builds named the same file at a
 * registry address with no token at all. Cezar ruled that the canonical
 * package address is <workspace>.extension.dev/<project>/builds/<sha>/
 * <browser>.zip (firefox.xpi where the registry serves the signed package),
 * a member opens it by session and a tester by ?share=<short id>, and no
 * tool answer prints a registry address or a token. Every tool that prints
 * a package address builds it through this file from the workspace, the
 * project, the sha and the file, so extension_submit, extension_builds and
 * extension_publish name one string for one file. Local dev runs userland
 * on a path, where no function serves the route, so that case keeps the
 * platform's own address as it is.
 */
export function packageFileOf(url: unknown): PackageFile | null {
  const value = text(url);
  if (!value) return null;

  let pathname = value;

  try {
    pathname = new URL(value).pathname;
  } catch {
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null;

    pathname = `/${(value.split(/[?#]/)[0] ?? "").replace(/^\/+/, "")}`;
  }

  const match = BUILD_FILE.exec(pathname);
  if (!match) return null;

  const file = match[2].replace(/\/+$/, "");
  if (!file) return null;

  const name = file.split("/").pop() ?? "";

  return { sha: match[1], file, browser: name.replace(/\.[a-z0-9]+$/i, "").toLowerCase() };
}

export function packageFileName(browser: string, options: { signed?: boolean } = {}): string {
  const name = text(browser).toLowerCase() || "chrome";

  return name === "firefox" && options.signed ? "firefox.xpi" : `${name}.zip`;
}

export function packageAddressMode(apiHint?: string): "subdomain" | "path" {
  return userlandHostMode(mcpOrigins(apiHint).userland);
}

export function packageAddress(ref: ProjectRef | null, sha: string, file: string, options: { api?: string; share?: string } = {}): string {
  const path = file
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const page = text(sha) && path ? userlandProjectUrl(ref, `builds/${encodeURIComponent(text(sha))}/${path}`, options.api) : "";
  if (!page) return "";

  const share = text(options.share);

  return share ? `${page}?share=${encodeURIComponent(share)}` : page;
}

export function printedPackageAddress(answered: unknown, scope: PackageScope, options: { share?: string } = {}): string {
  const given = text(answered);
  if (packageAddressMode(scope.api) === "path") return given;

  const parsed = packageFileOf(given);
  const sha = parsed?.sha || text(scope.sha);
  const file = parsed?.file || (text(scope.browser) ? packageFileName(scope.browser ?? "") : "");

  return packageAddress(scope.ref, sha, file, { api: scope.api, share: options.share });
}

export function packagePathOf(answered: unknown): string {
  const parsed = packageFileOf(answered);

  return parsed ? `builds/${parsed.sha}/${parsed.file}` : "";
}

export function itemPackageUrl(rows: unknown[], scope: PackageScope | undefined, fallback: string): string {
  const pick = (key: string) => rows.map((row) => (isRow(row) ? text(row[key]) : "")).find(Boolean) ?? "";
  if (!scope) return pick("packageUrl") || fallback;

  return printedPackageAddress(pick("packageUrl") || pick("packageFile"), scope) || fallback;
}

export function isPackageArtifact(row: Row): boolean {
  return text(row.type) === "Extension package" || PACKAGE_EXTENSION.test(text(row.name)) || PACKAGE_EXTENSION.test(text(row.downloadUrl).split(/[?#]/)[0] ?? "");
}

export function artifactWithAddress(row: unknown, scope: PackageScope): unknown {
  if (!isRow(row) || !text(row.downloadUrl) || !isPackageArtifact(row)) return row;

  const browser = text(row.browser) || packageFileOf(row.downloadUrl)?.browser;
  const address = printedPackageAddress(row.downloadUrl, { ...scope, sha: scope.sha, browser });

  return address ? { ...row, downloadUrl: address } : row;
}

export function shareGrantOf(url: unknown): string {
  const value = text(url);
  if (!value) return "";

  try {
    return text(new URL(value).searchParams.get("share"));
  } catch {
    return "";
  }
}

export function namesRegistryOrToken(answer: string): string[] {
  const found: string[] = [];
  if (REGISTRY_HOST.test(answer)) found.push("registry.extension.land");
  if (REGISTRY_TOKEN_QUERY.test(answer)) found.push("?t=");

  return found;
}
