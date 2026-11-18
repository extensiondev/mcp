// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

type Row = Record<string, unknown>;

/* @invariant
 * Firefox takes an add-on ID in the email-like form, letters, digits, ".",
 * "-" and "_" on each side of one "@", at most 80 characters
 * (https://extensionworkshop.com/documentation/develop/extensions-and-the-add-on-id/).
 */
const ID_MAX = 80;
const PLACEHOLDER_HOST = "example.com";
const HOST_MAX = 60;
const SHARED_HOSTS = ["github.com", "github.io", "gitlab.com", "gitlab.io", "bitbucket.org", "npmjs.com", "google.com", "mozilla.org", "microsoft.com", "apple.com"];

export interface ProposedGeckoId {
  id: string;
  key: string;
  why: string;
}

function slugOf(value: unknown): string {
  if (typeof value !== "string") return "";

  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join("-");
}

function ownHostOf(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";

  let url: URL;

  try {
    url = new URL(value.trim());
  } catch {
    return "";
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") return "";

  const host = url.hostname.toLowerCase().replace(/^www\./, "");

  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z][a-z0-9-]*$/.test(host) || host.length > HOST_MAX) return "";

  if (SHARED_HOSTS.some((shared) => host === shared || host.endsWith(`.${shared}`))) return "";

  return host;
}

function authorUrlOf(author: unknown): unknown {
  if (author && typeof author === "object") return (author as Row).url;

  if (typeof author !== "string") return undefined;

  const open = author.indexOf("(");
  const close = author.indexOf(")", open + 1);

  return open >= 0 && close > open ? author.slice(open + 1, close) : undefined;
}

function readPackage(folders: string[]): Row {
  for (const folder of folders) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(path.join(folder, "package.json"), "utf8"));

      if (parsed && typeof parsed === "object") return parsed as Row;
    } catch {
      continue;
    }
  }

  return {};
}

export function proposedGeckoId(manifest: Row, view: Row, manifestPath: string): ProposedGeckoId {
  const manifestDir = path.dirname(path.resolve(manifestPath));
  const projectRoot = path.basename(manifestDir) === "src" ? path.dirname(manifestDir) : manifestDir;
  const pkg = readPackage([...new Set([manifestDir, projectRoot])]);
  const manifestName = typeof view.name === "string" && !view.name.trim().startsWith("__MSG_") ? view.name : "";
  const packageName = typeof pkg.name === "string" ? pkg.name.slice(pkg.name.lastIndexOf("/") + 1) : "";
  const names: Array<[string, string]> = [
    [slugOf(manifestName), "the manifest name"],
    [slugOf(packageName), "the package name"],
    [slugOf(path.basename(projectRoot)), "the project folder's name"],
    ["extension", "a placeholder name"],
  ];
  const hosts: Array<[string, string]> = [
    [ownHostOf(view.homepage_url), "the host of the manifest's homepage_url"],
    [ownHostOf(pkg.homepage), "the host of the package homepage"],
    [ownHostOf(authorUrlOf(pkg.author)), "the host of the package author URL"],
  ];
  const [slug, nameFrom] = names.find(([value]) => value)!;
  const [host, hostFrom] = hosts.find(([value]) => value) ?? [PLACEHOLDER_HOST, `${PLACEHOLDER_HOST} because the project shows no domain of the owner's`];
  const local = slug.slice(0, ID_MAX - 1 - host.length).split("-").filter(Boolean).join("-");
  const unprefixed = Boolean(manifest.browser_specific_settings) && typeof manifest.browser_specific_settings === "object";

  return {
    id: `${local}@${host}`,
    key: `${unprefixed ? "" : "firefox:"}browser_specific_settings.gecko.id`,
    why: `${nameFrom}, at ${hostFrom}`,
  };
}

export function geckoIdWarning(proposed: ProposedGeckoId): string {
  return `Firefox: no browser_specific_settings.gecko.id. A temporary add-on without one gets a new internal ID on every launch, so storage and the moz-extension:// origin do not survive a relaunch, and a store upload needs the ID. Write it now as ${proposed.key} with the value "${proposed.id}" (${proposed.why}). It is provisional and locks at the first Firefox submission, so tell the owner you wrote it and that they can change it before then.`;
}
