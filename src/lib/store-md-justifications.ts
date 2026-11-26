// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { stripHtmlComments } from "./html-comments";
import { isRow } from "./row";
import { stripQuotes } from "./store-md-bullets";

import type { PermissionJustification } from "./store-md-declarations";

export interface JustificationBullet {
  key: string;
  value: string;
  text: string;
}

export interface ManifestRequests {
  permissions: string[];
  hostPatterns: string[];
}

export interface JustificationLeftOut {
  line: string;
  reason: string;
}

export interface MappedJustifications {
  rows: PermissionJustification[];
  leftOut: JustificationLeftOut[];
}

const HOST_KEY = /:\/\/|^<all_urls>$|^\*/;

const PERMISSION_KEY = /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)*$/;

const NAMED_HOST = /<all_urls>|[a-z*][a-z0-9+.*-]*:\/\/[^\s`'"<>()]+/gi;

const BACKTICKED = /`([^`]+)`/g;

const KEYED = /^([\s\S]*?):(?:\s+([\s\S]*))?$/;

const PLACEHOLDER = /^(?:TODO|TBD)(?![\p{L}\p{N}])/u;

const CHROMIUM_PREFIXES = ["", "chromium:", "chrome:"];

const LABEL_LIMIT = 80;

const flat = (value: string): string =>
  value
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");

const reasonOf = (value: string): string => {
  const reason = flat(value);

  return PLACEHOLDER.test(reason) ? "" : reason;
};

const labelOf = (bullet: JustificationBullet): string => {
  const line = `- ${bullet.text.replace(/\s+/g, " ")}`;

  return line.length > LABEL_LIMIT ? `${line.slice(0, LABEL_LIMIT - 1).trimEnd()}…` : line;
};

export function justificationBullets(body: string): JustificationBullet[] {
  const out: JustificationBullet[] = [];
  let current: string[] | null = null;

  const flush = () => {
    if (current) {
      const text = current.join("\n").trim();
      const keyed = KEYED.exec(text);
      const key = keyed ? stripQuotes(keyed[1]!) : "";

      if (text) out.push(keyed && key ? { key, value: (keyed[2] ?? "").trim(), text } : { key: "", value: text, text });
    }

    current = null;
  };

  for (const line of stripHtmlComments(body).split("\n")) {
    const bullet = /^- +(.*)$/.exec(line);

    if (bullet) {
      flush();
      current = [bullet[1]!];
    } else if (/^\S/.test(line)) {
      flush();
    } else if (current) {
      current.push(line.trim());
    }
  }

  flush();

  return out;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "").map((entry) => entry.trim()) : [];
}

const isHostEntry = (entry: string): boolean => entry === "<all_urls>" || entry.includes("://");

export function manifestRequestsOf(...manifests: Array<Record<string, unknown> | null | undefined>): ManifestRequests | null {
  const read = manifests.filter(isRow);
  if (!read.length) return null;

  const entries = (key: string): string[] => read.flatMap((manifest) => CHROMIUM_PREFIXES.flatMap((prefix) => strings(manifest[`${prefix}${key}`])));
  const scripts = read.flatMap((manifest) => CHROMIUM_PREFIXES.flatMap((prefix) => (Array.isArray(manifest[`${prefix}content_scripts`]) ? (manifest[`${prefix}content_scripts`] as unknown[]).filter(isRow) : [])));
  const declared = [...entries("permissions"), ...entries("optional_permissions")];

  return {
    permissions: [...new Set(declared.filter((entry) => !isHostEntry(entry)))],
    hostPatterns: [
      ...new Set([
        ...entries("host_permissions"),
        ...entries("optional_host_permissions"),
        ...declared.filter(isHostEntry),
        ...scripts.flatMap((script) => strings(script.matches)),
      ]),
    ],
  };
}

const hostOf = (pattern: string): string => {
  const host = /^[^:]+:\/\/([^/]*)/.exec(pattern)?.[1] ?? "";

  return host.replace(/^\*\./, "").split(":")[0]!.toLowerCase();
};

const namesWord = (text: string, word: string): boolean =>
  new RegExp(`(?<![\\w.])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`).test(text);

function namedByManifest(text: string, requests: ManifestRequests): string[] {
  const lower = text.toLowerCase();
  const hosts = requests.hostPatterns.filter((pattern) => {
    if (lower.includes(pattern.toLowerCase())) return true;

    const host = hostOf(pattern);

    return Boolean(host) && host !== "*" && host.includes(".") && lower.includes(host);
  });

  return [...requests.permissions.filter((name) => namesWord(text, name)), ...hosts];
}

const withoutTrailingPunctuation = (value: string): string => {
  let end = value.length;

  while (end > 0 && ".,;:!?".includes(value[end - 1]!)) end -= 1;

  return value.slice(0, end);
};

const keyLooksRequested = (key: string): boolean => !/\s/.test(key) && (HOST_KEY.test(key) || PERMISSION_KEY.test(key));

function namedInWords(text: string): string[] {
  const hosts = [...text.matchAll(NAMED_HOST)].map((match) => withoutTrailingPunctuation(match[0]));
  const ticked = [...text.matchAll(BACKTICKED)].map((match) => match[1]!.trim()).filter(keyLooksRequested);

  return [...new Set([...hosts, ...ticked])];
}

const requestedKey = (key: string, requests: ManifestRequests): string | undefined =>
  requests.hostPatterns.find((pattern) => pattern === key) ?? requests.permissions.find((name) => name.toLowerCase() === key.toLowerCase());

export function mapJustifications(bullets: JustificationBullet[], requests: ManifestRequests | null): MappedJustifications {
  const rows: PermissionJustification[] = [];
  const leftOut: JustificationLeftOut[] = [];
  const keyed = new Set<string>();
  const pending: JustificationBullet[] = [];

  for (const bullet of bullets) {
    const own = bullet.key ? (requests ? requestedKey(bullet.key, requests) : keyLooksRequested(bullet.key) ? bullet.key : undefined) : undefined;

    if (!own) {
      pending.push(bullet);
      continue;
    }

    const reason = reasonOf(bullet.value);

    if (!reason) {
      leftOut.push({ line: labelOf(bullet), reason: `gives ${own} no reason` });
      continue;
    }

    rows.push({ permission: own, justification: reason });
    keyed.add(own.toLowerCase());
  }

  for (const bullet of pending) {
    const every = requests ? namedByManifest(bullet.text, requests) : namedInWords(bullet.text);
    const named = every.filter((name) => !keyed.has(name.toLowerCase()));
    const reason = reasonOf(bullet.text);

    if (named.length && reason) {
      for (const name of named) {
        rows.push({ permission: name, justification: reason });
        keyed.add(name.toLowerCase());
      }

      continue;
    }

    const unrequested = requests && bullet.key && keyLooksRequested(bullet.key);

    leftOut.push({
      line: labelOf(bullet),
      reason: unrequested
        ? `is keyed by ${bullet.key}, which the manifest does not request`
        : every.length
          ? `names only ${every.join(", ")}, which ${every.length > 1 ? "other bullets already justify" : "another bullet already justifies"}`
          : requests
          ? "names no permission or host the manifest requests"
          : "names no permission or host pattern",
    });
  }

  return { rows, leftOut };
}

const leftOutSentence = (row: JustificationLeftOut): string => `the permission justification bullet "${row.line}" ${row.reason}, so it was left out`;

export function justifyInto(into: { permissionJustifications?: PermissionJustification[] }, bullets: JustificationBullet[], requests: ManifestRequests | null): string[] {
  const mapped = mapJustifications(bullets, requests);

  if (mapped.rows.length) into.permissionJustifications = mapped.rows;
  else delete into.permissionJustifications;

  return mapped.leftOut.map(leftOutSentence);
}
