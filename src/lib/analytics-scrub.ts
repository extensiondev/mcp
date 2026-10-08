// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

const ADDRESS_KEYS = /url|referrer/i;
const KEEP_QUERY = /^(utm_|ref$)/;
const SCRUB_ORIGIN = "https://www.extension.dev";
const REPOSITORY_REF = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+@/;
const DEPTH = 4;

export function maskRepositoryRef(value: string): string {
  if (!REPOSITORY_REF.test(value)) return value;

  return `[owner]/[repo]@${value.slice(value.indexOf("@") + 1)}`;
}

function scrubUrlProperty(value: unknown): unknown {
  if (typeof value !== "string" || !value) return value;

  let parsed: URL;

  try {
    parsed = new URL(value, SCRUB_ORIGIN);
  } catch {
    return value;
  }

  let changed = false;

  for (const key of [...parsed.searchParams.keys()]) {
    if (KEEP_QUERY.test(key)) continue;

    parsed.searchParams.delete(key);
    changed = true;
  }

  if (!changed) return value;

  return value.startsWith("/")
    ? `${parsed.pathname}${parsed.search}${parsed.hash}`
    : parsed.toString();
}

function maskDeep(value: unknown, remaining: number): unknown {
  if (typeof value === "string") return maskRepositoryRef(value);
  if (remaining <= 0 || !value || typeof value !== "object") return value;

  if (Array.isArray(value)) {
    return value.map((item) => maskDeep(item, remaining - 1));
  }

  const masked: Record<string, unknown> = {};

  for (const [key, nested] of Object.entries(
    value as Record<string, unknown>,
  )) {
    masked[key] = maskDeep(nested, remaining - 1);
  }

  return masked;
}

export type ScrubbableProperties = Record<
  string,
  string | number | boolean | null
>;

export function sanitizeMcpProperties<T extends ScrubbableProperties>(
  properties: T,
): T {
  const sanitized: Record<string, unknown> = { ...properties };

  for (const [key, value] of Object.entries(sanitized)) {
    if (!ADDRESS_KEYS.test(key)) continue;

    sanitized[key] = scrubUrlProperty(value);
  }

  for (const [key, value] of Object.entries(sanitized)) {
    sanitized[key] = maskDeep(value, DEPTH);
  }

  return sanitized as T;
}
